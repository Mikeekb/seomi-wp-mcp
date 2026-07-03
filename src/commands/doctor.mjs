/**
 * `seomi-wp-mcp doctor` — verify the local setup.
 *
 * Checks:
 *   - .claude/.env exists and required keys are set.
 *   - mu-plugin is in place; Version header readable.
 *   - WP REST endpoint reachable and returns 200/401 (not 404).
 *   - Abilities API + MCP Adapter plugins active (via wp-cli or HTTP).
 *   - MCP server registered in Claude.
 *
 * `--fix` runs the wp-plugin-installer for missing/inactive deps.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../lib/logger.mjs';
import { readMcpJson } from '../lib/claude-mcp.mjs';
import { ensurePlugins } from '../lib/wp-plugin-installer.mjs';
import { detectAgentMdTargets, isClaudeImportStub } from '../lib/agent-md-target.mjs';
import { probeRemoteWpCli, ensureWpCliOnSsh } from '../lib/ssh-wp-cli-installer.mjs';
import { detectPython } from '../lib/python-detector.mjs';
import { detectMetrikaState, setupMetrika } from '../lib/metrika-setup.mjs';

const MU_PLUGIN_HEADER = 'wp-content/mu-plugins/seomi-mcp-abilities/seomi-mcp-abilities.php';
const MU_LOADER_FILE = 'wp-content/mu-plugins/mcp-abilities.php';
const MARKER_BLOCK_RE = /<!--\s*seomi-wp-mcp:start\s*-->([\s\S]*?)<!--\s*seomi-wp-mcp:end\s*-->/;
const ACCESS_SECTION_HEADING = '## Credentials & remote access';
const SSH_PROBE_TIMEOUT_MS = 12000;

function exec( cmd, args, opts = {} ) {
	return new Promise( ( resolve ) => {
		const child = spawn( cmd, args, { shell: false, windowsHide: true, ...opts } );
		let stdout = '';
		let stderr = '';
		child.stdout?.on( 'data', ( d ) => { stdout += d.toString(); } );
		child.stderr?.on( 'data', ( d ) => { stderr += d.toString(); } );
		child.on( 'error', ( err ) => resolve( { code: -1, stdout, stderr: stderr + err.message } ) );
		child.on( 'close', ( code ) => resolve( { code: code ?? 0, stdout, stderr } ) );
	} );
}

async function readEnv( cwd ) {
	const path = join( cwd, '.claude/.env' );
	if ( ! existsSync( path ) ) return null;
	const text = await readFile( path, 'utf8' );
	const out = {};
	for ( const line of text.split( /\r?\n/ ) ) {
		const m = line.trim().match( /^([A-Z_][A-Z0-9_]*)=(.*)$/ );
		if ( m ) out[ m[1] ] = m[2];
	}
	return out;
}

/**
 * Build the common WP-CLI scope flags. Always passes --path; when a site URL
 * is known, also passes --url so multisite installs (which require a current
 * blog context for `wp eval`) work without "domain [] is not a valid domain".
 *
 * When `opts.skipPluginsAndThemes` is true (default for commands that don't
 * need third-party plugins loaded), appends `--skip-plugins --skip-themes`.
 * This dodges a class of bugs where a broken plugin (Yoast SEO + PHP 8.4
 * deprecations, etc.) kills wp-cli during bootstrap with exit 0. Opt OUT for
 * `wp eval` checks that need user plugins to be loaded (e.g. `function_exists`
 * for an Abilities API helper that lives in the abilities-api plugin on
 * WP < 6.9).
 */
function wpScopeArgs( wpRoot, siteUrl, opts = {} ) {
	const out = [ '--path=' + wpRoot ];
	if ( siteUrl ) out.push( '--url=' + siteUrl );
	if ( opts.skipPluginsAndThemes !== false ) {
		out.push( '--skip-plugins', '--skip-themes' );
	}
	return out;
}

async function wpPluginIsActive( wpRoot, slug, wpCliPharPath, siteUrl ) {
	const args = [ 'plugin', 'is-active', slug, ...wpScopeArgs( wpRoot, siteUrl ) ];
	const r = wpCliPharPath
		? await exec( 'php', [ wpCliPharPath, ...args ] )
		: await exec( 'wp', args, { shell: process.platform === 'win32' } );
	return r.code === 0;
}

