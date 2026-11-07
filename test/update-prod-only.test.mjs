import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	updateCommand,
	isProdOnlyEnv,
	resolveMuPluginPlan,
	prodMuPluginHint,
} from '../src/commands/update.mjs';

/**
 * `update` in a prod-only project (init answered "no local, yes production"):
 * there is no local mu-plugin, so it must skip that step instead of failing,
 * and still regenerate skills + the managed block. A project with neither a
 * local mu-plugin nor prod config is a broken install and still fails.
 */

const PROD_ENV = [
	'WP_PROD_URL=https://example.com',
	'WP_PROD_USER=ai-agent',
	'WP_PROD_APP_PASSWORD=xxxx',
	'WP_PROD_MCP_SERVER=wordpress-prod',
	'WP_PROD_SSH_HOST=example.com',
	'WP_PROD_SSH_USER=deploy',
	'WP_PROD_WP_ROOT=/var/www/site',
	'',
].join( '\n' );

const LOCAL_ENV = [
	'WP_LOCAL_URL=https://site.test',
	'WP_LOCAL_USER=ai-agent',
	'WP_LOCAL_APP_PASSWORD=xxxx',
	'WP_LOCAL_MCP_SERVER=wordpress-local',
	'',
].join( '\n' );

const OLD_BLOCK = '# Project\n\n<!-- seomi-wp-mcp:start -->\nOLD BLOCK\n<!-- seomi-wp-mcp:end -->\n';

async function makeProject( { env } = {} ) {
	const dir = await mkdtemp( join( tmpdir(), 'seomi-update-prod-only-' ) );
	await mkdir( join( dir, '.claude' ), { recursive: true } );
	if ( env !== undefined ) await writeFile( join( dir, '.claude', '.env' ), env, 'utf8' );
	await writeFile( join( dir, 'AGENTS.md' ), OLD_BLOCK, 'utf8' );
	return dir;
}

async function runUpdateIn( dir ) {
	const prevCwd = process.cwd();
	const prevCfg = process.env.CLAUDE_CONFIG_DIR;
	// Empty global skills dir — keep the user's ~/.claude/skills out of the run.
	process.env.CLAUDE_CONFIG_DIR = join( dir, '.no-global' );
	process.chdir( dir );
	try {
		return await updateCommand( { 'self-update': false, 'no-metrika': true } );
	} finally {
		process.chdir( prevCwd );
		if ( prevCfg === undefined ) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = prevCfg;
	}
}

// ---------- pure decision ----------

test( 'isProdOnlyEnv: WP_PROD_* without WP_LOCAL_URL → true', () => {
	assert.equal( isProdOnlyEnv( { WP_PROD_URL: 'https://x' } ), true );
	assert.equal( isProdOnlyEnv( { WP_PROD_MCP_SERVER: 'wordpress-prod' } ), true );
	assert.equal( isProdOnlyEnv( { WP_PROD_SSH_HOST: 'x' } ), true );
} );

test( 'isProdOnlyEnv: local present, or nothing → false', () => {
	assert.equal( isProdOnlyEnv( { WP_LOCAL_URL: 'https://l', WP_PROD_URL: 'https://p' } ), false );
	assert.equal( isProdOnlyEnv( { WP_LOCAL_URL: 'https://l' } ), false );
	assert.equal( isProdOnlyEnv( {} ), false );
	assert.equal( isProdOnlyEnv( { WP_PROD_URL: '  ' } ), false );
} );

test( 'resolveMuPluginPlan: a local connection is always refreshed (local / both unchanged)', () => {
	for ( const mode of [ 'submodule', 'composer', 'copy' ] ) {
		assert.equal( resolveMuPluginPlan( mode, {} ), 'local' );
		assert.equal( resolveMuPluginPlan( mode, { WP_LOCAL_URL: 'https://l' } ), 'local' );
		assert.equal( resolveMuPluginPlan( mode, { WP_LOCAL_URL: 'https://l', WP_PROD_URL: 'https://p' } ), 'local' );
		assert.equal( resolveMuPluginPlan( mode, { WP_PROD_URL: 'https://p' } ), 'local' );
	}
} );

test( 'resolveMuPluginPlan: none + prod-only → prod-only; none otherwise → broken', () => {
	assert.equal( resolveMuPluginPlan( 'none', { WP_PROD_URL: 'https://p' } ), 'prod-only' );
	assert.equal( resolveMuPluginPlan( 'none', {} ), 'broken' );
	assert.equal( resolveMuPluginPlan( 'none', { WP_LOCAL_URL: 'https://l' } ), 'broken' );
	assert.equal( resolveMuPluginPlan( 'none', { WP_LOCAL_URL: 'https://l', WP_PROD_URL: 'https://p' } ), 'broken' );
} );

test( 'prodMuPluginHint: ssh re-clone command built from WP_PROD_SSH_*', () => {
	const hint = prodMuPluginHint( { WP_PROD_SSH_HOST: 'h.example', WP_PROD_SSH_USER: 'deploy', WP_PROD_SSH_PORT: '2222', WP_PROD_WP_ROOT: '/www' } );
	assert.match( hint, /ssh -p 2222 deploy@h\.example 'rm -rf \/www\/wp-content\/mu-plugins\/seomi-mcp-abilities && git clone --depth=1 / );
	const noSsh = prodMuPluginHint( { WP_PROD_URL: 'https://p' } );
	assert.doesNotMatch( noSsh, /ssh / );
	assert.match( noSsh, /manually/ );
} );

// ---------- updateCommand end-to-end ----------

test( 'update: prod-only project regenerates block + skills and exits 0', async () => {
	const dir = await makeProject( { env: PROD_ENV } );
	const code = await runUpdateIn( dir );
	assert.equal( code, 0 );

	const agents = await readFile( join( dir, 'AGENTS.md' ), 'utf8' );
	assert.doesNotMatch( agents, /OLD BLOCK/ );
	assert.match( agents, /<!-- seomi-wp-mcp:start -->/ );
	assert.match( agents, /wordpress-prod/ );
	assert.doesNotMatch( agents, /wordpress-local/ );
	assert.match( agents, /wp --ssh=deploy@example\.com\/var\/www\/site/ );

	assert.ok( existsSync( join( dir, '.claude', 'skills', 'aif-wp-mcp', 'SKILL.md' ) ), 'skills refreshed' );
	// No local mu-plugin was created or cloned.
	assert.equal( existsSync( join( dir, 'wp-content' ) ), false );
} );

test( 'update: none without prod config still fails and leaves the block alone', async () => {
	const dir = await makeProject( { env: '' } );
	const code = await runUpdateIn( dir );
	assert.equal( code, 1 );
	assert.equal( await readFile( join( dir, 'AGENTS.md' ), 'utf8' ), OLD_BLOCK );
	assert.equal( existsSync( join( dir, '.claude', 'skills' ) ), false );
} );

test( 'update: no .env at all still fails', async () => {
	const dir = await makeProject();
	assert.equal( await runUpdateIn( dir ), 1 );
	assert.equal( await readFile( join( dir, 'AGENTS.md' ), 'utf8' ), OLD_BLOCK );
} );

test( 'update: local config but missing mu-plugin still fails (broken local install)', async () => {
	const dir = await makeProject( { env: LOCAL_ENV + PROD_ENV } );
	assert.equal( await runUpdateIn( dir ), 1 );
	assert.equal( await readFile( join( dir, 'AGENTS.md' ), 'utf8' ), OLD_BLOCK );
} );
