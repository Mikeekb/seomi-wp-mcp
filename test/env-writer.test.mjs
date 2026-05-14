import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeEnv, parseEnv, serializeEnv } from '../src/lib/env-writer.mjs';

async function tmp() {
	return mkdtemp( join( tmpdir(), 'seomi-wp-mcp-env-' ) );
}

test( 'parseEnv recognizes kv, comment, blank, other', () => {
	const items = parseEnv( '# header\n\nFOO=bar\nweird line\nBAZ=qux\n' );
	const types = items.map( ( i ) => i.type );
	assert.deepEqual( types, [ 'comment', 'blank', 'kv', 'other', 'kv', 'blank' ] );
} );

test( 'serializeEnv round-trips parseEnv output', () => {
	const text = '# header\n\nFOO=bar\nBAZ=qux\n';
	const items = parseEnv( text );
	const out = serializeEnv( items );
	assert.equal( out + '\n', text + '\n' ); // serialize doesn't append trailing newline
} );

test( 'mergeEnv creates new file with all keys', async () => {
	const dir = await tmp();
	const path = join( dir, '.env' );
	const r = await mergeEnv( path, { FOO: 'bar', BAZ: 'qux' } );
	assert.equal( r.created, true );
	assert.deepEqual( r.added.sort(), [ 'BAZ', 'FOO' ] );
	const text = await readFile( path, 'utf8' );
	assert.ok( text.includes( 'FOO=bar' ) );
	assert.ok( text.includes( 'BAZ=qux' ) );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'mergeEnv updates existing key, preserves comments and unrelated keys', async () => {
	const dir = await tmp();
	const path = join( dir, '.env' );
	await writeFile( path, `# my header\nFOO=old\n\n# section\nOTHER_KEY=keep_me\n`, 'utf8' );
	const r = await mergeEnv( path, { FOO: 'new' } );
	assert.equal( r.created, false );
	assert.deepEqual( r.updated, [ 'FOO' ] );
	const text = await readFile( path, 'utf8' );
	assert.ok( text.includes( '# my header' ) );
	assert.ok( text.includes( '# section' ) );
	assert.ok( text.includes( 'OTHER_KEY=keep_me' ) );
	assert.ok( text.includes( 'FOO=new' ) );
	assert.ok( ! text.includes( 'FOO=old' ) );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'mergeEnv appends new keys after existing content', async () => {
	const dir = await tmp();
	const path = join( dir, '.env' );
	await writeFile( path, `EXISTING=yes\n`, 'utf8' );
	await mergeEnv( path, { NEW_KEY: 'value' } );
	const text = await readFile( path, 'utf8' );
	assert.ok( text.includes( 'EXISTING=yes' ) );
	assert.ok( text.includes( 'NEW_KEY=value' ) );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'mergeEnv is idempotent when nothing changes', async () => {
	const dir = await tmp();
	const path = join( dir, '.env' );
	await writeFile( path, `FOO=same\n`, 'utf8' );
	const r = await mergeEnv( path, { FOO: 'same' } );
	assert.deepEqual( r.unchanged, [ 'FOO' ] );
	assert.equal( r.updated.length, 0 );
	assert.equal( r.added.length, 0 );
	await rm( dir, { recursive: true, force: true } );
} );
