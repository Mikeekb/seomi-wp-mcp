/**
 * Auto-install WordPress plugins (Abilities API + MCP Adapter and any others).
 *
 * Strategy chain, in order of preference:
 *   1. Local WP-CLI: `wp plugin install <zip> --activate`
 *   2. Zip download + unpack into wp-content/plugins/ (no activation — prints reminder)
 *   3. WP REST /wp/v2/plugins via Basic auth (only works for wp.org slugs — our deps
 *      are on GitHub, so this is usually skipped, but kept for future use)
 *   4. Print manual instructions
 *
 * Each plugin spec:
 *   { slug, githubRepo, ref?, optional?, label }
 *
 * Idempotency:
 *   - WP-CLI strategy checks `wp plugin is-active <slug>` before installing.
 *   - Zip strategy checks if the target directory exists.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readdir, rename } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from './logger.mjs';

export const DEFAULT_DEPS = [
	{
		slug: 'abilities-api',
		githubRepo: 'WordPress/abilities-api',
		ref: 'trunk',
		label: 'WP Abilities API',
	},
	{
		slug: 'mcp-adapter',
		githubRepo: 'WordPress/mcp-adapter',
		ref: 'trunk',
		label: 'MCP Adapter',
	},
];

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
 * Build WP-CLI scope flags: either --path=<wpRoot> (local) or --ssh=<spec> (remote).
 * Exactly one must be provided. SSH takes precedence if both are set.
 */
function wpScopeFlags( { wpRoot, sshSpec } ) {
	if ( sshSpec ) return [ '--ssh=' + sshSpec ];
	if ( wpRoot ) return [ '--path=' + wpRoot ];
	return [];
}

/**
 * Run WP-CLI. Prefers `php <phar>` when a phar path is known — this avoids the
 * Windows-specific issue where `spawn('wp', ...)` fails to find `wp.bat`/`wp.cmd`
 * shims without `shell: true`. Falls back to the `wp` command (with shell on
 * Windows) when no phar is provided.
 *
 * @param {Object}        scope
 * @param {string}        [scope.wpCliPharPath]  Absolute path to wp-cli.phar (preferred).
 * @param {string}        [scope.wpRoot]
 * @param {string}        [scope.sshSpec]
 * @param {string[]}      args                   WP-CLI args (without phar or scope flags).
 */
async function runWp( scope, args ) {
	const fullArgs = [ ...args, ...wpScopeFlags( scope ) ];
	if ( scope.wpCliPharPath ) {
		return exec( 'php', [ scope.wpCliPharPath, ...fullArgs ] );
	}
	// Fallback: PATH lookup. On Windows wp resolves to wp.bat — needs shell.
	return exec( 'wp', fullArgs, { shell: process.platform === 'win32' } );
}

async function wpCliAvailable( scope ) {
	const r = await runWp( scope, [ '--info' ] );
	logger.debug( `wp-plugin-installer: wp --info exit=${ r.code } at ${ scope.sshSpec || scope.wpRoot } via ${ scope.wpCliPharPath ? 'phar' : 'wp-shim' }` );
	return r.code === 0;
}

/**
 * Detect the WordPress version of the target site.
 * Returns a parsed { major, minor, raw } or null if detection fails.
 *
 * Used to skip the now-archived `abilities-api` plugin on WP 6.9+, where the
 * Abilities API is built into core (https://github.com/WordPress/abilities-api
 * was archived on 2026-02-05 once the API merged into WP core).
 */
async function detectWpVersion( scope ) {
	const r = await runWp( scope, [ 'core', 'version' ] );
	if ( r.code !== 0 ) return null;
	const m = r.stdout.trim().match( /^(\d+)\.(\d+)/ );
	if ( ! m ) return null;
	return { major: parseInt( m[1], 10 ), minor: parseInt( m[2], 10 ), raw: r.stdout.trim() };
}

function abilitiesApiInCore( version ) {
	if ( ! version ) return false;
	if ( version.major > 6 ) return true;
	return version.major === 6 && version.minor >= 9;
}

async function wpCliIsActive( scope, slug ) {
	const r = await runWp( scope, [ 'plugin', 'is-active', slug ] );
	return r.code === 0;
}

async function wpCliInstall( scope, source ) {
	logger.info( `wp-cli: installing ${ source }` );
	const r = await runWp( scope, [ 'plugin', 'install', source, '--activate', '--force' ] );
	if ( r.code !== 0 ) {
		logger.debug( `wp-cli stderr: ${ r.stderr.trim() }` );
	}
	return r.code === 0;
}

