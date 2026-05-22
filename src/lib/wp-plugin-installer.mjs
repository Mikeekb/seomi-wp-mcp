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
import { parseSshSpec } from './ssh-wp-cli-installer.mjs';

export const DEFAULT_DEPS = [
	{
		slug: 'abilities-api',
		githubRepo: 'WordPress/abilities-api',
		ref: 'trunk',
		useReleases: false,
		label: 'WP Abilities API',
	},
	{
		slug: 'mcp-adapter',
		githubRepo: 'WordPress/mcp-adapter',
		ref: 'trunk',
		useReleases: true,
		label: 'MCP Adapter',
	},
];

/**
 * Spawn a child process and resolve with { code, stdout, stderr }.
 *
 * `opts.interactive` (custom, not a spawn option) controls stdio:
 *   - `false` / unset (default): all three streams are piped — stdout/stderr
 *     are buffered and returned, stdin is closed. Used for everything except
 *     SSH-backed wp-cli calls.
 *   - `true`: `stdio: ['inherit', 'pipe', 'inherit']`. Stdin is the user's
 *     terminal (so `ssh` can read a password from /dev/tty / CONIN$), stderr
 *     is the user's terminal (so the user sees auth errors and ssh hints
 *     instead of having them silently swallowed), but stdout is still piped
 *     so callers like `detectWpVersion`/`wpCliIsActive` can parse the output.
 *
 * The `interactive` flag is stripped from opts before being passed to spawn —
 * spawn would otherwise warn about an unknown option.
 */
