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

test( 'insertOrUpdate stays single-block when content itself mentions markers', async () => {
	// Regression: older non-greedy regex matched only up to the FIRST inline
	// `:end` mention inside the block body, leaving the real end as orphan
	// content and accumulating duplicates on every re-run.
	const dir = await tmp();
	const path = join( dir, 'CLAUDE.md' );
	const content = [
		'Managed body that mentions the markers in prose:',
		'`<!-- seomi-wp-mcp:start -->` and `<!-- seomi-wp-mcp:end -->` — CLI-managed.',
		'Trailing sentence after the inline mentions.',
	].join( '\n' );

	for ( let i = 0; i < 5; i++ ) {
		await insertOrUpdate( path, content );
	}

	const text = await readFile( path, 'utf8' );
	// Exactly one REAL opening marker (at the start of a line) and one closing.
	const realStarts = text.match( /^<!-- seomi-wp-mcp:start -->$/gm ) || [];
	const realEnds = text.match( /^<!-- seomi-wp-mcp:end -->$/gm ) || [];
	assert.equal( realStarts.length, 1, 'should be exactly one opening marker line' );
	assert.equal( realEnds.length, 1, 'should be exactly one closing marker line' );
	// The trailing sentence appears once — body is not duplicated.
	const trailing = text.match( /Trailing sentence after the inline mentions\./g ) || [];
	assert.equal( trailing.length, 1, 'body content should appear exactly once' );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'insertOrUpdate keeps AGENTS.md and CLAUDE.md state independent in the same dir', async () => {
	// Multi-target scenario: init now writes the managed block into BOTH files
	// when both exist. Each call must touch only its own file and leave the
	// other untouched.
	const dir = await tmp();
	const agentsPath = join( dir, 'AGENTS.md' );
	const claudePath = join( dir, 'CLAUDE.md' );
	await writeFile( agentsPath, '# AGENTS map\n\nExisting agents prose.\n', 'utf8' );
	await writeFile( claudePath, '# Claude config\n\nExisting claude prose.\n', 'utf8' );

	const block = 'MANAGED block content';

	const r1 = await insertOrUpdate( agentsPath, block );
	const r2 = await insertOrUpdate( claudePath, block );
	assert.equal( r1.action, 'appended' );
	assert.equal( r2.action, 'appended' );

	const agentsText = await readFile( agentsPath, 'utf8' );
	const claudeText = await readFile( claudePath, 'utf8' );
	assert.ok( agentsText.includes( 'Existing agents prose.' ) );
	assert.ok( agentsText.includes( block ) );
	assert.ok( ! agentsText.includes( 'Existing claude prose.' ) );
	assert.ok( claudeText.includes( 'Existing claude prose.' ) );
	assert.ok( claudeText.includes( block ) );
	assert.ok( ! claudeText.includes( 'Existing agents prose.' ) );

	// Second round on the same dir — both must be `unchanged`, no duplication.
	const r1b = await insertOrUpdate( agentsPath, block );
	const r2b = await insertOrUpdate( claudePath, block );
	assert.equal( r1b.action, 'unchanged' );
	assert.equal( r2b.action, 'unchanged' );

	// Marker count stays exactly one in each file.
	const agentsAfter = await readFile( agentsPath, 'utf8' );
	const claudeAfter = await readFile( claudePath, 'utf8' );
	assert.equal( ( agentsAfter.match( /<!-- seomi-wp-mcp:start -->/g ) || [] ).length, 1 );
	assert.equal( ( claudeAfter.match( /<!-- seomi-wp-mcp:start -->/g ) || [] ).length, 1 );

	await rm( dir, { recursive: true, force: true } );
} );

test( 'insertOrUpdate heals a file previously corrupted by non-greedy matching', async () => {
	const dir = await tmp();
	const path = join( dir, 'CLAUDE.md' );
	// Simulate the corruption produced by older versions: multiple orphan
	// start/end markers + leftover tail content scattered around.
	const corrupted = [
		'# Top of file',
		'',
		'<!-- seomi-wp-mcp:start -->',
		'Old block 1 body',
		'<!-- seomi-wp-mcp:end -->',
		'orphan tail 1',
		'<!-- seomi-wp-mcp:end -->',
		'',
		'<!-- seomi-wp-mcp:start -->',
		'Old block 2 body',
		'<!-- seomi-wp-mcp:end -->',
		'',
		'# Bottom',
		'',
	].join( '\n' );
	await writeFile( path, corrupted, 'utf8' );

	await insertOrUpdate( path, 'CLEAN BODY' );

	const text = await readFile( path, 'utf8' );
	const realStarts = text.match( /<!-- seomi-wp-mcp:start -->/g ) || [];
	const realEnds = text.match( /<!-- seomi-wp-mcp:end -->/g ) || [];
	assert.equal( realStarts.length, 1, 'corruption should collapse into one start marker' );
	assert.equal( realEnds.length, 1, 'corruption should collapse into one end marker' );
	assert.ok( text.includes( 'CLEAN BODY' ) );
	assert.ok( ! text.includes( 'Old block 1' ) );
	assert.ok( ! text.includes( 'Old block 2' ) );
	assert.ok( ! text.includes( 'orphan tail' ) );
	assert.ok( text.includes( '# Top' ) );
	assert.ok( text.includes( '# Bottom' ) );
	await rm( dir, { recursive: true, force: true } );
} );