async function wpCliActivate( scope, slug ) {
	logger.info( `wp-cli: activating ${ slug }` );
	const r = await runWp( scope, [ 'plugin', 'activate', slug ] );
	if ( r.code !== 0 ) {
		logger.debug( `wp-cli activate stderr: ${ r.stderr.trim() }` );
	}
	return r.code === 0;
}

async function downloadZip( url, destPath ) {
	logger.debug( `download: ${ url } -> ${ destPath }` );
	const resp = await fetch( url );
	if ( ! resp.ok ) {
		throw new Error( `HTTP ${ resp.status } for ${ url }` );
	}
	await mkdir( dirname( destPath ), { recursive: true } );
	const buf = Buffer.from( await resp.arrayBuffer() );
	await writeFile( destPath, buf );
	return destPath;
}

function buildZipUrl( spec ) {
	const ref = spec.ref || 'trunk';
	return `https://github.com/${ spec.githubRepo }/archive/refs/heads/${ ref }.zip`;
}

function buildManualSnippet( deps, wpRoot, sshSpec ) {
	const scopeFlag = sshSpec ? ` --ssh=${ sshSpec }` : ( wpRoot ? ` --path=${ wpRoot }` : '' );
	const lines = [];
	lines.push( '# Manual install of WordPress plugin dependencies:' );
	for ( const dep of deps ) {
		const zip = buildZipUrl( dep );
		lines.push( `# ${ dep.label } (${ dep.slug })` );
		lines.push( `wp plugin install ${ zip } --activate --force${ scopeFlag }` );
	}
	return lines.join( '\n' );
}

/**
 * Install dependency plugins on a WordPress site (local or via SSH).
 *
 * @param {Object} cfg
 * @param {string} [cfg.wpRoot]               Absolute path to WP root (for local).
 * @param {string} [cfg.sshSpec]              WP-CLI --ssh= spec (for remote / prod).
 *                                            Format: [user@]host[:port][/path]. If set,
 *                                            wpRoot is ignored and the zip-download
 *                                            fallback is disabled (cannot drop files on
 *                                            a remote filesystem without extra protocol).
 * @param {string} [cfg.wpCliPharPath]        Absolute path to wp-cli.phar. When set,
 *                                            wp-cli is invoked as `php <phar>`. Strongly
 *                                            recommended on Windows to avoid the wp.bat
 *                                            shim issue with Node `spawn`.
 * @param {Array}  [cfg.deps=DEFAULT_DEPS]    Plugin specs.
 * @param {string} [cfg.ref]                  Override git ref for all deps (e.g. 'main' or a tag).
 * @returns {Promise<{ results: Array, manualSnippet: string|null }>}
 */
