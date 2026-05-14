/**
 * `seomi-wp-mcp init` — interactive setup for a WordPress project.
 *
 * Steps:
 *   1. Detect WP root.
 *   2. Ask for credentials (local + optional prod).
 *   3. Write .claude/.env (merging, not clobbering).
 *   4. Auto-install WP plugin deps (Abilities API + MCP Adapter) — best effort.
 *   5. Connect mu-plugin (submodule / composer / copy).
 *   6. Drop the aif-wp-mcp skill into .claude/skills/.
 *   7. Insert/update the managed block in CLAUDE.md.
 *   8. Register MCP servers in Claude (or print copy-paste fallback).
 *   9. Print final summary.
 *
 * Idempotent: re-running upgrades in place without duplicating anything.
 */

import { input, password, select, confirm } from '@inquirer/prompts';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../lib/logger.mjs';
import { mergeEnv } from '../lib/env-writer.mjs';
import { insertOrUpdate as updateMarkerBlock } from '../lib/markers.mjs';
import { addServer as claudeAddServer } from '../lib/claude-mcp.mjs';
import { ensurePlugins } from '../lib/wp-plugin-installer.mjs';

const MU_PLUGIN_REPO_URL = 'https://github.com/Mikeekb/wp-mcp-abilities.git';
const MU_PLUGIN_DIR = 'wp-content/mu-plugins/seomi-mcp-abilities';
const MU_LOADER_FILE = 'wp-content/mu-plugins/mcp-abilities.php';

function pkgRoot() {
	return resolvePath( new URL( '../..', import.meta.url ).pathname.replace( /^\/([A-Z]:)/, '$1' ) );
}

function exec( cmd, args, opts = {} ) {
	return new Promise( ( resolve ) => {
		const child = spawn( cmd, args, { shell: false, windowsHide: true, ...opts } );
		let stdout = '';
		let stderr = '';
		child.stdout?.on( 'data', ( d ) => { stdout += d.toString(); } );
		child.stderr?.on( 'data', ( d ) => { stderr += d.toString(); } );
		child.on( 'error', ( err ) => resolve( { code: -1, stdout, stderr: stderr + err.message } ) );
		child.on( 'close', ( code ) => resolve( { code: code ?? 0, stdout, stderr } ) );
	} );
}

function detectWpRoot( cwd ) {
	const candidates = [ cwd, join( cwd, '..' ) ];
	for ( const dir of candidates ) {
		if ( existsSync( join( dir, 'wp-content' ) ) || existsSync( join( dir, 'wp-config.php' ) ) ) {
			return dir;
		}
	}
	return null;
}

async function askCredentials() {
	logger.step( 'WordPress credentials — LOCAL' );
	const WP_LOCAL_URL = await input( {
		message: 'Local WP site URL:',
		default: 'https://localhost',
		validate: ( v ) => /^https?:\/\//.test( v ) || 'Must start with http:// or https://',
	} );
	const WP_LOCAL_USER = await input( {
		message: 'WP admin username (for app password):',
		default: 'ai-agent',
	} );
	const WP_LOCAL_APP_PASSWORD = await password( {
		message: 'Application password (paste as shown in WP admin):',
		mask: '*',
	} );
	const WP_LOCAL_MCP_SERVER = await input( {
		message: 'MCP server name (in Claude config):',
		default: 'wordpress-local',
	} );

	const wantProd = await confirm( {
		message: 'Configure PRODUCTION too?',
		default: false,
	} );

	let prod = {};
	if ( wantProd ) {
		logger.step( 'WordPress credentials — PRODUCTION' );
		prod.WP_PROD_URL = await input( {
			message: 'Production WP site URL:',
			validate: ( v ) => /^https?:\/\//.test( v ) || 'Must start with http:// or https://',
		} );
		prod.WP_PROD_USER = await input( {
			message: 'Production WP admin username:',
			default: 'ai-agent',
		} );
		prod.WP_PROD_APP_PASSWORD = await password( {
			message: 'Production application password:',
			mask: '*',
		} );
		prod.WP_PROD_MCP_SERVER = await input( {
			message: 'Production MCP server name:',
			default: 'wordpress-prod',
		} );
	}

	return {
		WP_LOCAL_URL,
		WP_LOCAL_USER,
		WP_LOCAL_APP_PASSWORD,
		WP_LOCAL_MCP_SERVER,
		...prod,
	};
}

