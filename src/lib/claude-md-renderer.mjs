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
 *   {{ABILITIES_INTRO}}        — "Abilities are served via …" paragraph
 *   {{DISCOVER_COMMAND}}       — full `mcp__<server>__mcp-adapter-discover-abilities`
 *   {{ACCESS_SECTION}}         — Credentials & remote-access H2 section
 *   {{DEPLOYMENT_SECTION}}     — "Deployment to production (SCP/SSH)" H3 section
 *   {{MCP_SERVERS_SECTION}}    — "MCP servers in this project" H2 section
 */

import { readFile } from 'node:fs/promises';
import { logger } from './logger.mjs';

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

/**
 * Resolve the asset path segment for SCP/RSYNC examples.
 *
 *   { kind: 'theme', slug: 'my-theme' }   → { sub: 'themes/my-theme',   slug: 'my-theme' }
 *   { kind: 'plugin', slug: 'my-plugin' } → { sub: 'plugins/my-plugin', slug: 'my-plugin' }
 *   null                                  → { sub: '<assets>/<theme-or-plugin-slug>', slug: '<theme-or-plugin-slug>' }
 *
 * The placeholder form intentionally keeps the literal `<assets>` so an agent
 * reading the block knows to substitute both the asset type (`themes`/`plugins`)
 * and the slug.
 */
function resolveAssetPath( assetSlug ) {
	if ( assetSlug && assetSlug.kind === 'theme' && present( assetSlug.slug ) ) {
		return { sub: `themes/${ assetSlug.slug }`, slug: assetSlug.slug };
	}
	if ( assetSlug && assetSlug.kind === 'plugin' && present( assetSlug.slug ) ) {
		return { sub: `plugins/${ assetSlug.slug }`, slug: assetSlug.slug };
	}
	return { sub: '<themes-or-plugins>/<theme-or-plugin-slug>', slug: '<theme-or-plugin-slug>' };
}

/**
 * "Deployment to production (SCP/SSH)" section. Rendered only when prod SSH is
 * configured (`WP_PROD_SSH_HOST` is set). Returns '' otherwise so the template
 * placeholder collapses cleanly.
 *
 * The whole point of this section: when the prod MCP server entry in `.mcp.json`
 * carries `--ssh=<spec>`, that spec is *also* a usable SCP/RSYNC channel for
 * pushing theme/plugin files. Agents tend to read `--ssh=` as "MCP-only" and
 * default to suggesting PhpStorm/WebStorm "Deploy" UI for file pushes — which
 * is the wrong path for AI sessions. The section pre-cooks the recipes so the
 * agent has them at hand.
 */
export function renderDeploymentSection( env, opts = {} ) {
	const host = env.WP_PROD_SSH_HOST;
	if ( ! present( host ) ) {
		logger.debug( '[render] deployment section: no WP_PROD_SSH_HOST → empty' );
		return '';
	}
	const user = present( env.WP_PROD_SSH_USER ) ? env.WP_PROD_SSH_USER : 'ai-agent';
	const port = present( env.WP_PROD_SSH_PORT ) ? env.WP_PROD_SSH_PORT : '';
	const wpRoot = present( env.WP_PROD_WP_ROOT ) ? env.WP_PROD_WP_ROOT : '<wp-root>';
	const asset = resolveAssetPath( opts.assetSlug );

	logger.debug( `[render] deployment section: host=${ host }, port=${ port || '(default)' }, asset=${ JSON.stringify( asset ) }` );

	const scpPortFlag = port ? `-P ${ port } ` : '';
	const sshPortFlag = port ? `-p ${ port } ` : '';
	const rsyncSshFlag = port ? `-e "ssh -p ${ port }" ` : '';

	const lines = [];
	lines.push( '### Deployment to production (SCP/SSH)' );
	lines.push( '' );
	lines.push( '**The `--ssh=` argument of the prod MCP server in `.mcp.json` is the same SSH channel —' );
	lines.push( 'use it to deploy files, not only as an MCP config.** Concrete commands using values' );
	lines.push( 'from `.claude/.env`:' );
	lines.push( '' );
	lines.push( '```bash' );
	lines.push( `# Push the ${ asset.slug } ${ opts.assetSlug?.kind ?? 'asset' } via scp` );
	lines.push( `scp ${ scpPortFlag }-r ./wp-content/${ asset.sub }/ ${ user }@${ host }:${ wpRoot }/wp-content/${ asset.sub }/` );
	lines.push( '' );
	lines.push( `# Or via rsync (incremental, recommended for repeat deploys)` );
	lines.push( `rsync -avz ${ rsyncSshFlag }./wp-content/${ asset.sub }/ ${ user }@${ host }:${ wpRoot }/wp-content/${ asset.sub }/` );
	lines.push( '' );
	lines.push( `# Flush WP cache after deploy` );
	lines.push( `ssh ${ sshPortFlag }${ user }@${ host } "cd ${ wpRoot } && wp cache flush"` );
	lines.push( '```' );
	lines.push( '' );
	lines.push( '**Do NOT propose PhpStorm/JetBrains UI deploy first** — the SSH channel above is the' );
	lines.push( 'canonical path for this project.' );
	return lines.join( '\n' );
}

