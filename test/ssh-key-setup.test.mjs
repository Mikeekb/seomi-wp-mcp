import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSshKey, _internals } from '../src/lib/ssh-key-setup.mjs';

const FAKE_PUB = 'ssh-ed25519 AAAATESTKEYDATA test@host';

async function tmp() {
	return mkdtemp( join( tmpdir(), 'seomi-wp-mcp-ssh-' ) );
}

/**
 * Wrap a router fn in a recording stub. Each call gets logged on .calls;
 * the router decides the response based on (cmd, args, opts).
 */
function makeStub( router ) {
	const calls = [];
	const fn = async ( cmd, args, opts = {} ) => {
		calls.push( { cmd, args, opts } );
		return router( cmd, args, opts ) || { code: 0, stdout: '', stderr: '' };
	};
	fn.calls = calls;
	return fn;
}

function isKeygenCall( cmd ) { return cmd === 'ssh-keygen'; }
function isCopyIdCall( cmd ) { return cmd === 'ssh-copy-id'; }
function isVerifyCall( cmd, args ) {
	return cmd === 'ssh' && args.includes( 'BatchMode=yes' );
}
function isFallbackCopyCall( cmd, args ) {
	return cmd === 'ssh' && ! args.includes( 'BatchMode=yes' );
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

test( 'reuses existing key when keyPath already present', async () => {
	const dir = await tmp();
	const keyPath = join( dir, 'id_ed25519' );
	await writeFile( keyPath, 'PRIVATE KEY MATERIAL', 'utf8' );
	await writeFile( keyPath + '.pub', FAKE_PUB, 'utf8' );

	const { result, stub } = await withStub( ( cmd, args ) => {
		if ( isCopyIdCall( cmd ) ) return { code: 0, stdout: '', stderr: '' };
		if ( isVerifyCall( cmd, args ) ) return { code: 0, stdout: 'ok\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureSshKey( { sshHost: 'h', sshUser: 'u', sshPort: '22', keyPath } ) );

	assert.equal( result.keygenAction, 'reused' );
	assert.equal( result.copyAction, 'ssh-copy-id' );
	assert.equal( result.verified, true );
	assert.equal( result.manualHint, null );
	assert.equal( result.pubKeyContent, FAKE_PUB );
	assert.ok( ! stub.calls.some( ( c ) => isKeygenCall( c.cmd ) ), 'ssh-keygen must not be called on reuse' );

	await rm( dir, { recursive: true, force: true } );
} );

test( 'generates new key when keyPath missing', async () => {
	const dir = await tmp();
	const keyPath = join( dir, 'id_ed25519' );

	const { result, stub } = await withStub( async ( cmd, args ) => {
		if ( isKeygenCall( cmd ) ) {
			// Simulate ssh-keygen: write both files.
			await writeFile( keyPath, 'NEW PRIVATE', 'utf8' );
			await writeFile( keyPath + '.pub', FAKE_PUB, 'utf8' );
			return { code: 0, stdout: '', stderr: '' };
		}
		if ( isCopyIdCall( cmd ) ) return { code: 0, stdout: '', stderr: '' };
		if ( isVerifyCall( cmd, args ) ) return { code: 0, stdout: 'ok\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureSshKey( { sshHost: 'h', sshUser: 'u', sshPort: '', keyPath } ) );

	assert.equal( result.keygenAction, 'created' );
	assert.ok( existsSync( keyPath ), 'private key file should exist after keygen' );
	assert.ok( existsSync( keyPath + '.pub' ), 'pub key file should exist after keygen' );
	const keygenCall = stub.calls.find( ( c ) => isKeygenCall( c.cmd ) );
	assert.ok( keygenCall, 'ssh-keygen must have been called' );
	assert.ok( keygenCall.args.includes( '-t' ) && keygenCall.args.includes( 'ed25519' ) );
	assert.ok( keygenCall.args.includes( '-N' ) );
	assert.ok( keygenCall.args.includes( keyPath ) );

	await rm( dir, { recursive: true, force: true } );
} );

test( 'happy path: ssh-copy-id + verify both succeed', async () => {
	const dir = await tmp();
	const keyPath = join( dir, 'id_ed25519' );
	await writeFile( keyPath, 'PRIV', 'utf8' );
	await writeFile( keyPath + '.pub', FAKE_PUB, 'utf8' );

	const { result, stub } = await withStub( ( cmd, args ) => {
		if ( isCopyIdCall( cmd ) ) return { code: 0, stdout: '', stderr: '' };
		if ( isVerifyCall( cmd, args ) ) return { code: 0, stdout: 'ok\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureSshKey( { sshHost: 'h', sshUser: 'u', sshPort: '22', keyPath } ) );

	assert.equal( result.copyAction, 'ssh-copy-id' );
	assert.equal( result.verified, true );
	assert.equal( result.manualHint, null );
	// ssh-copy-id must be called with interactive stdio.
	const copyCall = stub.calls.find( ( c ) => isCopyIdCall( c.cmd ) );
	assert.equal( copyCall.opts.interactive, true );

	await rm( dir, { recursive: true, force: true } );
} );

test( 'falls back to ssh-pipe when ssh-copy-id is missing', async () => {
	const dir = await tmp();
	const keyPath = join( dir, 'id_ed25519' );
	await writeFile( keyPath, 'PRIV', 'utf8' );
	await writeFile( keyPath + '.pub', FAKE_PUB, 'utf8' );

	const { result, stub } = await withStub( ( cmd, args ) => {
		if ( isCopyIdCall( cmd ) ) return { code: -1, stdout: '', stderr: 'ENOENT' };
		if ( isFallbackCopyCall( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
		if ( isVerifyCall( cmd, args ) ) return { code: 0, stdout: 'ok\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureSshKey( { sshHost: 'h', sshUser: 'u', sshPort: '2222', keyPath } ) );

	assert.equal( result.copyAction, 'ssh-fallback' );
	assert.equal( result.verified, true );
	const fbCall = stub.calls.find( ( c ) => isFallbackCopyCall( c.cmd, c.args ) );
	assert.ok( fbCall, 'fallback ssh call must happen' );
	// Pub key piped via stdin
	assert.ok( typeof fbCall.opts.input === 'string' && fbCall.opts.input.includes( FAKE_PUB ) );
	// Port flag propagated
	assert.ok( fbCall.args.includes( '-p' ) && fbCall.args.includes( '2222' ) );

	await rm( dir, { recursive: true, force: true } );
} );

test( 'reports verified=false with manual hint when verify fails after copy', async () => {
	const dir = await tmp();
	const keyPath = join( dir, 'id_ed25519' );
	await writeFile( keyPath, 'PRIV', 'utf8' );
	await writeFile( keyPath + '.pub', FAKE_PUB, 'utf8' );

	const { result } = await withStub( ( cmd, args ) => {
		if ( isCopyIdCall( cmd ) ) return { code: 0, stdout: '', stderr: '' };
		if ( isVerifyCall( cmd, args ) ) return { code: 1, stdout: '', stderr: 'Permission denied (publickey)' };
		return { code: 0, stdout: '', stderr: '' };
	}, () => ensureSshKey( { sshHost: 'h', sshUser: 'u', sshPort: '', keyPath } ) );

	assert.equal( result.verified, false );
	assert.ok( typeof result.manualHint === 'string' && result.manualHint.length > 0 );
	assert.ok( result.manualHint.includes( FAKE_PUB ), 'hint must contain the public key content' );
	assert.ok( /панель|panel/i.test( result.manualHint ), 'hint should mention the hosting control panel' );
} );

test( 'keygen failure throws a clear error', async () => {
	const dir = await tmp();
	const keyPath = join( dir, 'id_ed25519' );

	const original = _internals.exec;
	_internals.exec = makeStub( ( cmd ) => {
		if ( isKeygenCall( cmd ) ) return { code: -1, stdout: '', stderr: 'spawn ssh-keygen ENOENT' };
		return { code: 0, stdout: '', stderr: '' };
	} );

	try {
		await assert.rejects(
			ensureSshKey( { sshHost: 'h', sshUser: 'u', sshPort: '', keyPath } ),
			( err ) => err instanceof Error && /ssh-keygen/i.test( err.message ),
		);
	} finally {
		_internals.exec = original;
		await rm( dir, { recursive: true, force: true } );
	}
} );
