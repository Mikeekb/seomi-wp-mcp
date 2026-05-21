/**
 * Render the managed CLAUDE.md block from the bundled template.
 *
 * The block is target-aware: a local-only project, a prod-only project, and a
 * both-configured project all need different intro paragraphs and different
 * "Production access" hints. Naïve `replaceAll` over the raw template would
 * inline the literal string "undefined" for missing fields, which has burned
 * agents on prod-only setups (they end up reading `mcp__undefined__...` and
 * scrolling around `~/.ssh/config` instead of `.claude/.env`).
 *
 * Placeholders consumed:
 *   {{ABILITIES_INTRO}}   — "Abilities are served via …" paragraph
 *   {{DISCOVER_COMMAND}}  — full `mcp__<server>__mcp-adapter-discover-abilities`
 *   {{ACCESS_SECTION}}    — Credentials & remote-access H2 section
 */

import { readFile } from 'node:fs/promises';

const DEFAULT_LOCAL = 'wordpress-local';
const DEFAULT_PROD = 'wordpress-prod';

function present( v ) {
	return typeof v === 'string' && v.trim().length > 0;
}

function primaryServer( env ) {
	if ( present( env.WP_LOCAL_MCP_SERVER ) ) return env.WP_LOCAL_MCP_SERVER;
	if ( present( env.WP_PROD_MCP_SERVER ) ) return env.WP_PROD_MCP_SERVER;
	return DEFAULT_LOCAL;
}

export function renderAbilitiesIntro( env ) {
	const hasLocal = present( env.WP_LOCAL_MCP_SERVER );
	const hasProd = present( env.WP_PROD_MCP_SERVER );
	const local = env.WP_LOCAL_MCP_SERVER;
	const prod = env.WP_PROD_MCP_SERVER;

	if ( hasLocal && hasProd ) {
		return `Abilities are served via the **\`${ local }\`** MCP server (production: ` +
			`**\`${ prod }\`**) under the \`seomi/*\` namespace. Call ` +
			`\`mcp__${ local }__mcp-adapter-discover-abilities\` to list them at any time.`;
	}
	if ( hasLocal ) {
		return `Abilities are served via the **\`${ local }\`** MCP server under the ` +
			`\`seomi/*\` namespace. Call \`mcp__${ local }__mcp-adapter-discover-abilities\` ` +
			`to list them at any time.`;
	}
	if ( hasProd ) {
		return `Abilities are served via the **\`${ prod }\`** MCP server (this project has ` +
			`no local WordPress install — production only) under the \`seomi/*\` namespace. ` +
			`Call \`mcp__${ prod }__mcp-adapter-discover-abilities\` to list them at any time.`;
	}
	return `Abilities are served under the \`seomi/*\` namespace via the project's MCP ` +
		`server (see \`.mcp.json\`). Use \`mcp-adapter-discover-abilities\` on the ` +
		`configured server to list them at any time.`;
}

export function renderDiscoverCommand( env ) {
	return `mcp__${ primaryServer( env ) }__mcp-adapter-discover-abilities`;
}

function buildKeysTable( env ) {
	const rows = [];
	const push = ( key, label ) => {
		if ( present( env[ key ] ) ) rows.push( [ key, label ] );
	};
	push( 'WP_LOCAL_URL', env.WP_LOCAL_URL );
	push( 'WP_LOCAL_USER', env.WP_LOCAL_USER );
	if ( present( env.WP_LOCAL_APP_PASSWORD ) ) rows.push( [ 'WP_LOCAL_APP_PASSWORD', '***** (set)' ] );
	push( 'WP_LOCAL_MCP_SERVER', env.WP_LOCAL_MCP_SERVER );
	push( 'WP_PROD_URL', env.WP_PROD_URL );
	push( 'WP_PROD_USER', env.WP_PROD_USER );
	if ( present( env.WP_PROD_APP_PASSWORD ) ) rows.push( [ 'WP_PROD_APP_PASSWORD', '***** (set)' ] );
	push( 'WP_PROD_MCP_SERVER', env.WP_PROD_MCP_SERVER );
	push( 'WP_PROD_SSH_HOST', env.WP_PROD_SSH_HOST );
	push( 'WP_PROD_SSH_USER', env.WP_PROD_SSH_USER );
	push( 'WP_PROD_SSH_PORT', env.WP_PROD_SSH_PORT );
	push( 'WP_PROD_WP_ROOT', env.WP_PROD_WP_ROOT );
	push( 'WP_CLI_PHAR', env.WP_CLI_PHAR );
	if ( ! rows.length ) return '';
	const out = [ '| Key | Value |', '|-----|-------|' ];
	for ( const [ k, v ] of rows ) out.push( `| \`${ k }\` | ${ v } |` );
	return out.join( '\n' );
}