export async function ensurePlugins( cfg ) {
	const wpRoot = cfg.wpRoot;
	const sshSpec = cfg.sshSpec;
	const wpCliPharPath = cfg.wpCliPharPath;
	const scope = { wpRoot, sshSpec, wpCliPharPath };
	const scopeLabel = sshSpec ? `ssh:${ sshSpec }` : wpRoot;
	const deps = ( cfg.deps || DEFAULT_DEPS ).map( ( d ) => ( cfg.ref ? { ...d, ref: cfg.ref } : d ) );
	const results = [];

	const useWpCli = await wpCliAvailable( scope );

	// Decide whether to skip `abilities-api`: on WP 6.9+ it is part of core
	// (its standalone plugin repo was archived 2026-02-05).
	let wpVersion = null;
	if ( useWpCli ) {
		wpVersion = await detectWpVersion( scope );
		if ( wpVersion ) {
			logger.info( `Detected WordPress ${ wpVersion.raw }` );
		}
	}
	const skipAbilitiesApi = abilitiesApiInCore( wpVersion );

	if ( ! useWpCli ) {
		const hint = sshSpec
			? 'WP-CLI failed to connect over SSH. Verify --ssh spec, key auth, and that wp-cli is installed locally.'
			: 'WP-CLI not available locally — will fall back to zip download (no activation).';
		logger.warn( `${ scopeLabel }: ${ hint }` );
		if ( sshSpec ) {
			// Cannot zip-fallback against a remote filesystem; bail with manual snippet.
			return { results: deps.map( ( d ) => ( { slug: d.slug, action: 'failed', error: 'wp-cli/ssh not available' } ) ), manualSnippet: buildManualSnippet( deps, wpRoot, sshSpec ) };
		}
	}

	for ( const dep of deps ) {
		// Skip abilities-api on WP 6.9+ — it's bundled into core there.
		if ( skipAbilitiesApi && dep.slug === 'abilities-api' ) {
			logger.success( `${ dep.slug } skipped (built into WordPress ${ wpVersion.raw } core)` );
			results.push( { slug: dep.slug, action: 'skipped-in-core' } );
			continue;
		}

		logger.step( `Plugin: ${ dep.label } (${ dep.slug })  [${ scopeLabel }]` );

		if ( useWpCli ) {
			const active = await wpCliIsActive( scope, dep.slug );
			if ( active ) {
				logger.success( `${ dep.slug } already active — skipping` );
				results.push( { slug: dep.slug, action: 'already-active' } );
				continue;
			}
			const zip = buildZipUrl( dep );
			const ok = await wpCliInstall( scope, zip );
			if ( ok ) {
				logger.success( `${ dep.slug } installed and activated via WP-CLI` );
				results.push( { slug: dep.slug, action: 'installed', strategy: sshSpec ? 'wp-cli-ssh' : 'wp-cli' } );
				continue;
			}
			logger.warn( `WP-CLI install failed for ${ dep.slug } — falling back to zip download` );
			if ( sshSpec ) {
				results.push( { slug: dep.slug, action: 'failed', error: 'wp-cli install failed and zip fallback not available over ssh' } );
				continue;
			}
		}

		const pluginsDir = join( wpRoot, 'wp-content', 'plugins' );
		const targetDir = join( pluginsDir, dep.slug );
		if ( existsSync( targetDir ) ) {
			logger.info( `${ targetDir } exists — leaving as is. Activate it from WP admin if needed.` );
			results.push( { slug: dep.slug, action: 'present', strategy: 'zip-existing' } );
			continue;
		}

		try {
			const zipUrl = buildZipUrl( dep );
			const tmpZip = join( tmpdir(), `seomi-wp-mcp-${ dep.slug }-${ Date.now() }.zip` );
			await downloadZip( zipUrl, tmpZip );
			await mkdir( pluginsDir, { recursive: true } );
			const extracted = await unzipTo( tmpZip, pluginsDir );
			if ( extracted && extracted !== dep.slug ) {
				const from = join( pluginsDir, extracted );
				if ( existsSync( from ) ) {
					await rename( from, targetDir );
				}
			}
			await rm( tmpZip, { force: true } );

			// If WP-CLI is reachable, finish the job with `plugin activate`.
			if ( useWpCli ) {
				const activated = await wpCliActivate( scope, dep.slug );
				if ( activated ) {
					logger.success( `${ dep.slug } extracted + activated via WP-CLI` );
					results.push( { slug: dep.slug, action: 'installed', strategy: 'zip+wp-cli-activate' } );
					continue;
				}
				logger.warn( `${ dep.slug } extracted but WP-CLI activate failed — activate manually from WP admin` );
			} else {
				logger.success( `${ dep.slug } extracted to ${ targetDir } — activate from WP admin (no WP-CLI available)` );
			}
			results.push( { slug: dep.slug, action: 'extracted', strategy: 'zip-download', needsManualActivation: true } );
		} catch ( err ) {
			logger.error( `Failed to install ${ dep.slug }: ${ err.message }` );
			results.push( { slug: dep.slug, action: 'failed', error: err.message } );
		}
	}

	const anyFailed = results.some( ( r ) => r.action === 'failed' || r.needsManualActivation );
	const manualSnippet = anyFailed ? buildManualSnippet( deps, wpRoot ) : null;

	return { results, manualSnippet };
}

/**
 * Best-effort zip extraction using PowerShell (Windows) or `unzip` (POSIX).
 * Returns the name of the top-level directory in the archive (or null if unknown).
 */
async function unzipTo( zipPath, destDir ) {
	if ( process.platform === 'win32' ) {
		const psCmd = `Expand-Archive -LiteralPath '${ zipPath.replace( /'/g, "''" ) }' -DestinationPath '${ destDir.replace( /'/g, "''" ) }' -Force`;
		const r = await exec( 'powershell.exe', [ '-NoProfile', '-Command', psCmd ] );
		if ( r.code !== 0 ) throw new Error( `PowerShell Expand-Archive failed: ${ r.stderr.trim() || 'exit ' + r.code }` );
	} else {
		const r = await exec( 'unzip', [ '-o', zipPath, '-d', destDir ] );
		if ( r.code !== 0 ) throw new Error( `unzip failed: ${ r.stderr.trim() || 'exit ' + r.code }` );
	}
	// Detect the top-level dir created by the archive (e.g. abilities-api-trunk).
	const entries = await readdir( destDir, { withFileTypes: true } );
	const candidates = entries
		.filter( ( e ) => e.isDirectory() )
		.map( ( e ) => e.name )
		.sort( ( a, b ) => b.length - a.length );
	return candidates[0] ?? null;
}

export const _internals = { buildZipUrl, buildManualSnippet, exec };