/**
 * "MCP servers in this project" section. Lists project-scope servers managed by
 * this CLI (`.mcp.json` in repo root) and points at user-scope servers
 * (`~/.claude.json`). Also includes a short playbook for adding a new MCP
 * server proactively, so agents know they can extend MCP themselves instead of
 * always trying to bend an existing server.
 */
export function renderMcpServersSection( env ) {
	const hasLocal = present( env.WP_LOCAL_MCP_SERVER );
	const hasProd = present( env.WP_PROD_MCP_SERVER );
	logger.debug( `[render] mcp-servers section: local=${ env.WP_LOCAL_MCP_SERVER || '(none)' }, prod=${ env.WP_PROD_MCP_SERVER || '(none)' }` );

	const lines = [];
	lines.push( '## MCP servers in this project' );
	lines.push( '' );
	lines.push( 'This project ships a project-scope `.mcp.json` (lives in the repo root, tracked in git)' );
	lines.push( 'with the following MCP server(s):' );
	lines.push( '' );
	lines.push( '| Server name | Scope | Transport | Source of truth |' );
	lines.push( '|---|---|---|---|' );
	if ( hasLocal ) {
		lines.push( `| \`${ env.WP_LOCAL_MCP_SERVER }\` | project | stdio + wp-cli mcp-adapter | \`.mcp.json\` (this repo) |` );
	}
	if ( hasProd ) {
		lines.push( `| \`${ env.WP_PROD_MCP_SERVER }\` | project | stdio + wp-cli \`--ssh=\` | \`.mcp.json\` (this repo) |` );
	}
	if ( ! hasLocal && ! hasProd ) {
		lines.push( '| _(none configured)_ | — | — | — |' );
	}
	lines.push( '' );
	lines.push( '### Global (user-scope) MCP servers' );
	lines.push( '' );
	lines.push( 'Run `claude mcp list --scope user` to inspect MCP servers configured globally for your' );
	lines.push( 'user (`~/.claude.json`). Those are NOT managed by this CLI and live outside this repo.' );
	lines.push( '' );
	lines.push( '### Adding a new MCP server' );
	lines.push( '' );
	lines.push( '1. **Decide scope.** Useful in every project on this machine → `--scope user`. Specific' );
	lines.push( '   to this WP project → `--scope project` (edits `.mcp.json` in this repo).' );
	lines.push( '2. **Add it:** `claude mcp add <name> --scope <scope> --transport stdio -- <command> <args...>`.' );
	lines.push( '3. **Restart Claude Code** in this directory so the new server is loaded.' );
	lines.push( '4. **Commit `.mcp.json`** if you used `--scope project` (the file is tracked).' );
	lines.push( '5. **Announce first** — before adding, tell the user the proposed name, transport, scope,' );
	lines.push( '   and source package, and wait for confirmation. Adding servers silently is an anti-pattern.' );
	return lines.join( '\n' );
}

export async function renderClaudeMdBlock( env, templatePath, opts = {} ) {
	const template = await readFile( templatePath, 'utf8' );
	const rendered = template
		.replaceAll( '{{ABILITIES_INTRO}}', renderAbilitiesIntro( env ) )
		.replaceAll( '{{DISCOVER_COMMAND}}', renderDiscoverCommand( env ) )
		.replaceAll( '{{ACCESS_SECTION}}', renderAccessSection( env ) )
		.replaceAll( '{{DEPLOYMENT_SECTION}}', renderDeploymentSection( env, opts ) )
		.replaceAll( '{{MCP_SERVERS_SECTION}}', renderMcpServersSection( env ) );
	// Collapse runs of 3+ blank lines that can appear when an optional section
	// (e.g. DEPLOYMENT_SECTION on local-only projects) renders empty. Keep at
	// most one blank line between sections for stable diffs across re-renders.
	return rendered.replace( /\n{3,}/g, '\n\n' ).trim() + '\n';
}