async function connectMuPlugin( cwd, mode ) {
	const targetDir = join( cwd, MU_PLUGIN_DIR );
	const loaderPath = join( cwd, MU_LOADER_FILE );

	if ( ! existsSync( loaderPath ) ) {
		await mkdir( join( cwd, 'wp-content/mu-plugins' ), { recursive: true } );
		const loader = `<?php
defined( 'ABSPATH' ) || exit;
if ( defined( 'SEOMI_MCP_VERSION' ) ) return;
$f = __DIR__ . '/seomi-mcp-abilities/seomi-mcp-abilities.php';
if ( is_readable( $f ) ) require_once $f;
`;
		await writeFile( loaderPath, loader, 'utf8' );
		logger.success( `Created loader at ${ MU_LOADER_FILE }` );
	} else {
		logger.info( `Loader already present at ${ MU_LOADER_FILE }` );
	}

	if ( existsSync( targetDir ) ) {
		logger.info( `${ MU_PLUGIN_DIR } already exists — skipping connection step` );
		return { strategy: mode, action: 'already-present' };
	}

	if ( mode === 'submodule' ) {
		logger.step( `Adding git submodule: ${ MU_PLUGIN_REPO_URL } -> ${ MU_PLUGIN_DIR }` );
		const r = await exec( 'git', [ 'submodule', 'add', MU_PLUGIN_REPO_URL, MU_PLUGIN_DIR ], { cwd } );
		if ( r.code !== 0 ) {
			logger.error( `git submodule add failed: ${ r.stderr.trim() }` );
			return { strategy: 'submodule', action: 'failed', error: r.stderr };
		}
		return { strategy: 'submodule', action: 'added' };
	}

	if ( mode === 'composer' ) {
		logger.step( 'Installing via Composer' );
		const r = await exec( 'composer', [ 'require', 'seomi/wp-mcp-abilities' ], { cwd } );
		if ( r.code !== 0 ) {
			logger.error( `composer require failed: ${ r.stderr.trim() }` );
			return { strategy: 'composer', action: 'failed', error: r.stderr };
		}
		return { strategy: 'composer', action: 'added' };
	}

	if ( mode === 'copy' ) {
		logger.step( `Downloading tarball + extracting into ${ MU_PLUGIN_DIR }` );
		// Naive clone with --depth=1.
		const r = await exec( 'git', [ 'clone', '--depth=1', MU_PLUGIN_REPO_URL, targetDir ] );
		if ( r.code !== 0 ) {
			logger.error( `git clone failed: ${ r.stderr.trim() }` );
			return { strategy: 'copy', action: 'failed', error: r.stderr };
		}
		await exec( 'rm', [ '-rf', join( targetDir, '.git' ) ] );
		return { strategy: 'copy', action: 'added' };
	}

	return { strategy: mode, action: 'unknown-strategy' };
}

async function installAifSkill( cwd ) {
	const src = join( pkgRoot(), 'templates', 'aif-wp-mcp' );
	const dest = join( cwd, '.claude', 'skills', 'aif-wp-mcp' );
	await mkdir( dest, { recursive: true } );
	await cp( src, dest, { recursive: true, force: true } );
	logger.success( `Installed aif-wp-mcp skill at .claude/skills/aif-wp-mcp/` );
	return dest;
}

async function updateClaudeMd( cwd, env ) {
	const templatePath = join( pkgRoot(), 'templates', 'claude-md-block.md' );
	let template = await readFile( templatePath, 'utf8' );
	template = template
		.replaceAll( '{{WP_LOCAL_MCP_SERVER}}', env.WP_LOCAL_MCP_SERVER )
		.replaceAll( '{{WP_PROD_MCP_SERVER}}', env.WP_PROD_MCP_SERVER || '(not configured)' )
		.replaceAll( '{{WP_LOCAL_URL}}', env.WP_LOCAL_URL );

	const r = await updateMarkerBlock( join( cwd, 'CLAUDE.md' ), template );
	logger.success( `CLAUDE.md: ${ r.action }` );
	return r;
}

