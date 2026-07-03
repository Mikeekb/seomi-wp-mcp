/**
 * Install the bundled Yandex Metrika MCP server (Python) into a client project.
 *
 * The server lives in the package at `mcp-servers/yandex-metrika/` (a Python
 * package, seomi_metrika). This module copies it into the client project at
 * `.claude/mcp-servers/yandex-metrika/`, builds a local venv, installs the
 * package into it, and verifies it imports.
 *
 * Design mirrors the rest of src/lib: a strategy chain with graceful
 * degradation. If no Python >= 3.12 is present, this is NOT fatal — the skill
 * and credentials still install; we return `python-missing` with instructions
 * and let the caller (init/update/doctor) surface a warning. venv install is
 * strategy-chained: `uv` (fast) first, plain `pip` as fallback.
 *
 * Idempotence:
 *   - Source is recopied on every run (managed), EXCEPT the client's existing
 *     `.venv/` and Python caches, which are preserved — wiping the whole dir
 *     would destroy the venv we just built.
 *   - The package is installed editable (`-e`), so a recopy of `src/` is
 *     immediately reflected without a full reinstall.
 */

import { existsSync } from 'node:fs';
import { cp, rm, mkdir, readdir } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { spawnSync } from 'node:child_process';
import { logger } from './logger.mjs';
import { detectPython } from './python-detector.mjs';

/** Relative location of the server inside the client project. */
export const CLIENT_SERVER_REL = join( '.claude', 'mcp-servers', 'yandex-metrika' );

/** Top-level entries in the bundled source that must never be copied out. */
const COPY_EXCLUDE = new Set( [ '.venv', '__pycache__', '.pytest_cache' ] );

/** Resolve the package root from `src/lib/` (same trick as skill-installer). */
function pkgRoot() {
	return resolvePath( new URL( '../..', import.meta.url ).pathname.replace( /^\/([A-Z]:)/, '$1' ) );
}

/**
 * The venv interpreter path for a server dir, per platform.
 * Windows: `.venv/Scripts/python.exe`; POSIX: `.venv/bin/python`.
 *
 * @param {string} serverDir
 * @param {string} [platform=process.platform]
 */
export function venvPythonPath( serverDir, platform = process.platform ) {
	return platform === 'win32'
		? join( serverDir, '.venv', 'Scripts', 'python.exe' )
		: join( serverDir, '.venv', 'bin', 'python' );
}

/**
 * Default command runner. Returns `{ status, output }`; spawn failures become a
 * non-zero status so callers treat them as "step failed" without throwing.
 */
function defaultRun( command, args, opts = {} ) {
	try {
		const res = spawnSync( command, args, { encoding: 'utf8', timeout: 300000, ...opts } );
		if ( res.error ) return { status: 1, output: String( res.error.message || res.error ) };
		return { status: res.status, output: `${ res.stdout || '' }${ res.stderr || '' }` };
	} catch ( err ) {
		return { status: 1, output: String( err && err.message ? err.message : err ) };
	}
}

/**
 * Copy the bundled server source into the client dir, preserving any existing
 * `.venv/`. Managed per top-level entry: each copied entry is wiped first so a
 * file removed from a newer server version doesn't linger.
 */
async function copyServerSource( srcDir, destDir, deps ) {
	await deps.mkdir( destDir, { recursive: true } );
	const entries = await deps.readdir( srcDir, { withFileTypes: true } );
	for ( const entry of entries ) {
		const name = entry.name;
		if ( COPY_EXCLUDE.has( name ) || name.endsWith( '.egg-info' ) ) continue;
		const from = join( srcDir, name );
		const to = join( destDir, name );
		// Wipe only the entry we're about to replace — never touches dest/.venv.
		await deps.rm( to, { recursive: true, force: true } );
		await deps.cp( from, to, { recursive: true, force: true } );
	}
}

/**
 * Install the Metrika MCP server into `<cwd>/.claude/mcp-servers/yandex-metrika/`.
 *
 * @param {string} cwd - client project root.
 * @param {object} [options]
 * @param {object} [options._internals] - injection seam for tests: override
 *   `pkgRoot`, `detectPython`, `run`, `platform`, `cp`, `rm`, `mkdir`,
 *   `readdir`, `exists`.
 * @returns {Promise<{ action: 'installed'|'updated'|'python-missing'|'failed',
 *   serverDir: string, venvPython?: string, python?: object, reason?: string }>}
 */
