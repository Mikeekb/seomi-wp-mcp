/**
 * Detect a usable Python >= 3.12 interpreter for the Yandex Metrika MCP server.
 *
 * The bundled Metrika MCP server (mcp-servers/yandex-metrika/) is a Python
 * package (FastMCP + httpx + pydantic) and needs Python 3.12+ to build its
 * venv. WordPress developers reliably have PHP and Node, but Python is not
 * guaranteed — so this is a probe, not an assumption. A null result is a
 * normal outcome that callers degrade gracefully on (skill still installs,
 * MCP registration is deferred with manual instructions).
 *
 * Strategy chain (first match wins), Windows-first because that's the primary
 * dev platform for this package:
 *   1. `py -3.12`  — Windows py-launcher, exact minor
 *   2. `py -3`     — Windows py-launcher, latest 3.x
 *   3. `python3`   — POSIX convention
 *   4. `python`    — last resort (may be 3.x on modern systems)
 *
 * Each candidate is probed with `--version`; the printed `Python X.Y.Z` is
 * parsed and accepted only when major === 3 and minor >= 12.
 */

import { spawnSync } from 'node:child_process';
import { logger } from './logger.mjs';

const MIN_MAJOR = 3;
const MIN_MINOR = 12;

/** Interpreter invocation prefixes, in probe order. */
const CANDIDATES = [
	{ command: 'py', baseArgs: [ '-3.12' ] },
	{ command: 'py', baseArgs: [ '-3' ] },
	{ command: 'python3', baseArgs: [] },
	{ command: 'python', baseArgs: [] },
];

const VERSION_RE = /Python\s+(\d+)\.(\d+)\.(\d+)/i;

/**
 * Default runner: execute `<command> <args...>` and return its combined output.
 * Swallows spawn errors (missing binary) into a non-zero status so the chain
 * simply moves on.
 *
 * @returns {{ status: number|null, output: string }}
 */
function defaultRun( command, args ) {
	try {
		const res = spawnSync( command, args, { encoding: 'utf8', timeout: 10000 } );
		if ( res.error ) {
			return { status: 1, output: String( res.error.message || res.error ) };
		}
		const output = `${ res.stdout || '' }${ res.stderr || '' }`;
		return { status: res.status, output };
	} catch ( err ) {
		return { status: 1, output: String( err && err.message ? err.message : err ) };
	}
}

/**
 * Parse a `python --version` output into a version tuple, or null.
 *
 * @param {string} output
 * @returns {{ major: number, minor: number, patch: number, version: string } | null}
 */
export function parsePythonVersion( output ) {
	const m = VERSION_RE.exec( output || '' );
	if ( ! m ) return null;
	const major = Number( m[ 1 ] );
	const minor = Number( m[ 2 ] );
	const patch = Number( m[ 3 ] );
	return { major, minor, patch, version: `${ major }.${ minor }.${ patch }` };
}

/**
 * Is this version tuple >= the required minimum (3.12)?
 * @param {{ major: number, minor: number }} v
 */
function meetsMinimum( v ) {
	if ( v.major !== MIN_MAJOR ) return v.major > MIN_MAJOR;
	return v.minor >= MIN_MINOR;
}

/**
 * Detect a Python >= 3.12 interpreter.
 *
 * @param {object} [options]
 * @param {object} [options._internals] - injection seam for tests (override `run`).
 * @returns {{ command: string, baseArgs: string[], version: string } | null}
 *   `command` + `baseArgs` form the interpreter prefix, e.g. run venv with
 *   `spawn(command, [...baseArgs, '-m', 'venv', '.venv'])`. Null when no
 *   suitable interpreter is found.
 */
export function detectPython( { _internals = {} } = {} ) {
	const run = _internals.run || defaultRun;
	logger.debug( 'python-detector: probing for Python >= 3.12' );

	for ( const { command, baseArgs } of CANDIDATES ) {
		const args = [ ...baseArgs, '--version' ];
		const label = [ command, ...baseArgs ].join( ' ' );
		const { status, output } = run( command, args );
		if ( status !== 0 ) {
			logger.debug( `python-detector: '${ label }' not runnable (status=${ status })` );
			continue;
		}
		const parsed = parsePythonVersion( output );
		if ( ! parsed ) {
			logger.debug( `python-detector: '${ label }' gave unparseable version: ${ output.trim() }` );
			continue;
		}
		if ( ! meetsMinimum( parsed ) ) {
			logger.debug( `python-detector: '${ label }' is ${ parsed.version } (< ${ MIN_MAJOR }.${ MIN_MINOR }), skipping` );
			continue;
		}
		logger.debug( `python-detector: using '${ label }' → Python ${ parsed.version }` );
		return { command, baseArgs, version: parsed.version };
	}

	logger.debug( `python-detector: no Python >= ${ MIN_MAJOR }.${ MIN_MINOR } found` );
	return null;
}