/**
 * Probe a WordPress function via `wp eval` — useful for checking core features
 * that may not be exposed as plugins (e.g. Abilities API on WP 6.9+ where it's
 * bundled into core, not a separate plugin slug).
 *
 * On multisite installs `wp eval` MUST receive --url=<site> or it bails out
 * before loading core hooks; passing siteUrl here makes the probe robust on
 * both single-site and multisite.
 *
 * Note: this check does NOT add `--skip-plugins`. On WP < 6.9 the Abilities
 * API helpers live in the `abilities-api` plugin, so skipping plugins would
 * give a false negative.
 */
async function wpFunctionExists( wpRoot, fn, wpCliPharPath, siteUrl ) {
	const phpExpr = `echo function_exists("${ fn }") ? "yes" : "no";`;
	const args = [ 'eval', phpExpr, ...wpScopeArgs( wpRoot, siteUrl, { skipPluginsAndThemes: false } ) ];
	const r = wpCliPharPath
		? await exec( 'php', [ wpCliPharPath, ...args ] )
		: await exec( 'wp', args, { shell: process.platform === 'win32' } );
	return r.code === 0 && r.stdout.trim().endsWith( 'yes' );
}

/**
 * Lenient HTTP probe — diagnostic only (not used for real MCP traffic, which
 * runs over stdio). Uses node:https / node:http directly so we can pass
 * `rejectUnauthorized: false` — local WP installs (`https://os-foo/`) almost
 * always serve self-signed certs, and the probe is for "is the site reachable
 * at all", not for trust verification.
 *
 * (Earlier versions tried `import('undici')` to configure built-in fetch.
 * That import fails on most Node setups because undici isn't exposed as a
 * regular importable package — it's an internal module. Fell back silently
 * to strict-TLS fetch and gave false-negative HTTP 0 results.)
 */
async function httpProbe( url, user, password ) {
	const u = new URL( url );
	const https = u.protocol === 'https:';
	const lib = https ? await import( 'node:https' ) : await import( 'node:http' );

	const headers = {};
	if ( user && password ) {
		const auth = Buffer.from( `${ user }:${ password.replace( /\s+/g, '' ) }` ).toString( 'base64' );
		headers.Authorization = `Basic ${ auth }`;
	}

	const opts = {
		method: 'GET',
		hostname: u.hostname,
		port: u.port || ( https ? 443 : 80 ),
		path: u.pathname + ( u.search || '' ),
		headers,
		timeout: 8000,
	};
	if ( https ) opts.rejectUnauthorized = false;

	return new Promise( ( resolve ) => {
		const req = lib.request( opts, ( res ) => {
			res.resume(); // drain to free socket
			const status = res.statusCode ?? 0;
			resolve( { ok: status >= 200 && status < 400, status } );
		} );
		req.on( 'error', ( err ) => resolve( { ok: false, status: 0, error: err.message } ) );
		req.on( 'timeout', () => {
			req.destroy();
			resolve( { ok: false, status: 0, error: 'timeout' } );
		} );
		req.end();
	} );
}

/**
 * Inspect the seomi-wp-mcp managed block inside one specific agent-instructions
 * file (AGENTS.md or CLAUDE.md). Catches the two regressions agents have hit
 * in real projects:
 *   1. Literal "undefined" inlined when a missing env var was passed to
 *      `replaceAll` (broken renderer / stale package version).
 *   2. Missing "Credentials & remote access" H2 — means the block was written
 *      by an older version that did not surface SSH/credential keys, and the
 *      agent has to guess where prod access lives.
 */
async function inspectAgentMdBlock( filePath ) {
	if ( ! existsSync( filePath ) ) return { exists: false };
	const text = await readFile( filePath, 'utf8' );
	const m = text.match( MARKER_BLOCK_RE );
	if ( ! m ) return { exists: true, blockPresent: false };
	const body = m[ 1 ];
	return {
		exists: true,
		blockPresent: true,
		hasUndefined: /\bundefined\b/.test( body ),
		hasAccessSection: body.includes( ACCESS_SECTION_HEADING ),
	};
}

/**
 * Liveness probe for prod SSH. Uses BatchMode (never prompt for password) +
 * ConnectTimeout (server-side timeout) + a wall-clock fallback that kills the
 * child if ssh hangs longer than SSH_PROBE_TIMEOUT_MS. Intended as a fast
 * smoke check: "is the key set up correctly, is the host reachable" — not as
 * a full health probe of the remote.
 */
