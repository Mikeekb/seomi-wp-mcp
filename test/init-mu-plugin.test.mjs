import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	connectMuPlugin,
	MU_PLUGIN_REPO_URL,
	MU_PLUGIN_DIR,
	MU_LOADER_FILE,
	MU_PLUGIN_LOADER_PHP,
	_internals,
} from '../src/commands/init.mjs';

function makeStub( router ) {
	const calls = [];
	const fn = async ( cmd, args, opts = {} ) => {
		calls.push( { cmd, args, opts } );
		return router( cmd, args, opts ) || { code: 0, stdout: '', stderr: '' };
	};
	fn.calls = calls;
	return fn;
}

async function withStub( router, run ) {
	const original = _internals.exec;
	const stub = makeStub( router );
	_internals.exec = stub;
	try {
		const result = await run( stub );
		return { result, stub };
	} finally {
		_internals.exec = original;
	}
}

async function makeCwd() {
	return await mkdtemp( join( tmpdir(), 'seomi-init-mu-' ) );
}

function isSubmoduleAdd( cmd, args ) {
	return cmd === 'git' && args[ 0 ] === 'submodule' && args[ 1 ] === 'add';
}
function isGitClone( cmd, args ) {
	return cmd === 'git' && args[ 0 ] === 'clone';
}
function isRmGit( cmd, args ) {
	return cmd === 'rm' && args[ 0 ] === '-rf' && /\.git$/.test( args[ 1 ] || '' );
}

