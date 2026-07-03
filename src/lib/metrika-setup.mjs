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
import { confirm, input, password } from '@inquirer/prompts';
import { logger } from './logger.mjs';
import { mergeEnv } from './env-writer.mjs';
import { addServerEntry, buildMetrikaMcpConfig, readMcpJson } from './claude-mcp.mjs';
import { installMetrikaMcp, venvPythonPath, CLIENT_SERVER_REL } from './metrika-mcp-installer.mjs';

/** MCP server name used in the client's `.mcp.json`. */
export const METRIKA_MCP_SERVER = 'yandex-metrika';

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
	const token = await password( {
		message: 'Metrica OAuth token (from https://oauth.yandex.ru/; needs metrika:write for goals/segments):',
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
