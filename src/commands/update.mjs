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
import { readFile, rm } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import { logger } from '../lib/logger.mjs';
import { insertOrUpdate as updateMarkerBlock } from '../lib/markers.mjs';
import { renderClaudeMdBlock } from '../lib/claude-md-renderer.mjs';
import { detectAgentMdTargets, ensureClaudeImportStub, isClaudeImportStub } from '../lib/agent-md-target.mjs';
import { detectThemeOrPluginSlug } from '../lib/project-asset-detector.mjs';
import { checkForUpdate, performSelfUpdate } from '../lib/self-update.mjs';
import { installBundledSkills } from '../lib/skill-installer.mjs';

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

/**
 * After a successful self-update, the freshly installed code is NOT loaded in
 * this process — re-running is the only way to apply it. Offer to do that now
 * (interactive TTY) or print the command to run (non-interactive).
 * Returns the exit code to propagate.
 */
async function offerRerun() {
	const bin = process.platform === 'win32' ? 'seomi-wp-mcp.cmd' : 'seomi-wp-mcp';
	if ( process.stdin.isTTY ) {
		const again = await confirm( {
			message: 'Re-run update now with the new version to refresh project files?',
			default: true,
		} );
		if ( again ) {
			logger.step( 'Re-running update with the new version' );
			// --no-self-update guards against a check→update→check loop.
			const r = await exec( bin, [ 'update', '--no-self-update' ], { stdio: 'inherit', shell: true } );
			return r.code ?? 0;
		}
	}
	logger.info( 'Run `seomi-wp-mcp update` again to refresh the project files with the new version.' );
	return 0;
}

/**
 * Self-update gate. Returns { stop, code }:
 *   stop=true  → a newer version was installed; caller should return `code`.
 *   stop=false → nothing to update (or npm unreachable); caller proceeds.
 */
async function runSelfUpdateGate() {
	logger.step( 'Checking npm for a newer seomi-wp-mcp version' );
	const info = await checkForUpdate();

	if ( ! info.checked ) {
		logger.warn( 'Could not reach npm to check for updates — continuing with the current version.' );
		return { stop: false };
	}
	if ( ! info.hasUpdate ) {
		logger.success( `seomi-wp-mcp is up to date (${ info.current }).` );
		return { stop: false };
	}

	logger.info( `New version available: ${ info.current } → ${ info.latest }. Updating the global package…` );
	const res = await performSelfUpdate();
	if ( ! res.ok ) {
		logger.warn( `Self-update failed${ res.error ? ` (${ res.error })` : '' } — continuing with the current version.` );
		return { stop: false };
	}

	logger.success( `Updated seomi-wp-mcp to ${ info.latest }.` );
	const code = await offerRerun();
	return { stop: true, code };
}

export async function updateCommand( opts = {} ) {
	const cwd = process.cwd();
	logger.step( `seomi-wp-mcp update — cwd: ${ cwd }` );

	// Step 0: self-update gate. If a newer CLI version exists, upgrade the
	// global package first and hand off to the new code (via re-run). Skipped
	// with --no-self-update (used by the re-run itself and by tests/CI).
	if ( opts[ 'self-update' ] !== false ) {
		const gate = await runSelfUpdateGate();
		if ( gate.stop ) {
			return gate.code ?? 0;
		}
	}

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

	// Regenerate skill files (CLI-managed). Wipe+recopy semantics live in the
	// shared installer so init and update stay in sync on the bundle contents.
	logger.step( 'Refreshing ai-factory skills' );
	await installBundledSkills( cwd );

	// Regenerate the managed block in whichever agent-instructions file the
	// project uses (AGENTS.md and/or CLAUDE.md). update runs non-interactively —
	// if neither file exists, warn and skip; the user should run init first.
	const env = await readEnv( cwd );
	const templatePath = join( pkgRoot(), 'templates', 'claude-md-block.md' );
	const assetSlug = detectThemeOrPluginSlug( cwd );
	const block = await renderClaudeMdBlock( env, templatePath, { assetSlug } );
	const detected = await detectAgentMdTargets( { cwd, interactive: false } );
	const targets = detected.source === 'default' ? [] : detected.targets;

	if ( targets.length === 0 ) {
		logger.warn( 'No AGENTS.md or CLAUDE.md found — skipping managed-block regeneration. Run `seomi-wp-mcp init` first.' );
	} else {
		const targetNames = targets.map( ( p ) => p.split( /[\\/]/ ).pop() ).join( ', ' );
		logger.step( `Regenerating managed block (targets: ${ targetNames })` );
		for ( const targetPath of targets ) {
			const name = targetPath.split( /[\\/]/ ).pop();
			// Don't write the block into a CLAUDE.md that just imports AGENTS.md —
			// keep it a pure `@AGENTS.md` redirect instead of re-duplicating.
			if ( name === 'CLAUDE.md' && isClaudeImportStub( targetPath ) ) {
				logger.info( `${ name }: left as @AGENTS.md import (block lives in AGENTS.md)` );
				continue;
			}
			const r = await updateMarkerBlock( targetPath, block );
			logger.success( `${ name }: ${ r.action }` );
		}
		// Backfill the CLAUDE.md import stub for projects that only have an
		// AGENTS.md — Claude Code never reads AGENTS.md, so without this it would
		// start blind. No-op when a CLAUDE.md already exists.
		const claudeStubRes = await ensureClaudeImportStub( { cwd } );
		if ( claudeStubRes.created ) {
			logger.success( 'Created CLAUDE.md (@AGENTS.md import) — Claude Code now reads AGENTS.md' );
		}
	}

	logger.success( 'Update complete.' );
	return 0;
}
