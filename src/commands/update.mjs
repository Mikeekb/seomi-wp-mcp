/**
 * `seomi-wp-mcp update` — pull the latest mu-plugin and regenerate managed sections.
 *
 * Steps:
 *   1. Detect connection mode (submodule / composer / plain clone).
 *   2. Run the appropriate update command.
 *   3. Regenerate managed block in CLAUDE.md from the bundled template.
 *   4. Refresh aif-wp-mcp skill in .claude/skills/ (overwrite — managed by CLI).
 */

import { existsSync } from 'node:fs';
import { readFile, cp, rm, mkdir } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../lib/logger.mjs';
import { insertOrUpdate as updateMarkerBlock } from '../lib/markers.mjs';
import { renderClaudeMdBlock } from '../lib/claude-md-renderer.mjs';
import { detectAgentMdTargets } from '../lib/agent-md-target.mjs';

const MU_PLUGIN_DIR = 'wp-content/mu-plugins/seomi-mcp-abilities';
const PLUGIN_HEADER_FILE = MU_PLUGIN_DIR + '/seomi-mcp-abilities.php';

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

async function readEnv( cwd ) {
	const path = join( cwd, '.claude/.env' );
	if ( ! existsSync( path ) ) return {};
	const text = await readFile( path, 'utf8' );
	const out = {};
	for ( const line of text.split( /\r?\n/ ) ) {
		const m = line.trim().match( /^([A-Z_][A-Z0-9_]*)=(.*)$/ );
		if ( m ) out[ m[1] ] = m[2];
	}
	return out;
}

async function readPluginVersion( cwd ) {
	const path = join( cwd, PLUGIN_HEADER_FILE );
	if ( ! existsSync( path ) ) return null;
	const text = await readFile( path, 'utf8' );
	const m = text.match( /Version:\s*([^\s\r\n]+)/ );
	return m ? m[1] : null;
}

function detectMode( cwd ) {
	if ( existsSync( join( cwd, '.gitmodules' ) ) ) {
		return 'submodule';
	}
	if ( existsSync( join( cwd, 'composer.json' ) ) && existsSync( join( cwd, 'vendor', 'seomi', 'wp-mcp-abilities' ) ) ) {
		return 'composer';
	}
	if ( existsSync( join( cwd, MU_PLUGIN_DIR ) ) ) {
		return 'copy';
	}
	return 'none';
}

export async function updateCommand( opts ) {
	const cwd = process.cwd();
	logger.step( `seomi-wp-mcp update — cwd: ${ cwd }` );

	const before = await readPluginVersion( cwd );
	logger.info( `Plugin version before: ${ before ?? '(not installed)' }` );

	const mode = detectMode( cwd );
	logger.info( `Detected connection mode: ${ mode }` );

	if ( mode === 'none' ) {
		logger.error( 'mu-plugin not found. Run `seomi-wp-mcp init` first.' );
		return 1;
	}

	if ( mode === 'submodule' ) {
		logger.step( 'git submodule update --remote' );
		const r = await exec( 'git', [ 'submodule', 'update', '--remote', MU_PLUGIN_DIR ], { cwd } );
		if ( r.code !== 0 ) {
			logger.error( `submodule update failed: ${ r.stderr.trim() }` );
			return 1;
		}
	} else if ( mode === 'composer' ) {
		logger.step( 'composer update seomi/wp-mcp-abilities' );
		const r = await exec( 'composer', [ 'update', 'seomi/wp-mcp-abilities' ], { cwd } );
		if ( r.code !== 0 ) {
			logger.error( `composer update failed: ${ r.stderr.trim() }` );
			return 1;
		}
	} else if ( mode === 'copy' ) {
		logger.warn( 'Plain-clone mode — re-cloning to refresh.' );
		await rm( join( cwd, MU_PLUGIN_DIR ), { recursive: true, force: true } );
		const r = await exec( 'git', [ 'clone', '--depth=1', 'https://github.com/Mikeekb/wp-mcp-abilities.git', MU_PLUGIN_DIR ], { cwd } );
		if ( r.code !== 0 ) {
			logger.error( `git clone failed: ${ r.stderr.trim() }` );
			return 1;
		}
		await rm( join( cwd, MU_PLUGIN_DIR, '.git' ), { recursive: true, force: true } );
	}

	const after = await readPluginVersion( cwd );
	logger.success( `Plugin version after: ${ after ?? '(unknown)' }` );

	// Regenerate skill files (CLI-managed). Wipe first so files removed in a
	// newer skill version don't linger — `cp --force` overwrites but never
	// deletes stale entries.
	logger.step( 'Refreshing aif-wp-mcp skill' );
	const skillSrc = join( pkgRoot(), 'skills', 'aif-wp-mcp' );
	const skillDest = join( cwd, '.claude/skills/aif-wp-mcp' );
	await rm( skillDest, { recursive: true, force: true } );
	await mkdir( skillDest, { recursive: true } );
	await cp( skillSrc, skillDest, { recursive: true, force: true } );

	// Regenerate the managed block in whichever agent-instructions file the
	// project uses (AGENTS.md and/or CLAUDE.md). update runs non-interactively —
	// if neither file exists, warn and skip; the user should run init first.
	const env = await readEnv( cwd );
	const templatePath = join( pkgRoot(), 'templates', 'claude-md-block.md' );
	const block = await renderClaudeMdBlock( env, templatePath );
	const detected = await detectAgentMdTargets( { cwd, interactive: false } );
	const targets = detected.source === 'default' ? [] : detected.targets;

	if ( targets.length === 0 ) {
		logger.warn( 'No AGENTS.md or CLAUDE.md found — skipping managed-block regeneration. Run `seomi-wp-mcp init` first.' );
	} else {
		const targetNames = targets.map( ( p ) => p.split( /[\\/]/ ).pop() ).join( ', ' );
		logger.step( `Regenerating managed block (targets: ${ targetNames })` );
		for ( const targetPath of targets ) {
			const name = targetPath.split( /[\\/]/ ).pop();
			const r = await updateMarkerBlock( targetPath, block );
			logger.success( `${ name }: ${ r.action }` );
		}
	}

	logger.success( 'Update complete.' );
	return 0;
}
