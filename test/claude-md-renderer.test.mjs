/**
 * Regression test for the prod-only "undefined" bug.
 *
 * Before this renderer existed, `init.mjs` did
 *   .replaceAll('{{WP_LOCAL_MCP_SERVER}}', env.WP_LOCAL_MCP_SERVER)
 * on the template. For prod-only setups `env.WP_LOCAL_MCP_SERVER` is undefined,
 * and JS replaceAll stringifies that to the literal "undefined" — agents then
 * saw `mcp__undefined__mcp-adapter-discover-abilities` in CLAUDE.md and wandered
 * off into ~/.ssh/config looking for SSH details. These tests pin all three
 * shapes (both / local-only / prod-only) and the prod SSH section content.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve as resolvePath } from 'node:path';
import {
	renderAbilitiesIntro,
	renderDiscoverCommand,
	renderAccessSection,
	renderClaudeMdBlock,
} from '../src/lib/claude-md-renderer.mjs';

const TEMPLATE = resolvePath(
	new URL( '../templates/claude-md-block.md', import.meta.url ).pathname.replace( /^\/([A-Z]:)/, '$1' )
);

const BOTH = {
	WP_LOCAL_URL: 'https://localhost',
	WP_LOCAL_USER: 'ai-agent',
	WP_LOCAL_APP_PASSWORD: 'xxxx xxxx xxxx',
	WP_LOCAL_MCP_SERVER: 'wordpress-local',
	WP_PROD_URL: 'https://example.com',
	WP_PROD_USER: 'ai-agent',
	WP_PROD_APP_PASSWORD: 'yyyy yyyy yyyy',
	WP_PROD_MCP_SERVER: 'wordpress-prod',
	WP_PROD_SSH_HOST: 'newbeone.beget.tech',
	WP_PROD_SSH_USER: 'newbeone',
	WP_PROD_SSH_PORT: '',
	WP_PROD_WP_ROOT: '/home/n/newbeone/example.com/public_html',
	WP_CLI_PHAR: '/usr/local/bin/wp-cli.phar',
};

const LOCAL_ONLY = {
	WP_LOCAL_URL: 'https://localhost',
	WP_LOCAL_USER: 'ai-agent',
	WP_LOCAL_APP_PASSWORD: 'xxxx',
	WP_LOCAL_MCP_SERVER: 'wordpress-local',
	WP_CLI_PHAR: '/usr/local/bin/wp-cli.phar',
};

const PROD_ONLY = {
	WP_PROD_URL: 'https://example.com',
	WP_PROD_USER: 'ai-agent',
	WP_PROD_APP_PASSWORD: 'yyyy',
	WP_PROD_MCP_SERVER: 'wordpress-prod',
	WP_PROD_SSH_HOST: 'newbeone.beget.tech',
	WP_PROD_SSH_USER: 'newbeone',
	WP_PROD_SSH_PORT: '2222',
	WP_PROD_WP_ROOT: '/home/n/newbeone/example.com/public_html',
	WP_CLI_PHAR: '/usr/local/bin/wp-cli.phar',
};

test( 'abilities intro: both targets mentions both server names', () => {
	const out = renderAbilitiesIntro( BOTH );
	assert.match( out, /wordpress-local/ );
	assert.match( out, /wordpress-prod/ );
	assert.doesNotMatch( out, /undefined/ );
} );

test( 'abilities intro: local-only mentions local and does not mention prod', () => {
	const out = renderAbilitiesIntro( LOCAL_ONLY );
	assert.match( out, /wordpress-local/ );
	assert.doesNotMatch( out, /wordpress-prod/ );
	assert.doesNotMatch( out, /undefined/ );
} );

test( 'abilities intro: prod-only mentions prod and does not mention local', () => {
	const out = renderAbilitiesIntro( PROD_ONLY );
	assert.match( out, /wordpress-prod/ );
	assert.doesNotMatch( out, /wordpress-local/ );
	assert.doesNotMatch( out, /undefined/ );
} );

test( 'discover command: picks local when present, else prod', () => {
	assert.equal( renderDiscoverCommand( BOTH ), 'mcp__wordpress-local__mcp-adapter-discover-abilities' );
	assert.equal( renderDiscoverCommand( LOCAL_ONLY ), 'mcp__wordpress-local__mcp-adapter-discover-abilities' );
	assert.equal( renderDiscoverCommand( PROD_ONLY ), 'mcp__wordpress-prod__mcp-adapter-discover-abilities' );
} );

test( 'access section: prod-only emits SSH examples with host/user/port/wp-root', () => {
	const out = renderAccessSection( PROD_ONLY );
	assert.match( out, /Production access \(SSH\)/ );
	assert.match( out, /ssh -p 2222 newbeone@newbeone\.beget\.tech/ );
	assert.match( out, /wp --ssh=newbeone@newbeone\.beget\.tech:2222\/home\/n\/newbeone\/example\.com\/public_html/ );
	assert.doesNotMatch( out, /undefined/ );
} );

test( 'access section: local-only does NOT include Production access section', () => {
	const out = renderAccessSection( LOCAL_ONLY );
	assert.doesNotMatch( out, /Production access/ );
	assert.doesNotMatch( out, /undefined/ );
} );

test( 'access section: omits SSH port flag when blank', () => {
	const out = renderAccessSection( BOTH );
	assert.match( out, /ssh newbeone@newbeone\.beget\.tech/ );
	assert.doesNotMatch( out, /ssh -p / );
} );

test( 'full block render: prod-only — no literal "undefined" anywhere', async () => {
	const block = await renderClaudeMdBlock( PROD_ONLY, TEMPLATE );
	assert.doesNotMatch( block, /undefined/ );
	assert.match( block, /wordpress-prod/ );
	assert.match( block, /WP_PROD_SSH_HOST/ );
} );

test( 'full block render: local-only — no literal "undefined" anywhere', async () => {
	const block = await renderClaudeMdBlock( LOCAL_ONLY, TEMPLATE );
	assert.doesNotMatch( block, /undefined/ );
	assert.match( block, /wordpress-local/ );
} );

test( 'full block render: both — no literal "undefined" anywhere', async () => {
	const block = await renderClaudeMdBlock( BOTH, TEMPLATE );
	assert.doesNotMatch( block, /undefined/ );
} );

test( 'full block render: heading "## Credentials & remote access" stays stable (doctor depends on it)', async () => {
	const block = await renderClaudeMdBlock( BOTH, TEMPLATE );
	assert.match( block, /^## Credentials & remote access$/m );
} );

test( 'full block render: template placeholders are all expanded', async () => {
	const block = await renderClaudeMdBlock( BOTH, TEMPLATE );
	assert.doesNotMatch( block, /\{\{ABILITIES_INTRO\}\}/ );
	assert.doesNotMatch( block, /\{\{DISCOVER_COMMAND\}\}/ );
	assert.doesNotMatch( block, /\{\{ACCESS_SECTION\}\}/ );
	assert.doesNotMatch( block, /\{\{WP_LOCAL_MCP_SERVER\}\}/ );
	assert.doesNotMatch( block, /\{\{WP_PROD_MCP_SERVER\}\}/ );
} );