function exec( cmd, args, opts = {} ) {
	const { interactive, ...spawnOpts } = opts;
	if ( interactive ) {
		spawnOpts.stdio = [ 'inherit', 'pipe', 'inherit' ];
		logger.debug( `exec: interactive stdio for ${ cmd }` );
	}
	return new Promise( ( resolve ) => {
		const child = spawn( cmd, args, { shell: false, windowsHide: true, ...spawnOpts } );
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
	// Any wp-cli call with --ssh=<spec> shells out to `ssh` under the hood,
	// which reads passwords from a TTY only. Piped stdin hangs forever on
	// Windows OpenSSH (no visible prompt), so SSH-scoped invocations must
	// run in interactive stdio mode.
	const interactive = !! scope.sshSpec;
	if ( interactive ) {
		logger.debug( `runWp: sshSpec=${ scope.sshSpec } → interactive` );
	}
	// Calls route through `_internals.exec` so tests can stub the spawn
	// boundary at a single seam.
	if ( scope.wpCliPharPath ) {
		return _internals.exec( 'php', [ scope.wpCliPharPath, ...fullArgs ], { interactive } );
	}
	// Fallback: PATH lookup. On Windows wp resolves to wp.bat — needs shell.
	return _internals.exec( 'wp', fullArgs, { shell: process.platform === 'win32', interactive } );
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

/**
 * Probe whether `<wp-content>/plugins/<slug>/vendor/autoload.php` is present
 * for the given dep on the target site.
 *
 * Resolves to:
 *   - `true`:  file is present
 *   - `false`: file is missing
 *   - `null`:  could not determine (no scope, wp eval failed, unexpected output)
 *
 * Used by `ensurePlugins` to detect the "active but vendor missing" case for
 * release-tracked plugins that were previously installed from the trunk
 * archive (which ships without `vendor/`). On `false` the caller forces a
 * reinstall from the release asset.
 *
 * Local mode (`scope.wpRoot`): synchronous `existsSync` against the WP root.
 * SSH mode  (`scope.sshSpec`): direct `ssh <host> test -f <abs-path>`. Avoids
 *                              `wp eval`, which is fragile under wp-cli's
 *                              --ssh transport because inner double quotes
 *                              in the PHP code get stripped by the bash
 *                              wrapper around the remote command.
 *                              Returns null on ssh connection/auth errors
 *                              (any exit code other than 0 or 1) so callers
 *                              do not force a reinstall on a transient
 *                              network blip.
 */
async function pluginVendorAutoloadExists( scope, dep ) {
	const scopeLabel = scope.sshSpec ? `ssh:${ scope.sshSpec }` : scope.wpRoot || '<no-scope>';
	if ( scope.sshSpec ) {
		const parsed = parseSshSpec( scope.sshSpec );
		if ( ! parsed || ! parsed.sshHost || ! parsed.wpRoot ) {
			logger.debug( `vendor-check: ${ dep.slug } @ ${ scopeLabel } → null (cannot parse sshSpec)` );
			return null;
		}
		const userHost = parsed.sshUser ? `${ parsed.sshUser }@${ parsed.sshHost }` : parsed.sshHost;
		const remotePath = `${ parsed.wpRoot }/wp-content/plugins/${ dep.slug }/vendor/autoload.php`;
		const args = [];
		if ( parsed.sshPort ) args.push( '-p', parsed.sshPort );
		args.push( '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new' );
		args.push( userHost, 'test', '-f', remotePath );
		const r = await _internals.exec( 'ssh', args );
		if ( r.code === 0 ) {
			logger.debug( `vendor-check: ${ dep.slug } @ ${ scopeLabel } → true (ssh test -f present)` );
			return true;
		}
		if ( r.code === 1 ) {
			logger.debug( `vendor-check: ${ dep.slug } @ ${ scopeLabel } → false (ssh test -f absent)` );
			return false;
		}
		logger.debug( `vendor-check: ${ dep.slug } @ ${ scopeLabel } → null (ssh exit=${ r.code }, stderr="${ ( r.stderr || '' ).trim() }")` );
		return null;
	}
	if ( scope.wpRoot ) {
		const target = join( scope.wpRoot, 'wp-content', 'plugins', dep.slug, 'vendor', 'autoload.php' );
		const result = existsSync( target );
		logger.debug( `vendor-check: ${ dep.slug } @ ${ scopeLabel } → ${ result } (${ target })` );
		return result;
	}
	logger.debug( `vendor-check: ${ dep.slug } @ ${ scopeLabel } → null (no scope.wpRoot/sshSpec)` );
	return null;
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

/**
 * Resolve the latest GitHub Release asset URL for a plugin spec.
 *
 * GitHub source archives (`archive/refs/heads/<ref>.zip`) ship without the
 * Composer-vendored dependencies (`vendor/` is gitignored by most plugins).
 * Release assets are typically built distributions that include `vendor/`,
 * which is what production WP sites need.
 *
 * Best-effort: any failure (404, 403 rate-limit, network, abort, bad JSON,
 * no usable asset) resolves to `null` so the caller can fall back to the
 * trunk URL. The function never throws.
 *
 * Filtering: picks the first asset whose `name` ends with `.zip` and does
 * NOT contain `-src` or `-source` substrings (those are source-only mirrors
 * of the GitHub archive and would defeat the whole point of release resolve).
 *
 * Timeout: 5 seconds via AbortController so a slow GitHub does not hang
 * `init`/`doctor` runs.
 *
 * @param {{ githubRepo: string, slug?: string }} spec
 * @returns {Promise<string|null>}
 */
async function resolveReleaseZipUrl( spec ) {
	const apiUrl = `https://api.github.com/repos/${ spec.githubRepo }/releases/latest`;
	logger.debug( `release-resolver: GET ${ apiUrl }` );

	const controller = new AbortController();
	const timeout = setTimeout( () => controller.abort(), 5000 );
	try {
		const resp = await fetch( apiUrl, {
			signal: controller.signal,
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'seomi-wp-mcp',
			},
		} );
		if ( ! resp.ok ) {
			logger.debug( `release-resolver: ${ spec.githubRepo } no usable release asset (HTTP ${ resp.status })` );
			return null;
		}
		const body = await resp.json();
		const assets = Array.isArray( body?.assets ) ? body.assets : [];
		const asset = assets.find( ( a ) => {
			const name = String( a?.name || '' );
			if ( ! name.toLowerCase().endsWith( '.zip' ) ) return false;
			if ( /-src(\.|-)/i.test( name ) || /-source(\.|-)/i.test( name ) ) return false;
			return true;
		} );
		if ( ! asset?.browser_download_url ) {
			logger.debug( `release-resolver: ${ spec.githubRepo } no usable release asset (no matching zip in ${ assets.length } assets)` );
			return null;
		}
		logger.debug( `release-resolver: ${ spec.githubRepo } latest tag=${ body?.tag_name || '?' }, asset=${ asset.name }, url=${ asset.browser_download_url }` );
		return asset.browser_download_url;
	} catch ( err ) {
		logger.debug( `release-resolver: ${ spec.githubRepo } no usable release asset (${ err.name }: ${ err.message })` );
		return null;
	} finally {
		clearTimeout( timeout );
	}
}

/**
 * Choose the install URL for a plugin spec, with graceful trunk fallback.
 *
 * Priority:
 *   1. `opts.refOverride` set (CLI `--pin-deps=<ref>`)
 *      → ALWAYS trunk URL with that ref. Release lookup is skipped.
 *   2. `spec.useReleases !== true`
 *      → trunk URL via `buildZipUrl(spec)`. No release lookup, no logs.
 *   3. `spec.useReleases === true`
 *      → try `resolveReleaseZipUrl(spec)`.
 *      → on success: { url, source: 'release' }.
 *      → on null (any failure): WARN + trunk fallback { url, source: 'trunk' }.
 *
 * @param {Object} spec
 * @param {{ refOverride?: string|null }} [opts]
 * @returns {Promise<{ url: string, source: 'release' | 'trunk' }>}
 */
async function resolvePluginZipUrl( spec, opts = {} ) {
	const refOverride = opts.refOverride || null;
	if ( refOverride ) {
		logger.info( `Pinned ${ spec.slug } to ${ refOverride } — skipping release lookup` );
		return { url: buildZipUrl( { ...spec, ref: refOverride } ), source: 'trunk' };
	}
	if ( spec.useReleases !== true ) {
		return { url: buildZipUrl( spec ), source: 'trunk' };
	}
	const releaseUrl = await resolveReleaseZipUrl( spec );
	if ( releaseUrl ) {
		logger.info( `${ spec.slug }: using release asset ${ releaseUrl }` );
		return { url: releaseUrl, source: 'release' };
	}
	logger.warn( `${ spec.slug }: release not available — falling back to trunk.zip (vendor/ may be missing; manual composer install may be required)` );
	return { url: buildZipUrl( spec ), source: 'trunk' };
}

function buildManualSnippet( deps, wpRoot, sshSpec ) {
	const scopeFlag = sshSpec ? ` --ssh=${ sshSpec }` : ( wpRoot ? ` --path=${ wpRoot }` : '' );
	const lines = [];
	lines.push( '# Manual install of WordPress plugin dependencies:' );
	let anyReleaseTracked = false;
	for ( const dep of deps ) {
		// For release-tracked plugins, point the user at GitHub's stable
		// `/releases/latest/download/<slug>.zip` URL — it serves the built
		// asset with bundled `vendor/`, which is what the plugin needs to
		// run. The trunk archive (used otherwise) ships without vendor/.
		const zip = dep.useReleases
			? `https://github.com/${ dep.githubRepo }/releases/latest/download/${ dep.slug }.zip`
			: buildZipUrl( dep );
		if ( dep.useReleases ) anyReleaseTracked = true;
		lines.push( `# ${ dep.label } (${ dep.slug })` );
		lines.push( `wp plugin install ${ zip } --activate --force${ scopeFlag }` );
	}
	if ( anyReleaseTracked ) {
		lines.push( '# If a release URL above 404s (asset name changed), open' );
		lines.push( '# https://github.com/<repo>/releases and copy the latest .zip asset URL manually.' );
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
	// `cfg.ref` is the --pin-deps override. We keep it as a separate refOverride
	// instead of mutating each dep's `ref`, because resolvePluginZipUrl needs to
	// know whether a user-specified pin is in effect (in which case release
	// lookup is skipped) vs the spec's own default `ref` (which is only used in
	// the trunk fallback).
	const refOverride = cfg.ref || null;
	const deps = cfg.deps || DEFAULT_DEPS;
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
			? 'WP-CLI not reachable on the remote host. If init already ran ensureWpCliOnSsh, the failure is likely the non-interactive shell PATH not picking up $HOME/bin. See manual install snippet below.'
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
				// For release-tracked plugins, "active" is not enough: a previous
				// install from the trunk archive ships without vendor/, so the
				// plugin loads but fatals on its Composer autoloader. Probe the
				// vendor dir and force a reinstall from the release asset when
				// missing — wpCliInstall already passes --force.
				if ( dep.useReleases === true ) {
					const hasVendor = await pluginVendorAutoloadExists( scope, dep );
					if ( hasVendor === false ) {
						logger.warn( `${ dep.slug }: active but vendor/autoload.php missing — forcing reinstall from release asset` );
						const { url: zip, source } = await resolvePluginZipUrl( dep, { refOverride } );
						const ok = await wpCliInstall( scope, zip );
						if ( ok ) {
							logger.success( `${ dep.slug } reinstalled from release asset (source: ${ source })` );
							results.push( { slug: dep.slug, action: 'reinstalled', strategy: sshSpec ? 'wp-cli-ssh' : 'wp-cli', source, reason: 'missing-vendor' } );
							continue;
						}
						logger.warn( `${ dep.slug }: forced reinstall failed — see WP-CLI stderr above` );
						results.push( { slug: dep.slug, action: 'failed', error: 'forced reinstall failed', reason: 'missing-vendor' } );
						continue;
					}
					logger.debug( `${ dep.slug }: vendor check returned ${ hasVendor } — keeping active` );
				}
				logger.success( `${ dep.slug } already active — skipping` );
				results.push( { slug: dep.slug, action: 'already-active' } );
				continue;
			}
			const { url: zip, source } = await resolvePluginZipUrl( dep, { refOverride } );
			const ok = await wpCliInstall( scope, zip );
			if ( ok ) {
				logger.success( `${ dep.slug } installed and activated via WP-CLI (source: ${ source })` );
				results.push( { slug: dep.slug, action: 'installed', strategy: sshSpec ? 'wp-cli-ssh' : 'wp-cli', source } );
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
			const { url: zipUrl, source } = await resolvePluginZipUrl( dep, { refOverride } );
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

			// GitHub-source plugins usually need `composer install` before they run
			// (their vendor/ is not committed). Best-effort here.
			await maybeRunComposerInstall( targetDir );

			// If WP-CLI is reachable, finish the job with `plugin activate`.
			if ( useWpCli ) {
				const activated = await wpCliActivate( scope, dep.slug );
				if ( activated ) {
					logger.success( `${ dep.slug } extracted + activated via WP-CLI (source: ${ source })` );
					results.push( { slug: dep.slug, action: 'installed', strategy: 'zip+wp-cli-activate', source } );
					continue;
				}
				logger.warn( `${ dep.slug } extracted but WP-CLI activate failed — activate manually from WP admin` );
			} else {
				logger.success( `${ dep.slug } extracted to ${ targetDir } — activate from WP admin (no WP-CLI available; source: ${ source })` );
			}
			results.push( { slug: dep.slug, action: 'extracted', strategy: 'zip-download', source, needsManualActivation: true } );
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
 * Returns the name of the top-level directory the archive created in destDir
 * (e.g. "mcp-adapter-trunk"), or null if detection failed.
 *
 * Detection: snapshot directory listing before extraction, diff after. Earlier
 * versions used "longest name in destDir" as a heuristic, which catastrophically
 * mis-identified the new dir whenever any pre-existing plugin name was longer
 * than the new one (bug fixed in 0.1.6).
 */
async function unzipTo( zipPath, destDir ) {
	const before = new Set();
	try {
		const entries = await readdir( destDir, { withFileTypes: true } );
		for ( const e of entries ) if ( e.isDirectory() ) before.add( e.name );
	} catch ( err ) {
		logger.debug( `unzipTo: readdir(before) failed: ${ err.message }` );
	}

	if ( process.platform === 'win32' ) {
		const psCmd = `Expand-Archive -LiteralPath '${ zipPath.replace( /'/g, "''" ) }' -DestinationPath '${ destDir.replace( /'/g, "''" ) }' -Force`;
		const r = await exec( 'powershell.exe', [ '-NoProfile', '-Command', psCmd ] );
		if ( r.code !== 0 ) throw new Error( `PowerShell Expand-Archive failed: ${ r.stderr.trim() || 'exit ' + r.code }` );
	} else {
		const r = await exec( 'unzip', [ '-o', zipPath, '-d', destDir ] );
		if ( r.code !== 0 ) throw new Error( `unzip failed: ${ r.stderr.trim() || 'exit ' + r.code }` );
	}

	const entriesAfter = await readdir( destDir, { withFileTypes: true } );
	for ( const e of entriesAfter ) {
		if ( e.isDirectory() && ! before.has( e.name ) ) {
			return e.name;
		}
	}
	return null;
}

/**
 * If the extracted plugin contains a composer.json (typical for plugins built
 * from GitHub source, like mcp-adapter), run `composer install --no-dev` so
 * the plugin can find its `vendor/autoload.php`. Best-effort; skipped silently
 * when composer is not on PATH.
 */
async function maybeRunComposerInstall( pluginDir ) {
	const { existsSync } = await import( 'node:fs' );
	if ( ! existsSync( join( pluginDir, 'composer.json' ) ) ) return { ran: false, reason: 'no-composer-json' };
	if ( existsSync( join( pluginDir, 'vendor', 'autoload.php' ) ) ) {
		return { ran: false, reason: 'autoload-already-present' };
	}

	const probe = await exec( 'composer', [ '--version' ], { shell: process.platform === 'win32' } );
	if ( probe.code !== 0 ) {
		logger.warn( `composer not available — skipping \`composer install\` in ${ pluginDir }. Run it manually if the plugin shows an autoloader warning.` );
		return { ran: false, reason: 'composer-missing' };
	}

	logger.info( `Running \`composer install --no-dev\` in ${ pluginDir }` );
	const r = await exec( 'composer', [ 'install', '--no-dev', '--no-interaction', '--optimize-autoloader' ], {
		cwd: pluginDir,
		shell: process.platform === 'win32',
	} );
	if ( r.code !== 0 ) {
		logger.warn( `composer install failed in ${ pluginDir }: ${ r.stderr.trim() }` );
		return { ran: true, ok: false, stderr: r.stderr };
	}
	logger.success( `composer install complete in ${ pluginDir }` );
	return { ran: true, ok: true };
}

export const _internals = { buildZipUrl, buildManualSnippet, exec, runWp, resolveReleaseZipUrl, resolvePluginZipUrl, pluginVendorAutoloadExists };
