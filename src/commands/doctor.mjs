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
import { hasServer } from '../lib/claude-mcp.mjs';
import { ensurePlugins } from '../lib/wp-plugin-installer.mjs';

const MU_PLUGIN_HEADER = 'wp-content/mu-plugins/seomi-mcp-abilities/seomi-mcp-abilities.php';
const MU_LOADER_FILE = 'wp-content/mu-plugins/mcp-abilities.php';

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

async function wpPluginIsActive( wpRoot, slug ) {
	const r = await exec( 'wp', [ 'plugin', 'is-active', slug, '--path=' + wpRoot ] );
	return r.code === 0;
}

async function httpProbe( url, user, password ) {
	try {
		const headers = {};
		if ( user && password ) {
			const auth = Buffer.from( `${ user }:${ password.replace( /\s+/g, '' ) }` ).toString( 'base64' );
			headers.Authorization = `Basic ${ auth }`;
		}
		const resp = await fetch( url, { headers, redirect: 'manual' } );
		return { ok: resp.ok, status: resp.status };
	} catch ( err ) {
		return { ok: false, status: 0, error: err.message };
	}
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

	// 3. WP REST reachable
	if ( env ) {
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
		for ( const slug of [ 'abilities-api', 'mcp-adapter' ] ) {
			const active = await wpPluginIsActive( wpRoot, slug );
			if ( active ) {
				report.pass( `WP plugin active: ${ slug }` );
			} else {
				depsOk = false;
				report.fail( `WP plugin NOT active: ${ slug }`, '--fix will try to install via wp-cli or zip' );
			}
		}
	} else {
		report.warn( 'wp-content/ not found here — skipping plugin checks (this may be a separate WP install)' );
	}

	// 5. MCP server registered
	if ( env?.WP_LOCAL_MCP_SERVER ) {
		const ok = await hasServer( env.WP_LOCAL_MCP_SERVER );
		if ( ok ) {
			report.pass( `MCP server registered in Claude: ${ env.WP_LOCAL_MCP_SERVER }` );
		} else {
			report.warn( `MCP server not registered in Claude: ${ env.WP_LOCAL_MCP_SERVER }`, 'Run `seomi-wp-mcp init` or `claude mcp add` manually' );
		}
	}

	// 6. --fix path
	if ( opts.fix && wpRoot && ! depsOk ) {
		logger.step( 'Auto-fix: installing missing plugin deps' );
		const r = await ensurePlugins( { wpRoot, ref: opts[ 'pin-deps' ] } );
		for ( const item of r.results ) {
			process.stdout.write( `  ${ item.slug }: ${ item.action }\n` );
		}
	}

	report.print();
	return report.exitCode();
}
