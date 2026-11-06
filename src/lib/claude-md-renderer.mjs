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
 * The block is loaded into every agent session of every client project, so it
 * stays small (~2–3 KB): only what the agent can't derive from code, `.mcp.json`
 * or `--help`. Task playbooks (adding an ability, gap detection, MCP scopes)
 * live in the bundled `aif-wp-mcp` skill instead.
 *
 * Placeholders consumed:
 *   {{ABILITIES_INTRO}}        — "Abilities are served by …" sentence
 *   {{DISCOVER_COMMAND}}       — full `mcp__<server>__mcp-adapter-discover-abilities`
 *   {{ACCESS_SECTION}}         — Credentials & remote-access H2 section (+ prod SSH commands)
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
		return `Abilities are served by the \`${ local }\` MCP server (prod: \`${ prod }\`).`;
	}
	if ( hasLocal ) {
		return `Abilities are served by the \`${ local }\` MCP server.`;
	}
	if ( hasProd ) {
		return `Abilities are served by the \`${ prod }\` MCP server (prod only — no local WordPress).`;
	}
	return 'Abilities are served by the project\'s MCP server (see `.mcp.json`).';
}

export function renderDiscoverCommand( env ) {
	return `mcp__${ primaryServer( env ) }__mcp-adapter-discover-abilities`;
}

/**
 * Resolve the asset path segment for the rsync deploy example.
 *
 *   { kind: 'theme', slug: 'my-theme' }   → 'themes/my-theme'
 *   { kind: 'plugin', slug: 'my-plugin' } → 'plugins/my-plugin'
 *   null                                  → '<themes-or-plugins>/<theme-or-plugin-slug>'
 *
 * The placeholder form keeps both segments literal so the agent knows to
 * substitute the asset type and the slug.
 */
function resolveAssetPath( assetSlug ) {
	if ( assetSlug && ( assetSlug.kind === 'theme' || assetSlug.kind === 'plugin' ) && present( assetSlug.slug ) ) {
		return `${ assetSlug.kind }s/${ assetSlug.slug }`;
	}
	return '<themes-or-plugins>/<theme-or-plugin-slug>';
}

/**
 * Ready-to-run prod commands built from `.claude/.env`. Rendered only when
 * `WP_PROD_SSH_HOST` is set. One `ssh`, one `wp --ssh=` and one `rsync` deploy
 * line — enough for the agent to reach for the SSH channel instead of
 * PhpStorm's deploy UI; the rest is derivable from these.
 */
function buildProdSshCommands( env, opts = {} ) {
	const host = env.WP_PROD_SSH_HOST;
	if ( ! present( host ) ) {
		logger.debug( '[render] prod ssh commands: no WP_PROD_SSH_HOST → skipped' );
		return '';
	}
	const user = present( env.WP_PROD_SSH_USER ) ? env.WP_PROD_SSH_USER : 'ai-agent';
	const port = present( env.WP_PROD_SSH_PORT ) ? env.WP_PROD_SSH_PORT : '';
	const wpRoot = present( env.WP_PROD_WP_ROOT ) ? env.WP_PROD_WP_ROOT : '<wp-root>';
	const asset = resolveAssetPath( opts.assetSlug );
	logger.debug( `[render] prod ssh commands: host=${ host }, port=${ port || '(default)' }, asset=${ asset }` );

	const sshPortFlag = port ? `-p ${ port } ` : '';
	const rsyncSshFlag = port ? `-e "ssh -p ${ port }" ` : '';
	const portSeg = port ? `:${ port }` : '';
	return [
		'Prod SSH (values from `.claude/.env`):',
		'',
		'```bash',
		`ssh ${ sshPortFlag }${ user }@${ host }`,
		`wp --ssh=${ user }@${ host }${ portSeg }${ wpRoot } <command>   # e.g. cache flush after a deploy`,
		`rsync -avz ${ rsyncSshFlag }./wp-content/${ asset }/ ${ user }@${ host }:${ wpRoot }/wp-content/${ asset }/`,
		'```',
	].join( '\n' );
}

export function renderAccessSection( env, opts = {} ) {
	const lines = [];
	lines.push( '## Credentials & remote access' );
	lines.push( '' );
	lines.push( 'Credentials and prod access live in `.claude/.env` (gitignored) — read it **first** for any' );
	lines.push( 'prod / SSH / WP-CLI task, not `~/.ssh/config`, other projects\' host aliases or guesses from' );
	lines.push( 'the site URL.' );
	const ssh = buildProdSshCommands( env, opts );
	if ( ssh ) {
		lines.push( '' );
		lines.push( ssh );
	}
	return lines.join( '\n' );
}

export async function renderClaudeMdBlock( env, templatePath, opts = {} ) {
	const template = await readFile( templatePath, 'utf8' );
	const rendered = template
		.replaceAll( '{{ABILITIES_INTRO}}', renderAbilitiesIntro( env ) )
		.replaceAll( '{{DISCOVER_COMMAND}}', renderDiscoverCommand( env ) )
		.replaceAll( '{{ACCESS_SECTION}}', renderAccessSection( env, opts ) );
	// Collapse runs of 3+ blank lines that can appear when an optional section
	// (e.g. the prod SSH commands on local-only projects) renders empty. Keep at
	// most one blank line between sections for stable diffs across re-renders.
	return rendered.replace( /\n{3,}/g, '\n\n' ).trim() + '\n';
}
