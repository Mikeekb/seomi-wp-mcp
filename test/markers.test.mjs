import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertOrUpdate, removeBlock, hasBlock } from '../src/lib/markers.mjs';

async function tmp() {
	return mkdtemp( join( tmpdir(), 'seomi-wp-mcp-test-' ) );
}

test( 'insertOrUpdate creates file when missing', async () => {
	const dir = await tmp();
	const path = join( dir, 'CLAUDE.md' );
	const r = await insertOrUpdate( path, 'Hello world' );
	assert.equal( r.action, 'created' );
	const text = await readFile( path, 'utf8' );
	assert.ok( text.includes( '<!-- seomi-wp-mcp:start -->' ) );
	assert.ok( text.includes( 'Hello world' ) );
	assert.ok( text.includes( '<!-- seomi-wp-mcp:end -->' ) );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'insertOrUpdate appends to existing file without block', async () => {
	const dir = await tmp();
	const path = join( dir, 'CLAUDE.md' );
	await writeFile( path, '# Heading\n\nExisting paragraph.\n', 'utf8' );
	const r = await insertOrUpdate( path, 'Inserted content' );
	assert.equal( r.action, 'appended' );
	const text = await readFile( path, 'utf8' );
	assert.ok( text.includes( 'Existing paragraph.' ) );
	assert.ok( text.includes( 'Inserted content' ) );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'insertOrUpdate replaces existing block, preserves surrounding content', async () => {
	const dir = await tmp();
	const path = join( dir, 'CLAUDE.md' );
	const initial = `# Top\n\n<!-- seomi-wp-mcp:start -->\nOLD\n<!-- seomi-wp-mcp:end -->\n\n# Bottom\n`;
	await writeFile( path, initial, 'utf8' );
	const r = await insertOrUpdate( path, 'NEW' );
	assert.equal( r.action, 'updated' );
	const text = await readFile( path, 'utf8' );
	assert.ok( text.includes( '# Top' ) );
	assert.ok( text.includes( '# Bottom' ) );
	assert.ok( text.includes( 'NEW' ) );
	assert.ok( ! text.includes( 'OLD' ) );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'insertOrUpdate is idempotent for identical content', async () => {
	const dir = await tmp();
	const path = join( dir, 'CLAUDE.md' );
	await insertOrUpdate( path, 'Same' );
	const r = await insertOrUpdate( path, 'Same' );
	assert.equal( r.action, 'unchanged' );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'removeBlock strips block but keeps surroundings', async () => {
	const dir = await tmp();
	const path = join( dir, 'CLAUDE.md' );
	await writeFile( path, `Before\n<!-- seomi-wp-mcp:start -->\nX\n<!-- seomi-wp-mcp:end -->\nAfter\n`, 'utf8' );
	const r = await removeBlock( path );
	assert.equal( r.action, 'removed' );
	const text = await readFile( path, 'utf8' );
	assert.ok( text.includes( 'Before' ) );
	assert.ok( text.includes( 'After' ) );
	assert.ok( ! text.includes( 'seomi-wp-mcp:start' ) );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'hasBlock returns correct boolean', async () => {
	const dir = await tmp();
	const path = join( dir, 'CLAUDE.md' );
	await writeFile( path, 'No block here\n', 'utf8' );
	assert.equal( await hasBlock( path ), false );
	await insertOrUpdate( path, 'now' );
	assert.equal( await hasBlock( path ), true );
	await rm( dir, { recursive: true, force: true } );
} );