async function sshLivenessProbe( { host, user, port } ) {
	const args = [
		'-o', 'BatchMode=yes',
		'-o', 'ConnectTimeout=10',
		'-o', 'StrictHostKeyChecking=accept-new',
	];
	if ( port ) args.push( '-p', String( port ) );
	args.push( `${ user }@${ host }`, 'true' );
	const child = spawn( 'ssh', args, { shell: false, windowsHide: true } );
	let stderr = '';
	child.stderr?.on( 'data', ( d ) => { stderr += d.toString(); } );
	return new Promise( ( resolve ) => {
		const killer = setTimeout( () => {
			try { child.kill( 'SIGKILL' ); } catch {}
			resolve( { ok: false, code: -1, error: 'wall-clock timeout', stderr } );
		}, SSH_PROBE_TIMEOUT_MS );
		child.on( 'error', ( err ) => {
			clearTimeout( killer );
			resolve( { ok: false, code: -1, error: err.message, stderr } );
		} );
		child.on( 'close', ( code ) => {
			clearTimeout( killer );
			resolve( { ok: code === 0, code: code ?? -1, stderr } );
		} );
	} );
}

class Report {
	rows = [];
	pass( msg ) { this.rows.push( { level: 'PASS', msg } ); }
	fail( msg, hint = '' ) { this.rows.push( { level: 'FAIL', msg, hint } ); }
	warn( msg, hint = '' ) { this.rows.push( { level: 'WARN', msg, hint } ); }
	print() {
		for ( const r of this.rows ) {
			const head = r.level === 'PASS' ? '\x1b[32m[PASS]\x1b[0m'
				: r.level === 'FAIL' ? '\x1b[31m[FAIL]\x1b[0m'
				: '\x1b[33m[WARN]\x1b[0m';
			process.stdout.write( `${ head } ${ r.msg }\n` );
			if ( r.hint ) process.stdout.write( `        → ${ r.hint }\n` );
		}
	}
	exitCode() {
		return this.rows.some( ( r ) => r.level === 'FAIL' ) ? 1 : 0;
	}
}

