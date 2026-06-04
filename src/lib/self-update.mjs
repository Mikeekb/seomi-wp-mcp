/**
 * Self-update gate for the seomi-wp-mcp CLI.
 *
 * `seomi-wp-mcp update` runs this first: it asks npm whether a newer version
 * of the package itself has been published. If so, the global package is
 * upgraded and the caller is expected to re-run so the *new* code regenerates
 * the project files (a running Node process can't hot-swap its own modules).
 * If npm is unreachable or already current, the caller proceeds straight to
 * refreshing project data.
 *
 * Mechanics (npm/semver) live here; orchestration/prompts live in the update
 * command. `_internals.exec` is injectable so tests can stub npm without a
 * network round-trip — same pattern as src/commands/init.mjs.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

export const PKG_NAME = '@seomi/wp-mcp';

// npm is a .cmd shim on Windows; recent Node refuses to spawn .cmd/.bat
// without a shell, so run npm through the shell on every platform (the args
// here are shell-safe — no spaces or metacharacters).
function defaultExec( cmd, args, opts = {} ) {
	return new Promise( ( resolve ) => {
		const child = spawn( cmd, args, { shell: true, windowsHide: true, ...opts } );
		let stdout = '';
		let stderr = '';
		child.stdout?.on( 'data', ( d ) => { stdout += d.toString(); } );
		child.stderr?.on( 'data', ( d ) => { stderr += d.toString(); } );
		child.on( 'error', ( err ) => resolve( { code: -1, stdout, stderr: stderr + err.message } ) );
		child.on( 'close', ( code ) => resolve( { code: code ?? 0, stdout, stderr } ) );
	} );
}

export const _internals = { exec: defaultExec };

function pkgRoot() {
	return resolvePath( new URL( '../..', import.meta.url ).pathname.replace( /^\/([A-Z]:)/, '$1' ) );
}

export async function readCurrentVersion() {
	const text = await readFile( join( pkgRoot(), 'package.json' ), 'utf8' );
	return JSON.parse( text ).version;
}

/**
 * Parse a version string into numeric segments, dropping any pre-release or
 * build metadata (`1.2.3-beta.1+build` → [1, 2, 3]).
 */
export function parseVersion( v ) {
	const core = String( v ).trim().replace( /^v/, '' ).split( /[-+]/ )[ 0 ];
	return core.split( '.' ).map( ( n ) => parseInt( n, 10 ) || 0 );
}

/** True when `candidate` is strictly newer than `base` (major.minor.patch). */
export function isNewer( candidate, base ) {
	const a = parseVersion( candidate );
	const b = parseVersion( base );
	const len = Math.max( a.length, b.length );
	for ( let i = 0; i < len; i++ ) {
		const x = a[ i ] ?? 0;
		const y = b[ i ] ?? 0;
		if ( x > y ) return true;
		if ( x < y ) return false;
	}
	return false;
}

/**
 * Ask npm for the latest published version. Returns the version string, or
 * null when npm is unreachable / errors / times out (caller treats null as
 * "couldn't check" and carries on with the current version).
 */
export async function getLatestVersion( name = PKG_NAME, { timeoutMs = 10000 } = {} ) {
	const r = await _internals.exec( 'npm', [ 'view', name, 'version' ], { timeout: timeoutMs } );
	if ( r.code !== 0 ) return null;
	const v = ( r.stdout || '' ).trim();
	return v || null;
}

/**
 * Compare the installed version against the latest published one.
 * Returns { checked, current, latest, hasUpdate }. `checked` is false when the
 * npm lookup failed — the caller should proceed without self-updating.
 */
export async function checkForUpdate( { name = PKG_NAME, currentVersion } = {} ) {
	const current = currentVersion ?? await readCurrentVersion();
	const latest = await getLatestVersion( name );
	if ( ! latest ) {
		return { checked: false, current, latest: null, hasUpdate: false };
	}
	return { checked: true, current, latest, hasUpdate: isNewer( latest, current ) };
}

/** Upgrade the global package to @latest. Returns { ok, error }. */
export async function performSelfUpdate( { name = PKG_NAME } = {} ) {
	const r = await _internals.exec( 'npm', [ 'install', '-g', `${ name }@latest` ], { stdio: 'inherit' } );
	return { ok: r.code === 0, error: r.code === 0 ? null : ( r.stderr || '' ).trim() || null };
}
