import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFullLocalWp } from '../src/lib/wp-local-detector.mjs';

async function tmp() {
	return mkdtemp( join( tmpdir(), 'seomi-wp-mcp-wpdet-' ) );
}

async function makeWpAdmin( dir ) {
	await mkdir( join( dir, 'wp-admin' ), { recursive: true } );
}
async function makeWpIncludes( dir ) {
	await mkdir( join( dir, 'wp-includes' ), { recursive: true } );
}
async function makeWpConfig( dir ) {
	await writeFile( join( dir, 'wp-config.php' ), '<?php // test\n', 'utf8' );
}

test( 'detectFullLocalWp: full install — all three present', async () => {
	const dir = await tmp();
	try {
		await makeWpAdmin( dir );
		await makeWpIncludes( dir );
		await makeWpConfig( dir );
		const r = detectFullLocalWp( dir );
		assert.equal( r.isFullLocalWp, true );
		assert.equal( r.missing.length, 0 );
		assert.deepEqual(
			r.foundDirs.sort(),
			[ 'wp-admin', 'wp-config.php', 'wp-includes' ],
		);
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectFullLocalWp: only wp-content (theme repo case) — false', async () => {
	const dir = await tmp();
	try {
		await mkdir( join( dir, 'wp-content' ), { recursive: true } );
		const r = detectFullLocalWp( dir );
		assert.equal( r.isFullLocalWp, false );
		assert.deepEqual(
			r.missing.sort(),
			[ 'wp-admin', 'wp-config.php', 'wp-includes' ],
		);
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectFullLocalWp: wp-admin + wp-includes but no wp-config.php — false', async () => {
	const dir = await tmp();
	try {
		await makeWpAdmin( dir );
		await makeWpIncludes( dir );
		const r = detectFullLocalWp( dir );
		assert.equal( r.isFullLocalWp, false );
		assert.deepEqual( r.missing, [ 'wp-config.php' ] );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectFullLocalWp: wp-config.php but no wp-admin — false', async () => {
	const dir = await tmp();
	try {
		await makeWpConfig( dir );
		await makeWpIncludes( dir );
		const r = detectFullLocalWp( dir );
		assert.equal( r.isFullLocalWp, false );
		assert.deepEqual( r.missing, [ 'wp-admin' ] );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectFullLocalWp: empty directory — false, three missing', async () => {
	const dir = await tmp();
	try {
		const r = detectFullLocalWp( dir );
		assert.equal( r.isFullLocalWp, false );
		assert.equal( r.missing.length, 3 );
		assert.equal( r.foundDirs.length, 0 );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectFullLocalWp: wp-admin is a FILE, not a directory — counted as missing', async () => {
	const dir = await tmp();
	try {
		// Edge case: someone has a file named wp-admin (very weird, but be safe).
		await writeFile( join( dir, 'wp-admin' ), 'not a dir', 'utf8' );
		await makeWpIncludes( dir );
		await makeWpConfig( dir );
		const r = detectFullLocalWp( dir );
		assert.equal( r.isFullLocalWp, false );
		assert.deepEqual( r.missing, [ 'wp-admin' ] );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );
