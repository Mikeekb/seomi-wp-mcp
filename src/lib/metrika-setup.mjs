/**
 * Shared Yandex Metrika setup orchestration, reused by `init`, `update`, and
 * `doctor --fix` so none of them duplicate the credentials → install → register
 * flow.
 *
 * Split into three pieces:
 *   - `detectMetrikaState(cwd)`   — non-interactive probe (used by update/doctor)
 *   - `askMetrikaCredentials()`   — interactive prompts (used by init/update)
 *   - `setupMetrika(cwd, opts)`   — the actual work: write .env, install the
 *                                   Python server + venv, register .mcp.json
 *
 * Secrets never touch `.mcp.json` (committed to git): the token lives only in
 * `.claude/.env`, which the server reads at runtime.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { confirm, input, password, select } from '@inquirer/prompts';
import { logger } from './logger.mjs';
import { mergeEnv } from './env-writer.mjs';
import { addServerEntry, buildMetrikaMcpConfig, readMcpJson } from './claude-mcp.mjs';
import { installMetrikaMcp, venvPythonPath, CLIENT_SERVER_REL } from './metrika-mcp-installer.mjs';

/** MCP server name used in the client's `.mcp.json`. */
export const METRIKA_MCP_SERVER = 'yandex-metrika';

/**
 * Build the Yandex OAuth implicit-flow ("token") authorize URL for a Client ID.
 *
 * The Metrika cabinet only exposes Client ID / Client Secret — not a ready-made
 * OAuth token. This URL lets the user grab an `access_token` straight from the
 * browser redirect fragment (`#access_token=y0_…`) with no server round-trip.
 *
 * @param {string} clientId
 * @returns {string}
 */
export function metrikaAuthorizeUrl( clientId ) {
	const id = String( clientId ?? '' ).trim();
	return `https://oauth.yandex.ru/authorize?response_type=token&client_id=${ encodeURIComponent( id ) }`;
}

/**
 * Best-effort open a URL in the user's default browser. Never throws: a failed
 * launch just means the user copies the printed URL by hand.
 *
 * @param {string} url
 * @returns {boolean} whether a launcher was spawned
 */
function openInBrowser( url ) {
	try {
		const [ cmd, args ] =
			process.platform === 'win32' ? [ 'cmd', [ '/c', 'start', '', url ] ]
			: process.platform === 'darwin' ? [ 'open', [ url ] ]
			: [ 'xdg-open', [ url ] ];
		const child = spawn( cmd, args, { stdio: 'ignore', detached: true, windowsHide: true } );
		child.on( 'error', ( err ) => logger.debug( `[FIX] metrika-setup: browser open failed: ${ err.message }` ) );
		child.unref();
		logger.debug( `[FIX] metrika-setup: spawned browser opener via ${ cmd }` );
		return true;
	} catch ( err ) {
		logger.debug( `[FIX] metrika-setup: browser open threw: ${ err.message }` );
		return false;
	}
}

/**
 * Interactively walk the user through the browser implicit-flow that turns a
 * Client ID into an OAuth token. Prints the authorize URL, offers to open it,
 * and explains where the token appears. Returns nothing — the caller's
 * `password` prompt collects the pasted token afterwards.
 *
 * Prompts + browser opener are injectable for tests (mirrors the `_internals`
 * seam used elsewhere in this codebase).
 *
 * @param {object} [io]
 * @param {(url: string) => boolean} [io.open]
 * @param {typeof input} [io.promptInput]
 * @param {typeof confirm} [io.promptConfirm]
 */
async function guideOAuthToken( { open = openInBrowser, promptInput = input, promptConfirm = confirm } = {} ) {
	logger.debug( '[FIX] metrika-setup: user requested OAuth token help' );
	logger.info( 'The Metrica cabinet only shows Client ID / Client Secret — the OAuth token is' );
	logger.info( 'obtained separately via the browser "implicit" flow (no server needed).' );
	logger.info( 'Open/register an app at https://oauth.yandex.ru/ with scope metrika:read' );
	logger.info( '(add metrika:write to edit goals/segments), then copy its Client ID.' );

	const clientId = await promptInput( {
		message: 'App Client ID (from https://oauth.yandex.ru/):',
		validate: ( v ) => !! v.trim() || 'Required',
	} );

	const url = metrikaAuthorizeUrl( clientId );
	logger.debug( '[FIX] metrika-setup: built authorize url from client id' );
	logger.step( 'Authorize URL' );
	process.stdout.write( '\n  ' + url + '\n\n' );
	logger.info( 'After you approve access, Yandex redirects to a URL whose fragment holds the' );
	logger.info( 'token: #access_token=y0_XXXX… — copy that y0_… value and paste it below.' );

	const doOpen = await promptConfirm( {
		message: 'Open this URL in your browser now?',
		default: true,
	} );
	if ( doOpen ) {
		if ( open( url ) ) {
			logger.success( 'Opened in your default browser.' );
		} else {
			logger.warn( 'Could not open a browser automatically — copy the URL above manually.' );
		}
	}
}

/**
 * Probe how much of the Metrika integration is already present in a project.
 *
 * @param {string} cwd
 * @returns {Promise<{ hasEnv: boolean, hasVenv: boolean, hasMcp: boolean, configured: boolean }>}
 *   `configured` is true only when all three are in place.
 */
