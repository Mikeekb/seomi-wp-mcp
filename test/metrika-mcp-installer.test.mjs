import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { installMetrikaMcp, venvPythonPath, CLIENT_SERVER_REL } from '../src/lib/metrika-mcp-installer.mjs';

/**
 * Real fs against temp dirs; only `detectPython` and `run` (venv/pip/verify)
 * are injected. The fake `run` materialises the venv python file when it sees
 * the `-m venv` command, so the installer's post-venv existence check passes
 * without a real interpreter.
 */

async function tmp() {
	return mkdtemp( join( tmpdir(), 'seomi-metrika-inst-' ) );
}

async function exists( p ) {
	try { await access( p ); return true; } catch { return false; }
}

/** Fake package root with a minimal bundled server (+ a __pycache__ to exclude). */
async function makeFakeRoot() {
	const root = await tmp();
	const srv = join( root, 'mcp-servers', 'yandex-metrika' );
	await mkdir( join( srv, 'src', 'seomi_metrika' ), { recursive: true } );
	await writeFile( join( srv, 'pyproject.toml' ), '[project]\nname="seomi-metrika-mcp"\n', 'utf8' );
	await writeFile( join( srv, 'src', 'seomi_metrika', '__init__.py' ), '', 'utf8' );
	await mkdir( join( srv, '__pycache__' ), { recursive: true } );
	await writeFile( join( srv, '__pycache__', 'junk.pyc' ), 'x', 'utf8' );
	return root;
}

const okPython = () => ( { command: 'py', baseArgs: [ '-3.12' ], version: '3.12.4' } );

/** run() that creates the venv python on `-m venv`, and can force uv to fail. */
function fakeRun( { uvOk = false } = {} ) {
	const calls = [];
	const run = ( command, args, opts = {} ) => {
		calls.push( [ command, ...args ].join( ' ' ) );
		if ( args.includes( 'venv' ) ) {
			const vp = venvPythonPath( opts.cwd );
			mkdirSync( dirname( vp ), { recursive: true } );
			writeFileSync( vp, '' );
			return { status: 0, output: '' };
		}
		if ( command === 'uv' ) return { status: uvOk ? 0 : 1, output: 'uv' };
		return { status: 0, output: '' };
	};
	run.calls = calls;
	return run;
}

test( 'happy path: installs, builds venv, verifies, action=installed', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	try {
		const run = fakeRun();
		const res = await installMetrikaMcp( cwd, { _internals: { pkgRoot: () => root, detectPython: okPython, run } } );

		assert.equal( res.action, 'installed' );
		const serverDir = join( cwd, CLIENT_SERVER_REL );
		// Source copied.
		assert.equal( await exists( join( serverDir, 'pyproject.toml' ) ), true );
		assert.equal( await exists( join( serverDir, 'src', 'seomi_metrika', '__init__.py' ) ), true );
		// __pycache__ excluded from the copy.
		assert.equal( await exists( join( serverDir, '__pycache__' ) ), false );
		// pip fallback used (uv failed), and verify ran.
		assert.ok( run.calls.some( ( c ) => c.includes( '-m pip install -e .' ) ) );
		assert.ok( run.calls.some( ( c ) => c.includes( 'import seomi_metrika' ) ) );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'uv path: when uv succeeds, pip is not called', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	try {
		const run = fakeRun( { uvOk: true } );
		const res = await installMetrikaMcp( cwd, { _internals: { pkgRoot: () => root, detectPython: okPython, run } } );
		assert.equal( res.action, 'installed' );
		assert.ok( run.calls.some( ( c ) => c.startsWith( 'uv pip install' ) ) );
		assert.ok( ! run.calls.some( ( c ) => c.includes( '-m pip install' ) ) );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'python-missing: no venv built, source still copied, non-fatal', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	try {
		const res = await installMetrikaMcp( cwd, {
			_internals: { pkgRoot: () => root, detectPython: () => null, run: fakeRun() },
		} );
		assert.equal( res.action, 'python-missing' );
		// Source copied so a later doctor --fix can finish.
		assert.equal( await exists( join( cwd, CLIENT_SERVER_REL, 'pyproject.toml' ) ), true );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'idempotent update: pre-existing venv → action=updated, venv preserved', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	try {
		const serverDir = join( cwd, CLIENT_SERVER_REL );
		const vp = venvPythonPath( serverDir );
		await mkdir( dirname( vp ), { recursive: true } );
		await writeFile( vp, 'preexisting', 'utf8' );

		const run = fakeRun();
		const res = await installMetrikaMcp( cwd, { _internals: { pkgRoot: () => root, detectPython: okPython, run } } );

		assert.equal( res.action, 'updated' );
		// venv was not recreated (no `-m venv` call) nor wiped.
		assert.ok( ! run.calls.some( ( c ) => c.includes( '-m venv' ) ) );
		assert.equal( await readFile( vp, 'utf8' ), 'preexisting' );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'venv creation failure → action=failed', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	try {
		// run that never creates the venv python and returns non-zero for venv.
		const run = ( command, args ) => {
			if ( args.includes( 'venv' ) ) return { status: 1, output: 'no venv module' };
			return { status: 0, output: '' };
		};
		const res = await installMetrikaMcp( cwd, { _internals: { pkgRoot: () => root, detectPython: okPython, run } } );
		assert.equal( res.action, 'failed' );
		assert.equal( res.reason, 'venv-failed' );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );
