import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ensureMuPluginOnSsh, _internals } from '../src/lib/ssh-mu-plugin-installer.mjs';

const REPO_URL = 'https://github.com/Mikeekb/wp-mcp-abilities.git';
const SLUG = 'seomi-mcp-abilities';
const WP_ROOT = '/home/u/site/public_html';
const TARGET_DIR = `${ WP_ROOT }/wp-content/mu-plugins/${ SLUG }`;
const LOADER_PATH = `${ WP_ROOT }/wp-content/mu-plugins/mcp-abilities.php`;
const LOADER_CONTENT = `<?php
defined( 'ABSPATH' ) || exit;
if ( defined( 'SEOMI_MCP_VERSION' ) ) return;
$f = __DIR__ . '/${ SLUG }/${ SLUG }.php';
if ( is_readable( $f ) ) require_once $f;
`;

function makeStub( router ) {
	const calls = [];
	const fn = async ( cmd, args, opts = {} ) => {
		calls.push( { cmd, args, opts } );
		return router( cmd, args, opts ) || { code: 0, stdout: '', stderr: '' };
	};
	fn.calls = calls;
	return fn;
}

function isProbeCall( cmd, args ) {
	return cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a.startsWith( 'test -d ' ) );
}
function isCloneCall( cmd, args ) {
	return cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a.includes( 'git clone' ) );
}
function isLoaderCall( cmd, args ) {
	return cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a.startsWith( 'cat > ' ) );
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

function baseCfg( overrides = {} ) {
	return {
		sshHost: 'newbeone.beget.tech',
		sshUser: 'newbeone',
		sshPort: '',
		wpRoot: WP_ROOT,
		repoUrl: REPO_URL,
		slug: SLUG,
		loaderContent: LOADER_CONTENT,
		...overrides,
	};
}

test( 'returns already-present when probe exits 0; clone and loader are not invoked', async () => {
	const { result, stub } = await withStub( ( cmd, args ) => {
		if ( isProbeCall( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureMuPluginOnSsh( baseCfg() ) );

	assert.equal( result.action, 'already-present' );
	assert.ok( ! stub.calls.some( ( c ) => isCloneCall( c.cmd, c.args ) ), 'clone must not be called' );
	assert.ok( ! stub.calls.some( ( c ) => isLoaderCall( c.cmd, c.args ) ), 'loader must not be called' );
	assert.equal( stub.calls.length, 1, 'only probe should run' );
} );

test( 'happy path: probe=1, clone=0, loader=0 → installed, all three calls in order', async () => {
	const { result, stub } = await withStub( ( cmd, args ) => {
		if ( isProbeCall( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
		if ( isCloneCall( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
		if ( isLoaderCall( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureMuPluginOnSsh( baseCfg() ) );

	assert.equal( result.action, 'installed' );
	assert.equal( stub.calls.length, 3 );
	assert.ok( isProbeCall( stub.calls[ 0 ].cmd, stub.calls[ 0 ].args ) );
	assert.ok( isCloneCall( stub.calls[ 1 ].cmd, stub.calls[ 1 ].args ) );
	assert.ok( isLoaderCall( stub.calls[ 2 ].cmd, stub.calls[ 2 ].args ) );
} );

test( 'clone failure (exit 128) → failed + manualSnippet contains git clone hint', async () => {
	const { result, stub } = await withStub( ( cmd, args ) => {
		if ( isProbeCall( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
		if ( isCloneCall( cmd, args ) ) return { code: 128, stdout: '', stderr: 'fatal: unable to access' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureMuPluginOnSsh( baseCfg() ) );

	assert.equal( result.action, 'failed' );
	assert.ok( typeof result.manualSnippet === 'string' && result.manualSnippet.length > 0 );
	assert.ok( result.manualSnippet.includes( 'git clone' ), 'snippet must include git clone command' );
	assert.ok( result.manualSnippet.includes( TARGET_DIR ), 'snippet must mention target dir' );
	assert.ok( ! stub.calls.some( ( c ) => isLoaderCall( c.cmd, c.args ) ), 'loader must not run after clone failure' );
} );

test( 'loader write failure → partial + manualSnippet contains loader contents and path', async () => {
	const { result } = await withStub( ( cmd, args ) => {
		if ( isProbeCall( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
		if ( isCloneCall( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
		if ( isLoaderCall( cmd, args ) ) return { code: 1, stdout: '', stderr: 'permission denied' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureMuPluginOnSsh( baseCfg() ) );

	assert.equal( result.action, 'partial' );
	assert.ok( typeof result.manualSnippet === 'string' && result.manualSnippet.length > 0 );
	assert.ok( result.manualSnippet.includes( LOADER_PATH ), 'snippet must mention loader path' );
	assert.ok( result.manualSnippet.includes( 'SEOMI_MCP_VERSION' ), 'snippet must include the PHP shim body' );
} );

test( 'sshPort=2222 propagates as -p 2222 to all three ssh calls', async () => {
	const { stub } = await withStub( ( cmd, args ) => {
		if ( isProbeCall( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
		if ( isCloneCall( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
		if ( isLoaderCall( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureMuPluginOnSsh( baseCfg( { sshPort: '2222' } ) ) );

	assert.equal( stub.calls.length, 3 );
	for ( const c of stub.calls ) {
		assert.ok( c.args.includes( '-p' ) && c.args.includes( '2222' ), `${ c.args.join( ' ' ) } must include -p 2222` );
	}
} );

test( 'loader call receives opts.input = loaderContent', async () => {
	const { stub } = await withStub( ( cmd, args ) => {
		if ( isProbeCall( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
		if ( isCloneCall( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
		if ( isLoaderCall( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureMuPluginOnSsh( baseCfg() ) );

	const loaderCall = stub.calls.find( ( c ) => isLoaderCall( c.cmd, c.args ) );
	assert.ok( loaderCall, 'loader call must be present' );
	assert.equal( loaderCall.opts.input, LOADER_CONTENT );
} );

test( 'probe exit > 1 (e.g. 255 ssh connect error) → failed + manualSnippet, no clone/loader', async () => {
	const { result, stub } = await withStub( ( cmd, args ) => {
		if ( isProbeCall( cmd, args ) ) return { code: 255, stdout: '', stderr: 'ssh: connect to host ... port 22: Connection refused' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureMuPluginOnSsh( baseCfg() ) );

	assert.equal( result.action, 'failed' );
	assert.ok( typeof result.manualSnippet === 'string' && result.manualSnippet.length > 0 );
	assert.ok( ! stub.calls.some( ( c ) => isCloneCall( c.cmd, c.args ) ), 'clone must not run after probe ssh failure' );
	assert.ok( ! stub.calls.some( ( c ) => isLoaderCall( c.cmd, c.args ) ), 'loader must not run after probe ssh failure' );
} );