function buildProdSshExamples( env ) {
	const host = env.WP_PROD_SSH_HOST;
	if ( ! present( host ) ) return '';
	const user = present( env.WP_PROD_SSH_USER ) ? env.WP_PROD_SSH_USER : 'ai-agent';
	const port = present( env.WP_PROD_SSH_PORT ) ? env.WP_PROD_SSH_PORT : '';
	const wpRoot = present( env.WP_PROD_WP_ROOT ) ? env.WP_PROD_WP_ROOT : '<wp-root>';
	const portFlag = port ? `-p ${ port } ` : '';
	const portSeg = port ? `:${ port }` : '';
	const prodSrv = present( env.WP_PROD_MCP_SERVER ) ? env.WP_PROD_MCP_SERVER : DEFAULT_PROD;
	const lines = [];
	lines.push( '### Production access (SSH)' );
	lines.push( '' );
	lines.push( 'This project has prod SSH configured. Concrete examples using values from `.claude/.env`:' );
	lines.push( '' );
	lines.push( '```bash' );
	lines.push( `ssh ${ portFlag }${ user }@${ host }` );
	lines.push( `wp --ssh=${ user }@${ host }${ portSeg }${ wpRoot } <command>` );
	lines.push( '```' );
	lines.push( '' );
	lines.push( `For content reads/writes prefer the prod MCP server (\`${ prodSrv }\`) — call` );
	lines.push( `\`mcp__${ prodSrv }__mcp-adapter-discover-abilities\` for the live list.` );
	return lines.join( '\n' );
}

export function renderAccessSection( env ) {
	const lines = [];
	lines.push( '## Credentials & remote access' );
	lines.push( '' );
	lines.push( 'Credentials and remote-access details for this project live in `.claude/.env` (gitignored).' );
	lines.push( 'That file is the **first place to look** for any prod / SSH / WP-CLI operation — do NOT' );
	lines.push( 'consult `~/.ssh/config`, host aliases from other projects, or guess based on the' );
	lines.push( "WP URL's hostname before checking `.claude/.env`." );
	const table = buildKeysTable( env );
	if ( table ) {
		lines.push( '' );
		lines.push( 'Keys present in this project (only configured targets are written):' );
		lines.push( '' );
		lines.push( table );
	}
	const ssh = buildProdSshExamples( env );
	if ( ssh ) {
		lines.push( '' );
		lines.push( ssh );
	}
	lines.push( '' );
	lines.push( '> This whole block (between the `seomi-wp-mcp:start` / `seomi-wp-mcp:end` HTML comments)' );
	lines.push( '> is **CLI-managed** — edit it via `seomi-wp-mcp update`, not by hand.' );
	return lines.join( '\n' );
}

export async function renderClaudeMdBlock( env, templatePath ) {
	const template = await readFile( templatePath, 'utf8' );
	return template
		.replaceAll( '{{ABILITIES_INTRO}}', renderAbilitiesIntro( env ) )
		.replaceAll( '{{DISCOVER_COMMAND}}', renderDiscoverCommand( env ) )
		.replaceAll( '{{ACCESS_SECTION}}', renderAccessSection( env ) );
}
