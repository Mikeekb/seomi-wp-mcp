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
import { resolve as resolvePath } from 'node:path';
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

test( 'access section: prod-only emits ssh / wp --ssh / rsync with host/user/port/wp-root', () => {
	const out = renderAccessSection( PROD_ONLY );
	assert.match( out, /\.claude\/\.env/ );
	assert.match( out, /ssh -p 2222 newbeone@newbeone\.beget\.tech/ );
	assert.match( out, /wp --ssh=newbeone@newbeone\.beget\.tech:2222\/home\/n\/newbeone\/example\.com\/public_html/ );
	// rsync's inner ssh uses lowercase -p.
	assert.match( out, /rsync -avz -e "ssh -p 2222" / );
	assert.match( out, /newbeone@newbeone\.beget\.tech:\/home\/n\/newbeone\/example\.com\/public_html\/wp-content\// );
	assert.doesNotMatch( out, /undefined/ );
} );

test( 'access section: local-only has the .env pointer but no prod commands', () => {
	const out = renderAccessSection( LOCAL_ONLY );
	assert.match( out, /\.claude\/\.env/ );
	assert.doesNotMatch( out, /```/ );
	assert.doesNotMatch( out, /--ssh=/ );
	assert.doesNotMatch( out, /undefined/ );
} );

test( 'access section: omits port flags when blank', () => {
	const out = renderAccessSection( BOTH );
	assert.match( out, /ssh newbeone@newbeone\.beget\.tech/ );
	assert.doesNotMatch( out, /ssh -p / );
	assert.doesNotMatch( out, /-e "ssh -p / );
	assert.match( out, /--ssh=newbeone@newbeone\.beget\.tech\/home\// );
} );

test( 'access section: does not dump .env values or secrets as a table', () => {
	const out = renderAccessSection( BOTH );
	assert.doesNotMatch( out, /\| Key \| Value \|/ );
	assert.doesNotMatch( out, /yyyy|xxxx/ );
} );

test( 'access section: detected theme slug appears in rsync deploy line', () => {
	const out = renderAccessSection( PROD_ONLY, { assetSlug: { kind: 'theme', slug: 'my-theme' } } );
	assert.match( out, /\.\/wp-content\/themes\/my-theme\// );
	assert.doesNotMatch( out, /<theme-or-plugin-slug>/ );
} );

test( 'access section: detected plugin slug appears in rsync deploy line', () => {
	const out = renderAccessSection( PROD_ONLY, { assetSlug: { kind: 'plugin', slug: 'my-plugin' } } );
	assert.match( out, /\.\/wp-content\/plugins\/my-plugin\// );
	assert.doesNotMatch( out, /<theme-or-plugin-slug>/ );
} );

test( 'access section: no asset detected → placeholder appears', () => {
	const out = renderAccessSection( PROD_ONLY );
	assert.match( out, /<themes-or-plugins>\/<theme-or-plugin-slug>/ );
} );

test( 'full block render: prod-only — no literal "undefined" anywhere', async () => {
	const block = await renderClaudeMdBlock( PROD_ONLY, TEMPLATE );
	assert.doesNotMatch( block, /undefined/ );
	assert.match( block, /wordpress-prod/ );
	assert.match( block, /mcp__wordpress-prod__mcp-adapter-discover-abilities/ );
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
	assert.doesNotMatch( block, /\{\{[A-Z_]+\}\}/ );
} );

test( 'full block render: keeps the must-have rules', async () => {
	const block = await renderClaudeMdBlock( BOTH, TEMPLATE );
	assert.match( block, /`seomi\/\*` abilities first/ );
	assert.match( block, /\$wpdb->update\( \$wpdb->term_taxonomy/ );
	assert.match( block, /wp_insert_post/ );
	assert.match( block, /with_admin_term_kses/ );
	assert.match( block, /PhpStorm/ );
	assert.match( block, /CLI-managed/ );
	assert.match( block, /aif-wp-mcp/ );
	assert.match( block, /seomi-wp-mcp doctor/ );
} );

test( 'full block render: playbooks and derivable tables are not resident', async () => {
	const block = await renderClaudeMdBlock( BOTH, TEMPLATE, { assetSlug: { kind: 'theme', slug: 'x' } } );
	assert.doesNotMatch( block, /Adding a new ability/ );
	assert.doesNotMatch( block, /Proactive ability-gap/ );
	assert.doesNotMatch( block, /## Lifecycle/ );
	assert.doesNotMatch( block, /Adding a new MCP server/ );
	assert.doesNotMatch( block, /seomi\/get-posts/ );
	assert.doesNotMatch( block, /^scp /m );
} );

test( 'full block render: stays within the ~3 KB context budget', async () => {
	for ( const env of [ BOTH, LOCAL_ONLY, PROD_ONLY ] ) {
		const block = await renderClaudeMdBlock( env, TEMPLATE, { assetSlug: { kind: 'theme', slug: 'some-long-theme-slug' } } );
		assert.ok( Buffer.byteLength( block ) <= 3072, `block is ${ Buffer.byteLength( block ) } bytes` );
	}
} );

test( 'full block render: no leading/trailing blank-line drift when prod commands are empty', async () => {
	const block = await renderClaudeMdBlock( LOCAL_ONLY, TEMPLATE );
	assert.doesNotMatch( block, /\n\n\n/, 'managed block must not contain three or more consecutive newlines' );
	assert.match( block.slice( 0, 50 ), /^\S/ );
} );

test( 'full block render: proactive SSH/MCP hint paragraph stays at top of block', async () => {
	const block = await renderClaudeMdBlock( PROD_ONLY, TEMPLATE );
	const head = block.split( '\n' ).slice( 0, 6 ).join( '\n' );
	assert.match( head, /--ssh=<spec>/ );
	assert.match( head, /mcpServers/ );
} );

test( 'full block render: prod commands integrated into block with detected slug', async () => {
	const block = await renderClaudeMdBlock( PROD_ONLY, TEMPLATE, { assetSlug: { kind: 'theme', slug: 'eltonn-theme' } } );
	assert.match( block, /rsync -avz/ );
	assert.match( block, /eltonn-theme/ );
} );
