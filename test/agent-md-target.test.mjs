import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	detectAgentMdTargets,
	ensureClaudeImportStub,
	isClaudeImportStub,
	DEFAULT_TARGET,
} from '../src/lib/agent-md-target.mjs';

async function tmp() {
	return mkdtemp( join( tmpdir(), 'seomi-wp-mcp-agentmd-' ) );
}

test( 'detects both AGENTS.md and CLAUDE.md when both exist', async () => {
	const dir = await tmp();
	await writeFile( join( dir, 'AGENTS.md' ), '# agents\n', 'utf8' );
	await writeFile( join( dir, 'CLAUDE.md' ), '# claude\n', 'utf8' );

	const res = await detectAgentMdTargets( { cwd: dir, interactive: false } );

	assert.equal( res.source, 'both' );
	assert.deepEqual( res.targets, [ join( dir, 'AGENTS.md' ), join( dir, 'CLAUDE.md' ) ] );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'detects AGENTS.md only', async () => {
	const dir = await tmp();
	await writeFile( join( dir, 'AGENTS.md' ), '# agents\n', 'utf8' );

	const res = await detectAgentMdTargets( { cwd: dir, interactive: false } );

	assert.equal( res.source, 'agents' );
	assert.deepEqual( res.targets, [ join( dir, 'AGENTS.md' ) ] );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'detects CLAUDE.md only', async () => {
	const dir = await tmp();
	await writeFile( join( dir, 'CLAUDE.md' ), '# claude\n', 'utf8' );

	const res = await detectAgentMdTargets( { cwd: dir, interactive: false } );

	assert.equal( res.source, 'claude' );
	assert.deepEqual( res.targets, [ join( dir, 'CLAUDE.md' ) ] );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'returns default AGENTS.md when neither exists and interactive=false', async () => {
	const dir = await tmp();

	const res = await detectAgentMdTargets( { cwd: dir, interactive: false } );

	assert.equal( res.source, 'default' );
	assert.equal( DEFAULT_TARGET, 'AGENTS.md' );
	assert.deepEqual( res.targets, [ join( dir, 'AGENTS.md' ) ] );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'returns the chosen file when neither exists and user picks AGENTS.md', async () => {
	const dir = await tmp();
	const res = await detectAgentMdTargets( {
		cwd: dir,
		interactive: true,
		_promptSelect: async () => 'AGENTS.md',
	} );

	assert.equal( res.source, 'user' );
	assert.deepEqual( res.targets, [ join( dir, 'AGENTS.md' ) ] );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'returns CLAUDE.md when neither exists and user picks CLAUDE.md', async () => {
	const dir = await tmp();
	const res = await detectAgentMdTargets( {
		cwd: dir,
		interactive: true,
		_promptSelect: async () => 'CLAUDE.md',
	} );

	assert.equal( res.source, 'user' );
	assert.deepEqual( res.targets, [ join( dir, 'CLAUDE.md' ) ] );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'returns empty targets when user picks skip', async () => {
	const dir = await tmp();
	const res = await detectAgentMdTargets( {
		cwd: dir,
		interactive: true,
		_promptSelect: async () => 'skip',
	} );

	assert.equal( res.source, 'skipped' );
	assert.deepEqual( res.targets, [] );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'respects custom defaultName when interactive=false and neither file exists', async () => {
	const dir = await tmp();
	const res = await detectAgentMdTargets( {
		cwd: dir,
		interactive: false,
		defaultName: 'CLAUDE.md',
	} );

	assert.equal( res.source, 'default' );
	assert.deepEqual( res.targets, [ join( dir, 'CLAUDE.md' ) ] );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'throws when cwd is missing', async () => {
	await assert.rejects( () => detectAgentMdTargets( {} ), /cwd.*required/i );
} );

test( 'ensureClaudeImportStub creates CLAUDE.md importing AGENTS.md when only AGENTS.md exists', async () => {
	const dir = await tmp();
	await writeFile( join( dir, 'AGENTS.md' ), '# agents\n', 'utf8' );

	const res = await ensureClaudeImportStub( { cwd: dir } );

	assert.equal( res.created, true );
	assert.equal( res.reason, 'created' );
	const text = await readFile( join( dir, 'CLAUDE.md' ), 'utf8' );
	assert.match( text, /^[ \t]*@AGENTS\.md[ \t]*$/m );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'ensureClaudeImportStub is a no-op when CLAUDE.md already exists (never overwrites)', async () => {
	const dir = await tmp();
	await writeFile( join( dir, 'AGENTS.md' ), '# agents\n', 'utf8' );
	await writeFile( join( dir, 'CLAUDE.md' ), '# my own claude\n', 'utf8' );

	const res = await ensureClaudeImportStub( { cwd: dir } );

	assert.equal( res.created, false );
	assert.equal( res.reason, 'claude-exists' );
	const text = await readFile( join( dir, 'CLAUDE.md' ), 'utf8' );
	assert.equal( text, '# my own claude\n' );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'ensureClaudeImportStub is a no-op when there is no AGENTS.md to import', async () => {
	const dir = await tmp();

	const res = await ensureClaudeImportStub( { cwd: dir } );

	assert.equal( res.created, false );
	assert.equal( res.reason, 'no-agents' );
	assert.equal( existsSync( join( dir, 'CLAUDE.md' ) ), false );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'ensureClaudeImportStub throws when cwd is missing', async () => {
	await assert.rejects( () => ensureClaudeImportStub( {} ), /cwd.*required/i );
} );

test( 'isClaudeImportStub recognizes a bare @AGENTS.md import', async () => {
	const dir = await tmp();
	await writeFile( join( dir, 'AGENTS.md' ), '# agents\n', 'utf8' );
	await ensureClaudeImportStub( { cwd: dir } );

	assert.equal( isClaudeImportStub( join( dir, 'CLAUDE.md' ) ), true );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'isClaudeImportStub returns false for a CLAUDE.md carrying a managed block', async () => {
	const dir = await tmp();
	await writeFile(
		join( dir, 'CLAUDE.md' ),
		'@AGENTS.md\n<!-- seomi-wp-mcp:start -->\nblock\n<!-- seomi-wp-mcp:end -->\n',
		'utf8',
	);

	assert.equal( isClaudeImportStub( join( dir, 'CLAUDE.md' ) ), false );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'isClaudeImportStub returns false when the file does not import AGENTS.md', async () => {
	const dir = await tmp();
	await writeFile( join( dir, 'CLAUDE.md' ), '# just instructions\n', 'utf8' );

	assert.equal( isClaudeImportStub( join( dir, 'CLAUDE.md' ) ), false );
	await rm( dir, { recursive: true, force: true } );
} );

test( 'isClaudeImportStub returns false when the file is absent', async () => {
	const dir = await tmp();

	assert.equal( isClaudeImportStub( join( dir, 'CLAUDE.md' ) ), false );
	await rm( dir, { recursive: true, force: true } );
} );
