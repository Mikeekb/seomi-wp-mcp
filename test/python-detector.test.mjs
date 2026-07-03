import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectPython, parsePythonVersion } from '../src/lib/python-detector.mjs';

/**
 * These tests inject a fake `run` so no real interpreter is required. Each
 * fake maps a candidate invocation ("py -3.12 --version") to a canned
 * { status, output }, letting us exercise the strategy chain deterministically.
 */

/** Build a fake runner from a map of "command args".join(' ') → result. */
function fakeRun( table ) {
	return ( command, args ) => {
		const key = [ command, ...args ].join( ' ' );
		return table[ key ] || { status: 1, output: 'not found' };
	};
}

test( 'parsePythonVersion parses standard output', () => {
	assert.deepEqual( parsePythonVersion( 'Python 3.12.4' ), {
		major: 3, minor: 12, patch: 4, version: '3.12.4',
	} );
	assert.equal( parsePythonVersion( 'garbage' ), null );
} );

test( 'picks first candidate when py -3.12 is present', () => {
	const run = fakeRun( { 'py -3.12 --version': { status: 0, output: 'Python 3.12.4\n' } } );
	const res = detectPython( { _internals: { run } } );
	assert.equal( res.command, 'py' );
	assert.deepEqual( res.baseArgs, [ '-3.12' ] );
	assert.equal( res.version, '3.12.4' );
} );

test( 'falls through to python3 when py is unavailable', () => {
	const run = fakeRun( { 'python3 --version': { status: 0, output: 'Python 3.13.1' } } );
	const res = detectPython( { _internals: { run } } );
	assert.equal( res.command, 'python3' );
	assert.deepEqual( res.baseArgs, [] );
	assert.equal( res.version, '3.13.1' );
} );

test( 'rejects Python < 3.12 and keeps searching', () => {
	const run = fakeRun( {
		'py -3.12 --version': { status: 1, output: 'no such version' },
		'py -3 --version': { status: 0, output: 'Python 3.9.13' },
		'python3 --version': { status: 0, output: 'Python 3.11.9' },
		'python --version': { status: 0, output: 'Python 3.12.0' },
	} );
	const res = detectPython( { _internals: { run } } );
	// Only `python` meets >= 3.12 here.
	assert.equal( res.command, 'python' );
	assert.equal( res.version, '3.12.0' );
} );

test( 'returns null when nothing suitable is found', () => {
	const run = fakeRun( {
		'py -3 --version': { status: 0, output: 'Python 2.7.18' },
		'python --version': { status: 0, output: 'Python 3.10.0' },
	} );
	assert.equal( detectPython( { _internals: { run } } ), null );
} );

test( 'accepts a future major version (4.x)', () => {
	const run = fakeRun( { 'py -3.12 --version': { status: 0, output: 'Python 4.0.0' } } );
	const res = detectPython( { _internals: { run } } );
	assert.equal( res.version, '4.0.0' );
} );