export async function initCommand( opts ) {
	const cwd = process.cwd();
	logger.step( `seomi-wp-mcp init — cwd: ${ cwd }` );

	const wpRoot = detectWpRoot( cwd );
	if ( ! wpRoot ) {
		logger.error( 'This does not look like a WordPress project root (no wp-content/ or wp-config.php found here or one level up).' );
		return 1;
	}
	logger.info( `Detected WP root: ${ wpRoot }` );

	const env = await askCredentials();

	const muMode = await select( {
		message: 'How should the mu-plugin be connected?',
		default: 'submodule',
		choices: [
			{ name: 'git submodule (recommended)', value: 'submodule' },
			{ name: 'composer require',            value: 'composer' },
			{ name: 'plain clone (no auto-updates)', value: 'copy' },
		],
	} );

	const installDeps = await confirm( {
		message: 'Auto-install WordPress plugin dependencies (Abilities API + MCP Adapter)?',
		default: true,
	} );

	const installSkill = await confirm( {
		message: 'Install the aif-wp-mcp skill into .claude/skills/ for ai-factory?',
		default: true,
	} );

	const updateClaudeFile = await confirm( {
		message: 'Update CLAUDE.md with the managed seomi-wp-mcp block?',
		default: true,
	} );

	// 1. Write .claude/.env
	logger.step( 'Writing .claude/.env' );
	const envRes = await mergeEnv( join( cwd, '.claude/.env' ), env );
	logger.success( `.claude/.env: created=${ envRes.created }, added=${ envRes.added.length }, updated=${ envRes.updated.length }, unchanged=${ envRes.unchanged.length }` );

	// 2. Install WP plugin deps
	let depResults = null;
	if ( installDeps ) {
		logger.step( 'Installing WordPress plugin dependencies' );
		depResults = await ensurePlugins( {
			wpRoot,
			ref: opts[ 'pin-deps' ],
		} );
		if ( depResults.manualSnippet ) {
			logger.warn( 'Some dependencies could not be fully installed automatically.' );
			logger.warn( 'Manual commands:\n' + depResults.manualSnippet );
		}
	}

	// 3. Connect mu-plugin
	logger.step( `Connecting mu-plugin via ${ muMode }` );
	const muRes = await connectMuPlugin( cwd, muMode );

	// 4. Drop aif skill
	let skillRes = null;
	if ( installSkill ) {
		skillRes = await installAifSkill( cwd );
	}

	// 5. Update CLAUDE.md
	let claudeMdRes = null;
	if ( updateClaudeFile ) {
		claudeMdRes = await updateClaudeMd( cwd, env );
	}

	// 6. Register MCP servers in Claude
	logger.step( 'Registering MCP servers in Claude' );
	const localRes = await claudeAddServer( {
		name: env.WP_LOCAL_MCP_SERVER,
		baseUrl: env.WP_LOCAL_URL,
		user: env.WP_LOCAL_USER,
		password: env.WP_LOCAL_APP_PASSWORD,
	} );
	logger.info( `Local MCP server: ${ localRes.ok ? localRes.action : 'NOT REGISTERED — ' + localRes.reason }` );
	if ( ! localRes.ok && localRes.manualCommand ) {
		logger.warn( 'Run manually:\n  ' + localRes.manualCommand );
	}

	let prodRes = null;
	if ( env.WP_PROD_URL ) {
		prodRes = await claudeAddServer( {
			name: env.WP_PROD_MCP_SERVER,
			baseUrl: env.WP_PROD_URL,
			user: env.WP_PROD_USER,
			password: env.WP_PROD_APP_PASSWORD,
		} );
		logger.info( `Prod MCP server: ${ prodRes.ok ? prodRes.action : 'NOT REGISTERED — ' + prodRes.reason }` );
		if ( ! prodRes.ok && prodRes.manualCommand ) {
			logger.warn( 'Run manually:\n  ' + prodRes.manualCommand );
		}
	}

	// 7. Summary
	logger.step( 'Summary' );
	const summary = [
		`  .claude/.env             — ${ envRes.created ? 'created' : 'updated' } (+${ envRes.added.length } / ~${ envRes.updated.length })`,
		`  mu-plugin (${ muMode })${ ' '.repeat( Math.max( 0, 12 - muMode.length ) ) }— ${ muRes.action }`,
		`  WP plugin deps           — ${ depResults ? depResults.results.map( r => r.slug + ':' + r.action ).join( ', ' ) : 'skipped' }`,
		`  aif-wp-mcp skill         — ${ skillRes ? 'installed' : 'skipped' }`,
		`  CLAUDE.md block          — ${ claudeMdRes ? claudeMdRes.action : 'skipped' }`,
		`  MCP server (local)       — ${ localRes.ok ? localRes.action : 'manual needed' }`,
		`  MCP server (prod)        — ${ prodRes ? ( prodRes.ok ? prodRes.action : 'manual needed' ) : 'skipped' }`,
	];
	process.stdout.write( '\n' + summary.join( '\n' ) + '\n\n' );

	logger.success( 'Done. Next: open a WP-aware Claude Code session in this directory.' );
	return 0;
}
