/**
 * Install the seomi-mcp-abilities mu-plugin on a remote WordPress host over SSH.
 *
 * Strategy chain (run in order, no interactive prompts):
 *
 *   1. Probe    — `ssh ... 'test -d <wpRoot>/wp-content/mu-plugins/<slug>'`.
 *                 exit 0 → already present, return early without touching the
 *                 remote host. exit 1 → continue with clone. Any other exit
 *                 code (typically 255 = ssh connect error) → bail out as
 *                 `failed` with a manual-install snippet.
 *   2. Clone    — single remote command: `mkdir -p <muPluginsDir> &&
 *                 git clone --depth=1 <repoUrl> <targetDir> &&
 *                 rm -rf <targetDir>/.git`. The post-clone `rm -rf .git`
 *                 prevents the mu-plugin from being detected as a git
 *                 submodule by the host's WP install and keeps repeat runs
 *                 idempotent (the probe in step 1 short-circuits next time).
 *   3. Loader   — `ssh ... 'cat > <wpRoot>/wp-content/mu-plugins/mcp-abilities.php'`
 *                 with the 4-line PHP shim piped through stdin. Mirrors the
 *                 mechanism `ssh-key-setup.mjs` uses for the pubkey copy.
 *
 * Self-contained on purpose — does NOT import from other src/lib modules.
 * The project architecture forbids lib→lib horizontal imports, so this file
 * carries its own thin spawn() wrapper (identical contract to the one in
 * ssh-key-setup.mjs, including the `input` and `interactive` opts).
 */

import { spawn } from 'node:child_process';
import { logger } from './logger.mjs';

/**
 * Spawn a child process and resolve with { code, stdout, stderr }.
 *
 * Custom opts (stripped before the real spawn call):
 *   - `input: <string>` → `stdio: ['pipe', 'inherit', 'inherit']`. Used for
 *     the loader-write step: the PHP shim is piped through stdin and the
 *     remote shell redirects it into the loader file.
 *
 * Without `input` the default is fully-piped stdio (stdout/stderr captured,
 * stdin closed) — used for the probe and the clone command.
 */
function exec( cmd, args, opts = {} ) {
	const { input, ...spawnOpts } = opts;
	if ( typeof input === 'string' ) {
		spawnOpts.stdio = [ 'pipe', 'inherit', 'inherit' ];
		logger.debug( `ssh-mu-plugin-installer exec: pipe-stdin stdio for ${ cmd }` );
	}
	return new Promise( ( resolve ) => {
		const child = spawn( cmd, args, { shell: false, windowsHide: true, ...spawnOpts } );
		let stdout = '';
		let stderr = '';
		child.stdout?.on( 'data', ( d ) => { stdout += d.toString(); } );
		child.stderr?.on( 'data', ( d ) => { stderr += d.toString(); } );
		child.on( 'error', ( err ) => resolve( { code: -1, stdout, stderr: stderr + err.message } ) );
		child.on( 'close', ( code ) => resolve( { code: code ?? 0, stdout, stderr } ) );
		if ( typeof input === 'string' && child.stdin ) {
			child.stdin.write( input );
			child.stdin.end();
		}
	} );
}

function portArgs( sshPort ) {
	return sshPort ? [ '-p', String( sshPort ) ] : [];
}

/**
 * Single-quote a string for safe interpolation inside a remote sh -c command.
 * Embedded single quotes are escaped via the standard '\'' trick:
 *   foo'bar  →  'foo'\''bar'
 */
function shellQuote( s ) {
	return `'${ String( s ).replace( /'/g, "'\\''" ) }'`;
}

/**
 * Build the remote `git clone` script.
 *
 * Exported via _internals for test introspection so the test can assert the
 * command shape without re-running ssh.
 */
function buildRemoteScript( { muPluginsDir, targetDir, repoUrl } ) {
	const qDir = shellQuote( muPluginsDir );
	const qTarget = shellQuote( targetDir );
	const qRepo = shellQuote( repoUrl );
	return `mkdir -p ${ qDir } && git clone --depth=1 ${ qRepo } ${ qTarget } && rm -rf ${ qTarget }/.git`;
}

function buildManualSnippet( {
	sshUser,
	sshHost,
	sshPort,
	wpRoot,
	repoUrl,
	slug,
	loaderPath,
	loaderContent,
	failedStep,
	stderr,
} ) {
	const portFragment = sshPort ? ` -p ${ sshPort }` : '';
	const target = `${ sshUser }@${ sshHost }`;
	const targetDir = `${ wpRoot }/wp-content/mu-plugins/${ slug }`;
	const lines = [
		`Не удалось автоматически установить mu-plugin на прод (шаг: ${ failedStep }).`,
	];
	if ( stderr ) {
		lines.push( `Ошибка: ${ stderr.trim() }` );
	}
	lines.push( '' );
	if ( failedStep === 'probe' ) {
		lines.push( 'SSH-подключение к проду упало. Проверьте ключ/доступ и затем выполните вручную:' );
	} else if ( failedStep === 'clone' ) {
		lines.push( 'Возможные причины: на проде нет `git`, нет сети, или нет прав на mu-plugins/.' );
		lines.push( 'Установите git (apt install git / yum install git) и выполните:' );
	} else if ( failedStep === 'loader' ) {
		lines.push( 'Mu-plugin склонирован, но loader-шим не записан.' );
		lines.push( 'Создайте файл вручную:' );
	}
	lines.push( '' );
	lines.push( `  ssh${ portFragment } ${ target } 'mkdir -p ${ wpRoot }/wp-content/mu-plugins && git clone --depth=1 ${ repoUrl } ${ targetDir } && rm -rf ${ targetDir }/.git'` );
	lines.push( '' );
	lines.push( `  ssh${ portFragment } ${ target } 'cat > ${ loaderPath }' <<'PHP'` );
	lines.push( loaderContent.trimEnd() );
	lines.push( 'PHP' );
	return lines.join( '\n' );
}

