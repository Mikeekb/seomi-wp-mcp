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
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../lib/logger.mjs';
import { mergeEnv } from '../lib/env-writer.mjs';
import { insertOrUpdate as updateMarkerBlock } from '../lib/markers.mjs';
import { renderClaudeMdBlock } from '../lib/claude-md-renderer.mjs';
import { detectAgentMdTargets } from '../lib/agent-md-target.mjs';
import {
	addServerEntry as claudeAddServerEntry,
	buildStdioLocalConfig,
	buildStdioSshConfig,
	composeSshSpec,
} from '../lib/claude-mcp.mjs';
import { ensurePlugins } from '../lib/wp-plugin-installer.mjs';
import { ensureSshKey } from '../lib/ssh-key-setup.mjs';
import { ensureMuPluginOnSsh } from '../lib/ssh-mu-plugin-installer.mjs';

const MU_PLUGIN_REPO_URL = 'https://github.com/Mikeekb/wp-mcp-abilities.git';
const MU_PLUGIN_SLUG = 'seomi-mcp-abilities';
const MU_PLUGIN_DIR = `wp-content/mu-plugins/${ MU_PLUGIN_SLUG }`;
const MU_LOADER_FILE = 'wp-content/mu-plugins/mcp-abilities.php';
const MU_PLUGIN_LOADER_PHP = `<?php
defined( 'ABSPATH' ) || exit;
if ( defined( 'SEOMI_MCP_VERSION' ) ) return;
$f = __DIR__ . '/${ MU_PLUGIN_SLUG }/${ MU_PLUGIN_SLUG }.php';
if ( is_readable( $f ) ) require_once $f;
`;

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

/**
 * Try to find the WP-CLI phar path on the local machine.
 * Returns an absolute path string or null.
 */
async function detectWpCliPhar() {
	// 1. Common Windows install path.
	if ( process.platform === 'win32' ) {
		for ( const p of [ 'C:/wp-cli/wp-cli.phar', 'C:\\wp-cli\\wp-cli.phar' ] ) {
			if ( existsSync( p ) ) return p.replace( /\\/g, '/' );
		}
	}
	// 2. Look for `wp` in PATH and follow it.
	const which = process.platform === 'win32' ? [ 'where', 'wp' ] : [ 'which', 'wp' ];
	const r = await exec( which[ 0 ], [ which[ 1 ] ] );
	if ( r.code === 0 ) {
		const first = r.stdout.split( /\r?\n/ ).map( ( s ) => s.trim() ).filter( Boolean )[ 0 ];
		if ( first && existsSync( first ) ) {
			const text = await readFile( first, 'utf8' ).catch( () => '' );
			const m = text.match( /([^\s"']+wp-cli(?:-[\d.]+)?\.phar)/ );
			if ( m ) return m[ 1 ].replace( /\\/g, '/' );
		}
	}
	// 3. Common Linux/Mac paths.
	for ( const p of [ '/usr/local/bin/wp-cli.phar', '/usr/bin/wp-cli.phar' ] ) {
		if ( existsSync( p ) ) return p;
	}
	return null;
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
	// First: does the user even have a local WP install?
	// Common case where they don't: theme/plugin lives locally as a git repo,
	// but the full WordPress instance only runs on a remote server.
	const wantLocal = await confirm( {
		message: 'Configure a LOCAL WordPress integration (you have wp-content/ locally and want to talk to it)?',
		default: true,
	} );

	let WP_LOCAL_URL, WP_LOCAL_USER, WP_LOCAL_APP_PASSWORD, WP_LOCAL_MCP_SERVER;
	if ( wantLocal ) {
		logger.step( 'WordPress credentials — LOCAL' );
		WP_LOCAL_URL = await input( {
			message: 'Local WP site URL:',
			default: 'https://localhost',
			validate: ( v ) => /^https?:\/\//.test( v ) || 'Must start with http:// or https://',
		} );
		WP_LOCAL_USER = await input( {
			message: 'WP admin username (for app password):',
			default: 'ai-agent',
		} );
		WP_LOCAL_APP_PASSWORD = await password( {
			message: 'Application password (paste as shown in WP admin):',
			mask: '*',
		} );
		WP_LOCAL_MCP_SERVER = await input( {
			message: 'MCP server name (in .mcp.json):',
			default: 'wordpress-local',
		} );
	}

	// If no local — prod is the only useful target, default to yes; otherwise default no.
	const wantProd = await confirm( {
		message: 'Configure PRODUCTION too?',
		default: ! wantLocal,
	} );

	let prod = {};
	let prodSsh = null;
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
			message: 'Production MCP server name (in .mcp.json):',
			default: 'wordpress-prod',
		} );

		const wantSsh = await confirm( {
			message: 'Configure SSH to prod (for the prod MCP server and remote plugin install)?',
			default: true,
		} );
		if ( wantSsh ) {
			logger.step( 'SSH access to production' );
			prod.WP_PROD_SSH_HOST = await input( {
				message: 'Prod SSH host:',
				validate: ( v ) => !! v || 'Required',
			} );
			prod.WP_PROD_SSH_USER = await input( {
				message: 'Prod SSH user:',
				default: 'ai-agent',
			} );
			prod.WP_PROD_SSH_PORT = await input( {
				message: 'Prod SSH port (blank = default 22):',
				default: '',
			} );
			prod.WP_PROD_WP_ROOT = await input( {
				message: 'Absolute WP root path on prod (e.g. /home/user/site/public_html):',
				validate: ( v ) => v.startsWith( '/' ) || 'Must be an absolute path starting with /',
			} );
			prodSsh = {
				sshHost: prod.WP_PROD_SSH_HOST,
				sshUser: prod.WP_PROD_SSH_USER,
				sshPort: prod.WP_PROD_SSH_PORT || '',
				wpRoot: prod.WP_PROD_WP_ROOT,
			};
		}
	}

	if ( ! wantLocal && ! wantProd ) {
		throw new Error( 'Nothing to configure — answered no to both local and production. Re-run `seomi-wp-mcp init` and pick at least one target.' );
	}

	const env = { ...prod };
	if ( wantLocal ) {
		env.WP_LOCAL_URL = WP_LOCAL_URL;
		env.WP_LOCAL_USER = WP_LOCAL_USER;
		env.WP_LOCAL_APP_PASSWORD = WP_LOCAL_APP_PASSWORD;
		env.WP_LOCAL_MCP_SERVER = WP_LOCAL_MCP_SERVER;
	}

	return { env, wantLocal, prodSsh };
}