test( 'submodule success: returns action=added, no clone invoked', async () => {
	const cwd = await makeCwd();
	try {
		const { result, stub } = await withStub( ( cmd, args ) => {
			if ( isSubmoduleAdd( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			return { code: 0, stdout: '', stderr: '' };
		}, () => connectMuPlugin( cwd, 'submodule' ) );

		assert.equal( result.strategy, 'submodule' );
		assert.equal( result.action, 'added' );
		assert.equal( stub.calls.length, 1 );
		assert.ok( isSubmoduleAdd( stub.calls[ 0 ].cmd, stub.calls[ 0 ].args ) );
	} finally {
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'gitignored fallback: warns, runs clone + rm -rf .git, returns submodule-fallback-copy', async () => {
	const cwd = await makeCwd();
	try {
		const stderr = 'The following paths are ignored by one of your .gitignore files:\nwp-content/mu-plugins\nhint: Use -f if you really want to add them.\n';
		const { result, stub } = await withStub( ( cmd, args ) => {
			if ( isSubmoduleAdd( cmd, args ) ) return { code: 1, stdout: '', stderr };
			if ( isGitClone( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isRmGit( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			return { code: 0, stdout: '', stderr: '' };
		}, () => connectMuPlugin( cwd, 'submodule' ) );

		assert.equal( result.strategy, 'submodule-fallback-copy' );
		assert.equal( result.action, 'added' );
		assert.equal( result.fallbackReason, 'gitignored' );
		assert.equal( stub.calls.length, 3 );
		assert.ok( isSubmoduleAdd( stub.calls[ 0 ].cmd, stub.calls[ 0 ].args ) );
		assert.ok( isGitClone( stub.calls[ 1 ].cmd, stub.calls[ 1 ].args ) );
		assert.equal( stub.calls[ 1 ].args[ 1 ], '--depth=1' );
		assert.equal( stub.calls[ 1 ].args[ 2 ], MU_PLUGIN_REPO_URL );
		assert.equal( stub.calls[ 1 ].args[ 3 ], join( cwd, MU_PLUGIN_DIR ) );
		assert.ok( isRmGit( stub.calls[ 2 ].cmd, stub.calls[ 2 ].args ) );
	} finally {
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'not-a-repo fallback: warns, runs clone + rm -rf .git, returns submodule-fallback-copy', async () => {
	const cwd = await makeCwd();
	try {
		const stderr = 'fatal: not a git repository (or any of the parent directories): .git\n';
		const { result, stub } = await withStub( ( cmd, args ) => {
			if ( isSubmoduleAdd( cmd, args ) ) return { code: 128, stdout: '', stderr };
			if ( isGitClone( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isRmGit( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			return { code: 0, stdout: '', stderr: '' };
		}, () => connectMuPlugin( cwd, 'submodule' ) );

		assert.equal( result.strategy, 'submodule-fallback-copy' );
		assert.equal( result.action, 'added' );
		assert.equal( result.fallbackReason, 'not-a-repo' );
		assert.equal( stub.calls.length, 3 );
		assert.ok( isSubmoduleAdd( stub.calls[ 0 ].cmd, stub.calls[ 0 ].args ) );
		assert.ok( isGitClone( stub.calls[ 1 ].cmd, stub.calls[ 1 ].args ) );
		assert.equal( stub.calls[ 1 ].args[ 1 ], '--depth=1' );
		assert.equal( stub.calls[ 1 ].args[ 2 ], MU_PLUGIN_REPO_URL );
		assert.equal( stub.calls[ 1 ].args[ 3 ], join( cwd, MU_PLUGIN_DIR ) );
		assert.ok( isRmGit( stub.calls[ 2 ].cmd, stub.calls[ 2 ].args ) );
	} finally {
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'non-gitignored submodule failure: returns failed, no clone fallback', async () => {
	const cwd = await makeCwd();
	try {
		const { result, stub } = await withStub( ( cmd, args ) => {
			if ( isSubmoduleAdd( cmd, args ) ) return { code: 128, stdout: '', stderr: 'fatal: remote unreachable' };
			return { code: 0, stdout: '', stderr: '' };
		}, () => connectMuPlugin( cwd, 'submodule' ) );

		assert.equal( result.strategy, 'submodule' );
		assert.equal( result.action, 'failed' );
		assert.equal( stub.calls.length, 1, 'clone must not be attempted for non-gitignored failures' );
		assert.ok( ! stub.calls.some( ( c ) => isGitClone( c.cmd, c.args ) ) );
	} finally {
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'fallback clone fails: returns failed with fallbackAttempted=copy', async () => {
	const cwd = await makeCwd();
	try {
		const stderr = 'paths are ignored by one of your .gitignore files';
		const { result, stub } = await withStub( ( cmd, args ) => {
			if ( isSubmoduleAdd( cmd, args ) ) return { code: 1, stdout: '', stderr };
			if ( isGitClone( cmd, args ) ) return { code: 128, stdout: '', stderr: 'fatal: cannot reach github.com' };
			return { code: 0, stdout: '', stderr: '' };
		}, () => connectMuPlugin( cwd, 'submodule' ) );

		assert.equal( result.action, 'failed' );
		assert.equal( result.fallbackAttempted, 'copy' );
		assert.ok( ! stub.calls.some( ( c ) => isRmGit( c.cmd, c.args ) ), 'rm -rf .git must not run when clone fails' );
	} finally {
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'gitignored regex is case-insensitive', async () => {
	const cwd = await makeCwd();
	try {
		const stderr = 'IGNORED BY ONE OF YOUR .GITIGNORE FILES';
		const { result, stub } = await withStub( ( cmd, args ) => {
			if ( isSubmoduleAdd( cmd, args ) ) return { code: 1, stdout: '', stderr };
			if ( isGitClone( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			return { code: 0, stdout: '', stderr: '' };
		}, () => connectMuPlugin( cwd, 'submodule' ) );

		assert.equal( result.strategy, 'submodule-fallback-copy' );
		assert.equal( result.action, 'added' );
		assert.ok( stub.calls.some( ( c ) => isGitClone( c.cmd, c.args ) ) );
	} finally {
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'loader file is created on first call and reused on second (idempotent)', async () => {
	const cwd = await makeCwd();
	try {
		const loaderPath = join( cwd, MU_LOADER_FILE );
		assert.ok( ! existsSync( loaderPath ), 'precondition: loader does not exist' );

		await withStub( ( cmd, args ) => {
			if ( isSubmoduleAdd( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			return { code: 0, stdout: '', stderr: '' };
		}, () => connectMuPlugin( cwd, 'submodule' ) );

		assert.ok( existsSync( loaderPath ), 'loader must be created on first call' );
		const content = await readFile( loaderPath, 'utf8' );
		assert.equal( content, MU_PLUGIN_LOADER_PHP );

		// Tamper with the file to make sure connectMuPlugin does NOT overwrite
		// a pre-existing loader (it must be left as-is to preserve user edits).
		await writeFile( loaderPath, '<?php // user-edited\n', 'utf8' );

		// Simulate already-present target dir so second call short-circuits to
		// 'already-present' without touching git.
		const targetDir = join( cwd, MU_PLUGIN_DIR );
		await mkdir( targetDir, { recursive: true } );

		const { result, stub } = await withStub( ( cmd, args ) => {
			if ( isSubmoduleAdd( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			return { code: 0, stdout: '', stderr: '' };
		}, () => connectMuPlugin( cwd, 'submodule' ) );

		assert.equal( result.action, 'already-present' );
		assert.equal( stub.calls.length, 0, 'no git calls on idempotent re-run' );
		const after = await readFile( loaderPath, 'utf8' );
		assert.equal( after, '<?php // user-edited\n', 'existing loader must not be overwritten' );
	} finally {
		await rm( cwd, { recursive: true, force: true } );
	}
} );