export async function detectMetrikaState( cwd ) {
	// 1. Credentials in .claude/.env (key present AND non-empty value).
	let hasEnv = false;
	const envPath = join( cwd, '.claude', '.env' );
	if ( existsSync( envPath ) ) {
		const text = await readFile( envPath, 'utf8' ).catch( () => '' );
		const token = /^METRIKA_OAUTH_TOKEN=(.+)$/m.exec( text );
		const counter = /^METRIKA_COUNTER_ID=(.+)$/m.exec( text );
		hasEnv = !! ( token && token[ 1 ].trim() && counter && counter[ 1 ].trim() );
	}

	// 2. Built venv on disk.
	const hasVenv = existsSync( venvPythonPath( join( cwd, CLIENT_SERVER_REL ) ) );

	// 3. Registered MCP server entry.
	let hasMcp = false;
	try {
		const data = await readMcpJson( cwd );
		hasMcp = !! ( data.mcpServers && data.mcpServers[ METRIKA_MCP_SERVER ] );
	} catch {
		hasMcp = false;
	}

	const configured = hasEnv && hasVenv && hasMcp;
	logger.debug( `metrika-setup: state hasEnv=${ hasEnv } hasVenv=${ hasVenv } hasMcp=${ hasMcp } configured=${ configured }` );
	return { hasEnv, hasVenv, hasMcp, configured };
}

/**
 * Interactively collect Metrika credentials. Returns `{ enabled: false }` when
 * the user declines, otherwise `{ enabled: true, env: { METRIKA_* } }`.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.assumeYes=false] - skip the leading confirm (used when
 *   the caller already decided to set up Metrika, e.g. `--metrika`).
 */
export async function askMetrikaCredentials( { assumeYes = false } = {} ) {
	if ( ! assumeYes ) {
		const want = await confirm( {
			message: 'Set up Yandex Metrica integration (goals, analytics, saved reports, audience segments)?',
			default: false,
		} );
		if ( ! want ) {
			logger.debug( 'metrika-setup: user declined Metrika setup' );
			return { enabled: false };
		}
	}

	logger.step( 'Yandex Metrica credentials' );

	// The cabinet only exposes Client ID / Client Secret, so many users arrive
	// here without a token. Offer to walk them through the browser implicit-flow
	// that turns a Client ID into the access_token this prompt expects.
	const tokenSource = await select( {
		message: 'Yandex OAuth token — do you already have one?',
		default: 'have',
		choices: [
			{ name: 'Yes, I have an OAuth token to paste', value: 'have' },
			{ name: 'No — help me get one from a Client ID (opens browser)', value: 'help' },
		],
	} );
	if ( tokenSource === 'help' ) {
		await guideOAuthToken();
	}

	const token = await password( {
		message: 'Metrica OAuth token (paste the y0_… value; needs metrika:write for goals/segments):',
		mask: '*',
	} );
	const counterId = await input( {
		message: 'Metrica counter id(s), comma-separated for multiple (e.g. 43286099,46188792):',
		validate: ( v ) => !! v.trim() || 'Required',
	} );

	return {
		enabled: true,
		env: {
			METRIKA_OAUTH_TOKEN: token,
			METRIKA_COUNTER_ID: counterId.trim(),
		},
	};
}

/**
 * Write credentials, install the Python MCP server, and register it in
 * `.mcp.json`. Idempotent and best-effort: a `python-missing` install is not
 * fatal (the caller surfaces a warning; `doctor --fix` finishes later).
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {object} [opts.env] - `{ METRIKA_OAUTH_TOKEN?, METRIKA_COUNTER_ID? }`
 *   to merge into `.claude/.env`. Omit to leave existing creds untouched.
 * @param {object} [opts._internals] - passed through to `installMetrikaMcp`.
 * @returns {Promise<{ envRes: object|null, installRes: object, mcpRes: object|null }>}
 */
export async function setupMetrika( cwd, { env = {}, _internals = {} } = {} ) {
	// 1. Persist only the Metrika keys, preserving the rest of .claude/.env.
	const metrikaEnv = {};
	if ( env.METRIKA_OAUTH_TOKEN !== undefined ) metrikaEnv.METRIKA_OAUTH_TOKEN = env.METRIKA_OAUTH_TOKEN;
	if ( env.METRIKA_COUNTER_ID !== undefined ) metrikaEnv.METRIKA_COUNTER_ID = env.METRIKA_COUNTER_ID;

	let envRes = null;
	if ( Object.keys( metrikaEnv ).length > 0 ) {
		logger.step( 'Writing Metrica credentials to .claude/.env' );
		envRes = await mergeEnv( join( cwd, '.claude/.env' ), metrikaEnv );
		// Never log token value — mergeEnv counts only.
		logger.success( `.claude/.env (Metrica): added=${ envRes.added.length }, updated=${ envRes.updated.length }, unchanged=${ envRes.unchanged.length }` );
	}

	// 2. Install the bundled Python server + venv.
	const installRes = await installMetrikaMcp( cwd, { _internals } );

	// 3. Register the MCP server only once the venv actually exists — pointing
	//    .mcp.json at a missing interpreter would make Claude fail to launch it.
	let mcpRes = null;
	if ( installRes.venvPython ) {
		mcpRes = await addServerEntry( cwd, METRIKA_MCP_SERVER, buildMetrikaMcpConfig() );
	} else {
		logger.warn( `Skipping ${ METRIKA_MCP_SERVER } .mcp.json registration until the venv is built (run: seomi-wp-mcp doctor --fix).` );
	}

	return { envRes, installRes, mcpRes };
}