async function connectMuPlugin( cwd, mode ) {
	const targetDir = join( cwd, MU_PLUGIN_DIR );
	const loaderPath = join( cwd, MU_LOADER_FILE );

	if ( ! existsSync( loaderPath ) ) {
		await mkdir( join( cwd, 'wp-content/mu-plugins' ), { recursive: true } );
		await writeFile( loaderPath, MU_PLUGIN_LOADER_PHP, 'utf8' );
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
	const src = join( pkgRoot(), 'skills', 'aif-wp-mcp' );
	const dest = join( cwd, '.claude', 'skills', 'aif-wp-mcp' );
	// Wipe the destination first so files removed in a newer skill version
	// don't linger on re-install. `cp --force` overwrites but never deletes
	// stale entries — that breaks update-by-reinstall semantics.
	await rm( dest, { recursive: true, force: true } );
	await mkdir( dest, { recursive: true } );
	await cp( src, dest, { recursive: true, force: true } );
	logger.success( `Installed aif-wp-mcp skill at .claude/skills/aif-wp-mcp/` );
	return dest;
}

/**
 * Write the managed seomi-wp-mcp block into every detected agent-instructions
 * file (AGENTS.md / CLAUDE.md / both). Returns an array of per-target results
 * so the summary line can report the action for each file.
 */
async function updateAgentMd( cwd, env, targets ) {
	const templatePath = join( pkgRoot(), 'templates', 'claude-md-block.md' );
	const block = await renderClaudeMdBlock( env, templatePath );
	const results = [];
	for ( const targetPath of targets ) {
		const name = targetPath.split( /[\\/]/ ).pop();
		logger.step( `Updating ${ name } with managed seomi-wp-mcp block` );
		const r = await updateMarkerBlock( targetPath, block );
		logger.success( `${ name }: ${ r.action }` );
		results.push( { name, action: r.action, filePath: r.filePath } );
	}
	return results;
}

export async function initCommand( opts ) {
	const cwd = process.cwd();
	logger.step( `seomi-wp-mcp init — cwd: ${ cwd }` );

	const { env, wantLocal, prodSsh } = await askCredentials();

	// Optional SSH key wizard — set up passwordless auth to prod now so that
	// subsequent steps (and future re-runs) don't hang waiting for a TTY
	// password prompt. Asked for ONCE here; if user opts in and verify
	// fails, they can choose to bail on the prod plugin install to avoid
	// re-hitting the same blocker.
	let sshKeyRes = null;
	let skipProdInstall = false;
	if ( prodSsh ) {
		const wantKey = await confirm( {
			message: 'Set up SSH key-based auth to prod now? (recommended; you will be asked for the SSH password ONCE)',
			default: true,
		} );
		if ( wantKey ) {
			logger.step( 'SSH key setup to production' );
			try {
				sshKeyRes = await ensureSshKey( {
					sshHost: prodSsh.sshHost,
					sshUser: prodSsh.sshUser,
					sshPort: prodSsh.sshPort,
					comment: `ai-agent@${ prodSsh.sshHost }`,
				} );
				if ( ! sshKeyRes.verified ) {
					logger.warn( sshKeyRes.manualHint );
					const cont = await confirm( {
						message: 'Continue with plugin install on PROD anyway? (you may be prompted for SSH password during install)',
						default: false,
					} );
					skipProdInstall = ! cont;
				}
			} catch ( err ) {
				logger.error( `SSH key wizard failed: ${ err.message }` );
				const cont = await confirm( {
					message: 'Continue with plugin install on PROD anyway?',
					default: false,
				} );
				skipProdInstall = ! cont;
			}
		}
	}

	// WP root only matters if we have a local install. For prod-only setups
	// the cwd is used as the project root (typically a theme/plugin repo).
	let wpRoot = null;
	if ( wantLocal ) {
		wpRoot = detectWpRoot( cwd );
		if ( ! wpRoot ) {
			logger.error( 'You chose to configure a LOCAL integration, but no wp-content/ or wp-config.php was found here or one level up. Re-run init and pick "no" for local, or run it from your WP root.' );
			return 1;
		}
		logger.info( `Detected WP root: ${ wpRoot }` );
	} else {
		logger.info( `No local WordPress — using cwd as project root: ${ cwd }` );
	}

	// WP-CLI phar path — needed for both LOCAL stdio MCP and PROD --ssh stdio MCP.
	// Skip the prompt entirely if neither target is configured (impossible — we
	// would have thrown in askCredentials, but defensive).
	let wpCliPharPath = null;
	if ( wantLocal || prodSsh ) {
		const detectedPhar = await detectWpCliPhar();
		if ( detectedPhar ) {
			logger.info( `Detected WP-CLI phar at ${ detectedPhar }` );
		} else {
			logger.warn( 'Could not auto-detect WP-CLI phar path.' );
		}
		wpCliPharPath = await input( {
			message: 'Absolute path to wp-cli.phar (used by the stdio MCP server):',
			default: detectedPhar || ( process.platform === 'win32' ? 'C:/wp-cli/wp-cli.phar' : '/usr/local/bin/wp-cli.phar' ),
			validate: ( v ) => existsSync( v ) || `Not found: ${ v }`,
		} );
	}

	const muMode = wantLocal
		? await select( {
			message: 'How should the mu-plugin be connected locally?',
			default: 'submodule',
			choices: [
				{ name: 'git submodule (recommended)', value: 'submodule' },
				{ name: 'composer require',            value: 'composer' },
				{ name: 'plain clone (no auto-updates)', value: 'copy' },
				{ name: "skip — I'll install it on the target WP myself", value: 'skip' },
			],
		} )
		: 'skip';

	const installDeps = wantLocal
		? await confirm( {
			message: 'Auto-install WordPress plugin dependencies on LOCAL (Abilities API + MCP Adapter)?',
			default: true,
		} )
		: false;

	const installDepsProd = prodSsh && ! skipProdInstall
		? await confirm( {
			message: 'Also auto-install plugin dependencies on PROD (via WP-CLI --ssh)?',
			default: true,
		} )
		: false;

	const installSkill = await confirm( {
		message: 'Install the aif-wp-mcp skill into .claude/skills/ for ai-factory?',
		default: true,
	} );

	// Detect which agent-instructions file(s) the project actually uses, so the
	// confirm question references the real target(s) instead of hard-coded
	// CLAUDE.md. If neither file exists, fall back to an interactive picker
	// (AGENTS.md is the universal default).
	let agentMdTargets;
	const detected = await detectAgentMdTargets( { cwd, interactive: false } );
	if ( detected.targets.length === 0 || detected.source === 'default' ) {
		// `default` means neither file is on disk. Prompt the user so they
		// consciously pick AGENTS.md vs CLAUDE.md instead of silently creating
		// the universal default behind their back.
		const interactiveRes = await detectAgentMdTargets( { cwd, interactive: true } );
		agentMdTargets = interactiveRes.targets;
	} else {
		agentMdTargets = detected.targets;
	}
	const targetLabel = agentMdTargets.length
		? agentMdTargets.map( ( p ) => p.split( /[\\/]/ ).pop() ).join( ', ' )
		: '(no file selected)';

	const updateAgentFile = agentMdTargets.length > 0
		? await confirm( {
			message: `Update ${ targetLabel } with the managed seomi-wp-mcp block?`,
			default: true,
		} )
		: false;

	// 1. Write .claude/.env
	logger.step( 'Writing .claude/.env' );
	const envPayload = { ...env };
	if ( wpCliPharPath ) envPayload.WP_CLI_PHAR = wpCliPharPath;
	const envRes = await mergeEnv( join( cwd, '.claude/.env' ), envPayload );
	logger.success( `.claude/.env: created=${ envRes.created }, added=${ envRes.added.length }, updated=${ envRes.updated.length }, unchanged=${ envRes.unchanged.length }` );

	// 2. Install WP plugin deps
	let depResults = null;
	if ( installDeps ) {
		logger.step( 'Installing WordPress plugin dependencies' );
		depResults = await ensurePlugins( {
			wpRoot,
			wpCliPharPath,
			ref: opts[ 'pin-deps' ],
		} );
		if ( depResults.manualSnippet ) {
			logger.warn( 'Some dependencies could not be fully installed automatically.' );
			logger.warn( 'Manual commands:\n' + depResults.manualSnippet );
		}
	}

	// 3. Connect mu-plugin (skipped when no local WP)
	let muRes;
	if ( muMode === 'skip' ) {
		muRes = { strategy: 'skip', action: 'skipped' };
		logger.info( 'mu-plugin connection skipped — install it on your WordPress target yourself.' );
	} else {
		logger.step( `Connecting mu-plugin via ${ muMode }` );
		muRes = await connectMuPlugin( cwd, muMode );
	}

	// 4. Drop aif skill
	let skillRes = null;
	if ( installSkill ) {
		skillRes = await installAifSkill( cwd );
	}

	// 5. Update agent-instructions file(s) — AGENTS.md and/or CLAUDE.md, whichever
	//    the project actually uses (and both when both exist, to keep Claude Code
	//    and other agents on the same page).
	let agentMdResults = null;
	if ( updateAgentFile && agentMdTargets.length > 0 ) {
		agentMdResults = await updateAgentMd( cwd, env, agentMdTargets );
	}

	// 6. Install plugin deps on PROD via WP-CLI --ssh (if asked).
	let prodDepResults = null;
	let prodMuRes = null;
	if ( installDepsProd && prodSsh ) {
		logger.step( 'Installing WP plugin dependencies on PROD (via SSH)' );
		const sshSpec = composeSshSpec( prodSsh );
		prodDepResults = await ensurePlugins( { sshSpec, wpCliPharPath, ref: opts[ 'pin-deps' ] } );
		if ( prodDepResults.manualSnippet ) {
			logger.warn( 'Some prod dependencies could not be installed automatically.' );
			logger.warn( 'Manual commands:\n' + prodDepResults.manualSnippet );
		}

		// 6b. Auto-install the seomi-mcp-abilities mu-plugin on PROD via SSH.
		//     Same transport as the plugin install above — runs unconditionally
		//     when prod SSH is configured AND the user opted into prod plugin
		//     install. No new confirm prompt; this is the prod equivalent of
		//     the local mu-plugin "git clone" strategy.
		logger.step( 'Installing seomi-mcp-abilities mu-plugin on PROD (via SSH)' );
		prodMuRes = await ensureMuPluginOnSsh( {
			sshHost: prodSsh.sshHost,
			sshUser: prodSsh.sshUser,
			sshPort: prodSsh.sshPort,
			wpRoot: prodSsh.wpRoot,
			repoUrl: MU_PLUGIN_REPO_URL,
			slug: MU_PLUGIN_SLUG,
			loaderContent: MU_PLUGIN_LOADER_PHP,
		} );
		if ( prodMuRes.action === 'already-present' ) {
			logger.success( 'mu-plugin already present on prod — skipped' );
		}
		if ( prodMuRes.manualSnippet ) {
			logger.warn( 'mu-plugin install on prod incomplete:\n' + prodMuRes.manualSnippet );
		}
	}

	// 7. Write project-scope MCP server entries to .mcp.json.
	//    LOCAL  = stdio + WP-CLI mcp-adapter serve --path=<wpRoot>
	//    PROD   = stdio + WP-CLI mcp-adapter serve --ssh=<spec>
	logger.step( 'Writing project-scope .mcp.json' );

	let localRes = null;
	if ( wantLocal ) {
		const localCfg = buildStdioLocalConfig( {
			wpCliPharPath,
			wpRoot,
			user: env.WP_LOCAL_USER,
		} );
		localRes = await claudeAddServerEntry( cwd, env.WP_LOCAL_MCP_SERVER, localCfg );
	}

	let prodRes = null;
	if ( prodSsh && env.WP_PROD_MCP_SERVER ) {
		const sshSpec = composeSshSpec( prodSsh );
		const prodCfg = buildStdioSshConfig( {
			wpCliPharPath,
			sshSpec,
			user: env.WP_PROD_USER,
		} );
		prodRes = await claudeAddServerEntry( cwd, env.WP_PROD_MCP_SERVER, prodCfg );
	} else if ( env.WP_PROD_URL && ! prodSsh ) {
		logger.warn( 'Prod URL given but no SSH config — skipping prod MCP server registration. (Stdio over SSH is the only supported prod transport currently.)' );
	}

	// 8. Summary
	logger.step( 'Summary' );
	const sshKeyLine = sshKeyRes
		? `  SSH key (prod)           — ${ sshKeyRes.keygenAction }, copy=${ sshKeyRes.copyAction }${ sshKeyRes.verified ? ', verified' : ', NOT verified — see manual hint above' }`
		: '  SSH key (prod)           — skipped';
	const summary = [
		`  .claude/.env             — ${ envRes.created ? 'created' : 'updated' } (+${ envRes.added.length } / ~${ envRes.updated.length })`,
		`  mu-plugin (${ muMode })${ ' '.repeat( Math.max( 0, 12 - muMode.length ) ) }— ${ muRes.action }`,
		`  WP plugin deps (local)   — ${ depResults ? depResults.results.map( r => r.slug + ':' + r.action ).join( ', ' ) : 'skipped' }`,
		`  WP plugin deps (prod)    — ${ prodDepResults ? prodDepResults.results.map( r => r.slug + ':' + r.action ).join( ', ' ) : 'skipped' }`,
		`  mu-plugin (prod)         — ${ prodMuRes ? prodMuRes.action : 'skipped' }`,
		sshKeyLine,
		`  aif-wp-mcp skill         — ${ skillRes ? 'installed' : 'skipped' }`,
		`  Agent-md block           — ${ agentMdResults ? agentMdResults.map( ( r ) => r.name + ':' + r.action ).join( ', ' ) : 'skipped' }`,
		`  .mcp.json (local server) — ${ localRes ? localRes.action + ' (' + env.WP_LOCAL_MCP_SERVER + ')' : 'skipped (no local)' }`,
		`  .mcp.json (prod server)  — ${ prodRes ? prodRes.action + ' (' + env.WP_PROD_MCP_SERVER + ')' : 'skipped' }`,
	];
	process.stdout.write( '\n' + summary.join( '\n' ) + '\n\n' );

	// Next-step hints.
	const hints = [
		'Next steps:',
		'  1. Restart Claude Code in this directory so it picks up the new .mcp.json.',
		'  2. If you previously had a user-scope `wordpress-local` or `wordpress-prod` server',
		'     pointing at another project, remove it: `claude mcp remove <name> --scope user`.',
		'     (Project-scope entry from this .mcp.json takes precedence, but stale user-scope',
		'     entries cause confusion in Claude Code GUI.)',
		'  3. Run `/aif-docs` if you want documentation in docs/ to mention the MCP abilities',
		'     (this CLI only manages the block inside CLAUDE.md; docs/ is owned by /aif-docs).',
		'  4. Run `seomi-wp-mcp doctor` to verify everything is wired up correctly.',
	];
	if ( muMode === 'skip' ) {
		hints.push( '  5. Install the seomi-mcp-abilities mu-plugin on your WordPress target' );
		hints.push( '     (e.g. as part of your deploy) — clone or composer require it into' );
		hints.push( '     wp-content/mu-plugins/seomi-mcp-abilities/ and add the loader shim' );
		hints.push( '     at wp-content/mu-plugins/mcp-abilities.php.' );
	}
	if ( depResults?.manualSnippet ) {
		hints.push( '  5. Finish manual local plugin install (see commands printed above).' );
	}
	if ( prodDepResults?.manualSnippet ) {
		hints.push( '  6. Finish manual prod plugin install (see commands printed above).' );
	}
	process.stdout.write( '\n' + hints.join( '\n' ) + '\n' );

	logger.success( 'Done.' );
	return 0;
}