export async function installMetrikaMcp( cwd, { _internals = {} } = {} ) {
	const deps = {
		pkgRoot, detectPython, run: defaultRun,
		platform: process.platform, cp, rm, mkdir, readdir,
		exists: existsSync, ..._internals,
	};

	const root = deps.pkgRoot();
	const srcDir = join( root, 'mcp-servers', 'yandex-metrika' );
	const serverDir = join( cwd, CLIENT_SERVER_REL );
	logger.debug( `metrika-installer: src=${ srcDir } dest=${ serverDir }` );

	if ( ! deps.exists( srcDir ) ) {
		logger.warn( `Metrika MCP source missing at ${ srcDir } — skipping server install.` );
		return { action: 'failed', serverDir, reason: 'source-missing' };
	}

	// 1. Detect Python before touching the venv — this is the gating check.
	const python = deps.detectPython( { _internals } );
	if ( ! python ) {
		logger.warn( 'Python >= 3.12 not found — Metrika MCP server not built.' );
		logger.info( '  Install Python 3.12+ and re-run: seomi-wp-mcp doctor --fix' );
		// Still copy the source so `doctor --fix` can finish later without the package.
		try {
			await copyServerSource( srcDir, serverDir, deps );
		} catch ( err ) {
			logger.debug( `metrika-installer: source copy failed under python-missing: ${ err.message }` );
		}
		return { action: 'python-missing', serverDir };
	}

	const venvPython = venvPythonPath( serverDir, deps.platform );
	const venvExisted = deps.exists( venvPython );

	// 2. Copy the server source (preserving an existing .venv).
	logger.step( 'Installing Yandex Metrika MCP server into .claude/mcp-servers/yandex-metrika/' );
	try {
		await copyServerSource( srcDir, serverDir, deps );
	} catch ( err ) {
		logger.error( `Metrika MCP source copy failed: ${ err.message }` );
		return { action: 'failed', serverDir, reason: 'copy-failed' };
	}

	// 3. Create the venv if it doesn't exist yet.
	if ( ! deps.exists( venvPython ) ) {
		logger.debug( `metrika-installer: creating venv with '${ python.command } ${ python.baseArgs.join( ' ' ) }'` );
		const mk = deps.run( python.command, [ ...python.baseArgs, '-m', 'venv', '.venv' ], { cwd: serverDir } );
		if ( mk.status !== 0 || ! deps.exists( venvPython ) ) {
			logger.error( `Failed to create Python venv: ${ mk.output.trim() }` );
			return { action: 'failed', serverDir, reason: 'venv-failed' };
		}
	}

	// 4. Install the package: uv (fast) → pip (fallback).
	const uv = deps.run( 'uv', [ 'pip', 'install', '--python', venvPython, '-e', '.' ], { cwd: serverDir } );
	if ( uv.status === 0 ) {
		logger.debug( 'metrika-installer: installed via uv' );
	} else {
		logger.debug( `metrika-installer: uv unavailable/failed (${ uv.output.trim().slice( 0, 120 ) }); falling back to pip` );
		const pip = deps.run( venvPython, [ '-m', 'pip', 'install', '-e', '.' ], { cwd: serverDir } );
		if ( pip.status !== 0 ) {
			logger.error( `pip install failed: ${ pip.output.trim() }` );
			return { action: 'failed', serverDir, reason: 'install-failed' };
		}
	}

	// 5. Verify the package imports.
	const verify = deps.run( venvPython, [ '-c', 'import seomi_metrika' ], { cwd: serverDir } );
	if ( verify.status !== 0 ) {
		logger.error( `Metrika MCP server failed import verification: ${ verify.output.trim() }` );
		return { action: 'failed', serverDir, reason: 'verify-failed' };
	}

	const action = venvExisted ? 'updated' : 'installed';
	logger.success( `Yandex Metrika MCP server ${ action } (Python ${ python.version })` );
	return { action, serverDir, venvPython, python };
}