export async function doctorCommand( opts ) {
	const cwd = process.cwd();
	const report = new Report();
	logger.step( `seomi-wp-mcp doctor — cwd: ${ cwd }` );

	// 1. .claude/.env
	const env = await readEnv( cwd );
	if ( ! env ) {
		report.fail( '.claude/.env not found', 'Run `seomi-wp-mcp init`' );
	} else {
		const required = [ 'WP_LOCAL_URL', 'WP_LOCAL_USER', 'WP_LOCAL_APP_PASSWORD', 'WP_LOCAL_MCP_SERVER' ];
		const missing = required.filter( ( k ) => ! env[ k ] );
		if ( missing.length ) {
			report.fail( `.claude/.env missing keys: ${ missing.join( ', ' ) }`, 'Run `seomi-wp-mcp init`' );
		} else {
			report.pass( '.claude/.env has all required local keys' );
		}
	}

	// 2. mu-plugin in place
	if ( ! existsSync( join( cwd, MU_LOADER_FILE ) ) ) {
		report.fail( `Loader missing: ${ MU_LOADER_FILE }`, 'Run `seomi-wp-mcp init`' );
	} else {
		report.pass( `Loader present: ${ MU_LOADER_FILE }` );
	}
	const pluginPath = join( cwd, MU_PLUGIN_HEADER );
	if ( ! existsSync( pluginPath ) ) {
		report.fail( `mu-plugin missing: ${ MU_PLUGIN_HEADER }`, 'Run `seomi-wp-mcp init`' );
	} else {
		const text = await readFile( pluginPath, 'utf8' );
		const m = text.match( /Version:\s*([^\s\r\n]+)/ );
		report.pass( `mu-plugin present, version ${ m ? m[1] : 'unknown' }` );
	}

	// 3. WP REST reachable (only when a local WP URL is configured — a
	//    Metrica-only project has no WP_LOCAL_URL and must not crash here).
	if ( env && env.WP_LOCAL_URL ) {
		const probeUrl = new URL( '/wp-json/', env.WP_LOCAL_URL ).toString();
		const probe = await httpProbe( probeUrl, env.WP_LOCAL_USER, env.WP_LOCAL_APP_PASSWORD );
		if ( probe.ok ) {
			report.pass( `WP REST reachable: ${ probeUrl } (HTTP ${ probe.status })` );
		} else {
			report.fail( `WP REST not reachable: ${ probeUrl } (HTTP ${ probe.status }${ probe.error ? ', ' + probe.error : '' })` );
		}
	}

	// 4. Plugin deps active
	const wpRoot = existsSync( join( cwd, 'wp-content' ) ) ? cwd : null;
	let depsOk = true;
	if ( wpRoot ) {
		const siteUrl = env?.WP_LOCAL_URL || '';
		// Abilities API: check the function, not the plugin slug (on WP 6.9+ it's
		// part of core, no plugin exists by that name).
		const abilitiesOk = await wpFunctionExists( wpRoot, 'wp_register_ability', env?.WP_CLI_PHAR, siteUrl );
		if ( abilitiesOk ) {
			report.pass( 'Abilities API available (wp_register_ability exists — plugin or core)' );
		} else {
			depsOk = false;
			report.fail( 'Abilities API NOT available — wp_register_ability undefined', '--fix will try to install abilities-api plugin (WP < 6.9 only)' );
		}

		// MCP Adapter remains a plugin in all current WP versions.
		const adapterOk = await wpPluginIsActive( wpRoot, 'mcp-adapter', env?.WP_CLI_PHAR, siteUrl );
		if ( adapterOk ) {
			report.pass( 'WP plugin active: mcp-adapter' );
		} else {
			depsOk = false;
			report.fail( 'WP plugin NOT active: mcp-adapter', '--fix will try to install via wp-cli or zip' );
		}
	} else {
		report.warn( 'wp-content/ not found here — skipping plugin checks (this may be a separate WP install)' );
	}

	// 5. MCP server registered in project-scope .mcp.json
	if ( env?.WP_LOCAL_MCP_SERVER ) {
		try {
			const mcp = await readMcpJson( cwd );
			const entry = mcp.mcpServers?.[ env.WP_LOCAL_MCP_SERVER ];
			if ( entry ) {
				report.pass( `MCP server (project-scope): ${ env.WP_LOCAL_MCP_SERVER } in .mcp.json` );
			} else {
				report.warn( `MCP server missing from .mcp.json: ${ env.WP_LOCAL_MCP_SERVER }`, 'Run `seomi-wp-mcp init` to register' );
			}
			if ( env.WP_PROD_MCP_SERVER ) {
				const prodEntry = mcp.mcpServers?.[ env.WP_PROD_MCP_SERVER ];
				if ( prodEntry ) {
					report.pass( `Prod MCP server: ${ env.WP_PROD_MCP_SERVER } in .mcp.json` );
				} else {
					report.warn( `Prod MCP server missing from .mcp.json: ${ env.WP_PROD_MCP_SERVER }` );
				}
			}
		} catch ( err ) {
			report.fail( `.mcp.json is malformed`, err.message );
		}
	}

	// 5.5. Yandex Metrica (optional). Only reported when the project has any
	//      Metrica footprint (creds, venv, or .mcp.json entry) — a project that
	//      never opted in shouldn't be nagged. All rows are WARN (optional
	//      feature), never FAIL.
	const metrikaState = await detectMetrikaState( cwd );
	const anyMetrika = metrikaState.hasEnv || metrikaState.hasVenv || metrikaState.hasMcp;
	if ( anyMetrika ) {
		if ( metrikaState.hasEnv ) {
			report.pass( 'Yandex Metrica creds present (METRIKA_OAUTH_TOKEN, METRIKA_COUNTER_ID)' );
		} else {
			report.warn( 'Yandex Metrica: METRIKA_OAUTH_TOKEN / METRIKA_COUNTER_ID missing in .claude/.env', 'Run `seomi-wp-mcp update --metrika` or `init`' );
		}

		const metrikaPython = detectPython();
		if ( metrikaPython ) {
			report.pass( `Python ${ metrikaPython.version } available for the Metrica MCP server` );
		} else {
			report.warn( 'Python >= 3.12 not found — the Metrica MCP server cannot run', 'Install Python 3.12+, then run `seomi-wp-mcp doctor --fix`' );
		}

		if ( metrikaState.hasVenv ) {
			report.pass( 'Yandex Metrica MCP venv is built (.claude/mcp-servers/yandex-metrika/.venv)' );
		} else {
			report.warn( 'Yandex Metrica MCP venv not built', 'Run `seomi-wp-mcp doctor --fix` (needs Python 3.12+)' );
		}

		if ( metrikaState.hasMcp ) {
			report.pass( 'Yandex Metrica MCP registered in .mcp.json (yandex-metrika)' );
		} else {
			report.warn( 'Yandex Metrica MCP not registered in .mcp.json', 'Run `seomi-wp-mcp doctor --fix`' );
		}
	}

	// 6. Agent-instructions managed-block sanity (renderer regression + access
	//    section). Detects which file(s) the project uses — AGENTS.md and/or
	//    CLAUDE.md — and inspects each one. When both coexist, warns that Claude
	//    Code will only read CLAUDE.md.
	const detected = await detectAgentMdTargets( { cwd, interactive: false } );
	const inspectTargets = detected.source === 'default' ? [] : detected.targets;
	logger.info( `[doctor] inspecting managed block in: ${ inspectTargets.length ? inspectTargets.map( ( p ) => p.split( /[\\/]/ ).pop() ).join( ', ' ) : '(none)' }` );

	// Does CLAUDE.md just import AGENTS.md (the intended redirect) rather than
	// carry its own copy of the block? When so, it has no managed block by
	// design — skip block inspection for it and report the import as healthy.
	const claudeIsStub = detected.source === 'both' && isClaudeImportStub( join( cwd, 'CLAUDE.md' ) );

	if ( inspectTargets.length === 0 ) {
		report.warn( 'No AGENTS.md or CLAUDE.md found — skipping managed-block checks', 'Run `seomi-wp-mcp init`' );
	} else {
		if ( detected.source === 'agents' ) {
			report.warn( 'Only AGENTS.md exists — Claude Code never reads AGENTS.md, so it starts without your instructions (incl. the prod SSH spec).', 'Run `seomi-wp-mcp update` to create a one-line CLAUDE.md that imports it (@AGENTS.md)' );
		} else if ( claudeIsStub ) {
			report.pass( 'CLAUDE.md imports AGENTS.md (@AGENTS.md) — Claude Code reads your instructions' );
		} else if ( detected.source === 'both' ) {
			report.warn( 'Both AGENTS.md and CLAUDE.md carry the managed block — duplicated content that can drift.', 'Prefer keeping the block in AGENTS.md and replacing CLAUDE.md with a one-line `@AGENTS.md` import' );
		}
		for ( const targetPath of inspectTargets ) {
			const name = targetPath.split( /[\\/]/ ).pop();
			// The import stub intentionally has no managed block — don't flag it.
			if ( claudeIsStub && name === 'CLAUDE.md' ) continue;
			const md = await inspectAgentMdBlock( targetPath );
			if ( ! md.exists ) {
				report.warn( `${ name } not found — skipping managed-block checks` );
				continue;
			}
			if ( ! md.blockPresent ) {
				report.warn( `${ name } found, but seomi-wp-mcp managed block missing`, 'Run `seomi-wp-mcp update` (or `init`) to insert it' );
				continue;
			}
			if ( md.hasUndefined ) {
				report.fail( `${ name } managed block contains literal "undefined" — stale or broken render`, 'Re-install/upgrade @seomi/wp-mcp and run `seomi-wp-mcp update`' );
			} else {
				report.pass( `${ name } managed block renders cleanly (no "undefined")` );
			}
			if ( ! md.hasAccessSection ) {
				report.warn( `${ name } managed block has no "${ ACCESS_SECTION_HEADING }" section`, 'Older CLI version — run `seomi-wp-mcp update` to refresh' );
			} else {
				report.pass( `${ name } managed block includes "Credentials & remote access"` );
			}
		}
	}

	// 7. Prod SSH liveness — only when prod SSH is configured.
	let prodSshOk = false;
	if ( env?.WP_PROD_SSH_HOST && env.WP_PROD_SSH_USER ) {
		const r = await sshLivenessProbe( {
			host: env.WP_PROD_SSH_HOST,
			user: env.WP_PROD_SSH_USER,
			port: env.WP_PROD_SSH_PORT,
		} );
		if ( r.ok ) {
			prodSshOk = true;
			report.pass( `Prod SSH reachable: ${ env.WP_PROD_SSH_USER }@${ env.WP_PROD_SSH_HOST } (passwordless)` );
		} else {
			const hint = r.error === 'wall-clock timeout'
				? `SSH hung >${ SSH_PROBE_TIMEOUT_MS / 1000 }s — wrong host, firewalled, or interactive prompt`
				: ( r.stderr.trim().split( /\r?\n/ ).pop() || `exit ${ r.code }` );
			report.warn( `Prod SSH NOT reachable: ${ env.WP_PROD_SSH_USER }@${ env.WP_PROD_SSH_HOST }`, hint );
		}
	}

	// 7.5. Prod WP-CLI on remote PATH. Probe only when SSH is up — otherwise
	//      the probe would re-fail for the SSH reason already reported in #7.
	//      We save the probe outcome so `--fix` doesn't have to re-run it.
	let prodWpCliProbe = null;
	if ( prodSshOk ) {
		logger.debug( 'doctor: probing remote wp-cli presence' );
		prodWpCliProbe = await probeRemoteWpCli( {
			sshHost: env.WP_PROD_SSH_HOST,
			sshUser: env.WP_PROD_SSH_USER,
			sshPort: env.WP_PROD_SSH_PORT,
		} );
		if ( prodWpCliProbe.ok ) {
			report.pass( `Prod WP-CLI installed at ${ prodWpCliProbe.remotePath }` );
		} else {
			report.warn(
				'Prod WP-CLI not found in non-interactive ssh PATH',
				'Run `seomi-wp-mcp doctor --fix` or `seomi-wp-mcp init` to install it.',
			);
		}
	}

	// 8. --fix path
	if ( opts.fix && wpRoot && ! depsOk ) {
		logger.step( 'Auto-fix: installing missing plugin deps' );
		const r = await ensurePlugins( {
			wpRoot,
			wpCliPharPath: env?.WP_CLI_PHAR,
			siteUrl: env?.WP_LOCAL_URL,
			ref: opts[ 'pin-deps' ],
		} );
		for ( const item of r.results ) {
			process.stdout.write( `  ${ item.slug }: ${ item.action }\n` );
		}
	}

	// 8.5. --fix: install WP-CLI on prod when probe (#7.5) saw it missing.
	if ( opts.fix && prodWpCliProbe && ! prodWpCliProbe.ok ) {
		logger.step( 'Auto-fix: installing WP-CLI on prod' );
		const wpcliFix = await ensureWpCliOnSsh( {
			sshHost: env.WP_PROD_SSH_HOST,
			sshUser: env.WP_PROD_SSH_USER,
			sshPort: env.WP_PROD_SSH_PORT,
		} );
		process.stdout.write( `  remote wp-cli: ${ wpcliFix.action }\n` );
		if ( wpcliFix.manualSnippet ) {
			process.stdout.write( wpcliFix.manualSnippet + '\n' );
		}
	}

	// 8.6. --fix: finish the Metrica MCP install when creds already exist but the
	//      venv/registration is incomplete. Credentials are never invented — if
	//      they're missing, the user must run init/update to provide the token.
	if ( opts.fix && metrikaState.hasEnv && ! metrikaState.configured ) {
		if ( ! detectPython() ) {
			logger.warn( 'Cannot fix Metrica: Python >= 3.12 not found. Install it and re-run `seomi-wp-mcp doctor --fix`.' );
		} else {
			logger.step( 'Auto-fix: installing/registering the Yandex Metrica MCP server' );
			const metrikaFix = await setupMetrika( cwd, {} );
			process.stdout.write( `  metrica server: ${ metrikaFix.installRes.action }${ metrikaFix.mcpRes ? ', mcp:' + metrikaFix.mcpRes.action : '' }\n` );
		}
	} else if ( opts.fix && ! metrikaState.hasEnv && ( metrikaState.hasVenv || metrikaState.hasMcp ) ) {
		logger.warn( 'Metrica MCP present but credentials are missing — run `seomi-wp-mcp update --metrika` to add METRIKA_OAUTH_TOKEN / METRIKA_COUNTER_ID.' );
	}

	report.print();
	return report.exitCode();
}