/**
 * Ensure the seomi-mcp-abilities mu-plugin is installed on a remote WP host.
 *
 * @param {Object} cfg
 * @param {string} cfg.sshHost        Remote host (e.g. 'newbeone.beget.tech').
 * @param {string} cfg.sshUser        Remote SSH user.
 * @param {string} [cfg.sshPort='']   Remote SSH port. Blank = default 22.
 * @param {string} cfg.wpRoot         Absolute WP root on remote (e.g.
 *                                    '/home/user/site/public_html').
 * @param {string} cfg.repoUrl        Public git URL of the mu-plugin repo.
 * @param {string} cfg.slug           Folder name under mu-plugins/
 *                                    (e.g. 'seomi-mcp-abilities').
 * @param {string} cfg.loaderContent  Full text of the PHP loader shim to
 *                                    write at wp-content/mu-plugins/mcp-abilities.php.
 * @returns {Promise<{
 *   action: 'installed' | 'already-present' | 'partial' | 'failed' | 'skipped',
 *   error?: string,
 *   manualSnippet?: string,
 * }>}
 */
export async function ensureMuPluginOnSsh( cfg ) {
	const { sshHost, sshUser, wpRoot, repoUrl, slug, loaderContent } = cfg;
	const sshPort = cfg.sshPort || '';
	const sshTarget = `${ sshUser }@${ sshHost }`;
	const port = portArgs( sshPort );

	const muPluginsDir = `${ wpRoot }/wp-content/mu-plugins`;
	const targetDir = `${ muPluginsDir }/${ slug }`;
	const loaderPath = `${ muPluginsDir }/mcp-abilities.php`;

	logger.step( 'SSH mu-plugin install to production' );
	logger.debug( `ssh-mu-plugin-installer: target=${ sshTarget } port=${ sshPort || '22' } wpRoot=${ wpRoot }` );
	logger.debug( `mu-plugin probe: targetDir=${ targetDir }` );

	// --- 1. Probe (idempotency) -----------------------------------------
	const probeCmd = `test -d ${ shellQuote( targetDir ) }`;
	const probe = await _internals.exec( 'ssh', [ ...port, sshTarget, probeCmd ] );

	if ( probe.code === 0 ) {
		logger.success( `mu-plugin already present on prod at ${ targetDir }` );
		return { action: 'already-present' };
	}

	if ( probe.code !== 1 ) {
		// Anything other than 0 (present) or 1 (absent) means ssh itself failed
		// — usually exit 255 (connection / auth error). Bail out with a snippet
		// the user can copy-paste once they've fixed the SSH side.
		const error = ( probe.stderr.trim() || `ssh probe failed with exit ${ probe.code }` );
		logger.warn( `mu-plugin probe failed (exit ${ probe.code }): ${ error }` );
		return {
			action: 'failed',
			error,
			manualSnippet: _internals.buildManualSnippet( {
				sshUser, sshHost, sshPort, wpRoot, repoUrl, slug, loaderPath, loaderContent,
				failedStep: 'probe', stderr: error,
			} ),
		};
	}

	// --- 2. Clone -------------------------------------------------------
	logger.info( 'Cloning mu-plugin via SSH' );
	const remoteCmd = _internals.buildRemoteScript( { muPluginsDir, targetDir, repoUrl } );
	logger.debug( `clone command: ${ remoteCmd }` );
	const clone = await _internals.exec( 'ssh', [ ...port, sshTarget, remoteCmd ] );

	if ( clone.code !== 0 ) {
		const error = clone.stderr.trim() || `git clone failed with exit ${ clone.code }`;
		logger.warn( `mu-plugin clone failed (exit ${ clone.code }): ${ error }` );
		return {
			action: 'failed',
			error,
			manualSnippet: _internals.buildManualSnippet( {
				sshUser, sshHost, sshPort, wpRoot, repoUrl, slug, loaderPath, loaderContent,
				failedStep: 'clone', stderr: error,
			} ),
		};
	}

	// --- 3. Loader ------------------------------------------------------
	logger.info( 'Writing loader shim via SSH stdin' );
	const loaderWriteCmd = `cat > ${ shellQuote( loaderPath ) }`;
	const loader = await _internals.exec(
		'ssh',
		[ ...port, sshTarget, loaderWriteCmd ],
		{ input: loaderContent },
	);

	if ( loader.code !== 0 ) {
		const error = loader.stderr.trim() || `loader write failed with exit ${ loader.code }`;
		logger.warn( `mu-plugin loader write failed (exit ${ loader.code }): ${ error }` );
		return {
			action: 'partial',
			error,
			manualSnippet: _internals.buildManualSnippet( {
				sshUser, sshHost, sshPort, wpRoot, repoUrl, slug, loaderPath, loaderContent,
				failedStep: 'loader', stderr: error,
			} ),
		};
	}

	logger.success( `mu-plugin installed at ${ targetDir }` );
	return { action: 'installed' };
}

export const _internals = { exec, buildRemoteScript, buildManualSnippet };
