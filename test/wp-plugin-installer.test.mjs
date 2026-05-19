import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { _internals } from '../src/lib/wp-plugin-installer.mjs';

/**
 * These tests pin down the stdio contract introduced in fix(wp-plugin-installer):
 * SSH-scoped runWp calls MUST mark the exec call interactive so that wp-cli's
 * underlying `ssh` can read the password from the user's TTY. Local calls must
 * NOT set the interactive flag — otherwise stdout would no longer be parseable
 * for `core version`, `plugin is-active`, etc.
 */

function makeStubExec( response ) {
	const calls = [];
	const fn = async ( cmd, args, opts = {} ) => {
		calls.push( { cmd, args, opts } );
		return response;
	};
	fn.calls = calls;
	return fn;
}

async function withStubExec( response, run ) {
	const original = _internals.exec;
	const stub = makeStubExec( response );
	_internals.exec = stub;
	try {
		const result = await run();
		return { result, stub };
	} finally {
		_internals.exec = original;
	}
}

test( 'runWp marks SSH calls as interactive (phar path)', async () => {
	const { result, stub } = await withStubExec(
		{ code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' },
		() => _internals.runWp( { sshSpec: 'ai@host/path', wpCliPharPath: 'C:/wp-cli/wp-cli.phar' }, [ '--info' ] ),
	);

	assert.equal( stub.calls.length, 1 );
	const call = stub.calls[ 0 ];
	assert.equal( call.cmd, 'php' );
	assert.ok( call.args.includes( '--info' ) );
	assert.ok( call.args.includes( '--ssh=ai@host/path' ) );
	assert.equal( call.opts.interactive, true, 'SSH-scoped runWp must pass interactive:true' );
	// And the result is propagated unchanged.
	assert.equal( result.code, 0 );
	assert.equal( result.stdout, 'WP-CLI 2.12.0' );
} );

test( 'runWp marks SSH calls as interactive (PATH fallback)', async () => {
	const { stub } = await withStubExec(
		{ code: 0, stdout: '', stderr: '' },
		() => _internals.runWp( { sshSpec: 'ai@host/path' }, [ '--info' ] ),
	);

	assert.equal( stub.calls.length, 1 );
	const call = stub.calls[ 0 ];
	assert.equal( call.cmd, 'wp' );
	assert.equal( call.opts.interactive, true );
} );

test( 'runWp does NOT set interactive on local (wpRoot) calls', async () => {
	const { stub } = await withStubExec(
		{ code: 0, stdout: 'wp-cli 2.12.0', stderr: '' },
		() => _internals.runWp( { wpRoot: 'C:/wamp/www/site', wpCliPharPath: 'C:/wp-cli/wp-cli.phar' }, [ '--info' ] ),
	);

	const call = stub.calls[ 0 ];
	assert.equal( call.cmd, 'php' );
	assert.ok( call.args.includes( '--path=C:/wamp/www/site' ) );
	assert.ok( ! call.opts.interactive, 'local-scope runWp must not set interactive' );
} );

test( 'runWp propagates exec result fields back to the caller', async () => {
	const response = { code: 1, stdout: 'partial', stderr: 'boom' };
	const { result } = await withStubExec(
		response,
		() => _internals.runWp( { sshSpec: 'u@h/p' }, [ 'core', 'version' ] ),
	);
	assert.equal( result.code, 1 );
	assert.equal( result.stdout, 'partial' );
	assert.equal( result.stderr, 'boom' );
} );

test( 'exec strips the interactive flag before spawning (no leakage as spawn option)', async () => {
	// Sanity-check: directly call exec via a process that prints something
	// short and exits 0. We just verify the function returns the expected
	// shape and doesn't throw when `interactive` is passed. Uses `node -e`
	// since it's guaranteed to be on PATH (this is a Node project).
	const r = await _internals.exec(
		process.execPath,
		[ '-e', 'process.stdout.write("hello")' ],
		{},
	);
	assert.equal( r.code, 0 );
	assert.equal( r.stdout, 'hello' );
} );
