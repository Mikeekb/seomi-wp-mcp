import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
	parseVersion,
	isNewer,
	getLatestVersion,
	checkForUpdate,
	performSelfUpdate,
	PKG_NAME,
	_internals,
} from '../src/lib/self-update.mjs';

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

function isNpmView( cmd, args ) {
	return cmd === 'npm' && args[ 0 ] === 'view' && args[ 2 ] === 'version';
}
function isNpmInstall( cmd, args ) {
	return cmd === 'npm' && args[ 0 ] === 'install' && args[ 1 ] === '-g';
}

test( 'parseVersion drops pre-release and build metadata', () => {
	assert.deepEqual( parseVersion( '0.1.25' ), [ 0, 1, 25 ] );
	assert.deepEqual( parseVersion( 'v1.2.3' ), [ 1, 2, 3 ] );
	assert.deepEqual( parseVersion( '1.2.3-beta.1+build5' ), [ 1, 2, 3 ] );
} );

test( 'isNewer compares semver segments numerically', () => {
	assert.equal( isNewer( '0.1.25', '0.1.24' ), true );
	assert.equal( isNewer( '0.2.0', '0.1.99' ), true );
	assert.equal( isNewer( '1.0.0', '0.9.9' ), true );
	assert.equal( isNewer( '0.1.24', '0.1.24' ), false );
	assert.equal( isNewer( '0.1.23', '0.1.24' ), false );
	// numeric, not lexical: 10 > 9
	assert.equal( isNewer( '0.1.10', '0.1.9' ), true );
} );

test( 'getLatestVersion returns trimmed stdout on success', async () => {
	const { result, stub } = await withStub(
		( cmd, args ) => ( isNpmView( cmd, args ) ? { code: 0, stdout: '0.1.30\n', stderr: '' } : null ),
		() => getLatestVersion( PKG_NAME )
	);
	assert.equal( result, '0.1.30' );
	assert.ok( isNpmView( stub.calls[ 0 ].cmd, stub.calls[ 0 ].args ) );
	assert.equal( stub.calls[ 0 ].args[ 1 ], PKG_NAME );
} );

test( 'getLatestVersion returns null when npm fails (offline/timeout)', async () => {
	const { result } = await withStub(
		() => ( { code: 1, stdout: '', stderr: 'npm ERR! network' } ),
		() => getLatestVersion( PKG_NAME )
	);
	assert.equal( result, null );
} );

test( 'checkForUpdate: hasUpdate=true when latest is newer', async () => {
	const { result } = await withStub(
		( cmd, args ) => ( isNpmView( cmd, args ) ? { code: 0, stdout: '0.1.30', stderr: '' } : null ),
		() => checkForUpdate( { currentVersion: '0.1.25' } )
	);
	assert.deepEqual( result, { checked: true, current: '0.1.25', latest: '0.1.30', hasUpdate: true } );
} );

test( 'checkForUpdate: hasUpdate=false when already current', async () => {
	const { result } = await withStub(
		( cmd, args ) => ( isNpmView( cmd, args ) ? { code: 0, stdout: '0.1.25', stderr: '' } : null ),
		() => checkForUpdate( { currentVersion: '0.1.25' } )
	);
	assert.equal( result.checked, true );
	assert.equal( result.hasUpdate, false );
} );

test( 'checkForUpdate: checked=false when npm unreachable', async () => {
	const { result } = await withStub(
		() => ( { code: -1, stdout: '', stderr: 'spawn npm ENOENT' } ),
		() => checkForUpdate( { currentVersion: '0.1.25' } )
	);
	assert.deepEqual( result, { checked: false, current: '0.1.25', latest: null, hasUpdate: false } );
} );

test( 'performSelfUpdate: ok=true and installs name@latest', async () => {
	const { result, stub } = await withStub(
		() => ( { code: 0, stdout: '', stderr: '' } ),
		() => performSelfUpdate()
	);
	assert.equal( result.ok, true );
	assert.equal( result.error, null );
	assert.ok( isNpmInstall( stub.calls[ 0 ].cmd, stub.calls[ 0 ].args ) );
	assert.equal( stub.calls[ 0 ].args[ 2 ], `${ PKG_NAME }@latest` );
} );

test( 'performSelfUpdate: ok=false carries the error on failure', async () => {
	const { result } = await withStub(
		() => ( { code: 1, stdout: '', stderr: 'EACCES: permission denied' } ),
		() => performSelfUpdate()
	);
	assert.equal( result.ok, false );
	assert.equal( result.error, 'EACCES: permission denied' );
} );
