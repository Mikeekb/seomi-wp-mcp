/**
 * Auto-install WP-CLI on a remote SSH host.
 *
 * Strategy chain (run in order, no interactive prompts):
 *
 *   1. Probe     — `ssh ... 'command -v wp || command -v wp-cli.phar'`.
 *                  exit 0 + stdout → already installed at the printed path,
 *                  return `already-present`. exit ≥ 1 → continue. exit 255
 *                  (ssh connect/auth fail) → bail out as `failed` with a
 *                  manual-install snippet.
 *   2. ToolProbe — `ssh ... 'command -v php; command -v curl; command -v wget'`,
 *                  parsed line-by-line. Missing php → `failed` (php is required
 *                  to run wp-cli.phar at all).
 *   3. Download  — strategy chain: curl → wget → ssh-pipe (local fetch + stdin
 *                  to remote). Drops wp-cli.phar at $HOME/bin/wp-cli.phar.
 *   4. Wrapper   — write $HOME/bin/wp shim (`exec php $HOME/bin/wp-cli.phar "$@"`)
 *                  via ssh stdin pipe, chmod +x.
 *   5. PathSetup — prepend `export PATH="$HOME/bin:$PATH"` to ~/.bashrc and
 *                  ~/.bash_profile (creating bashrc if missing). Inserted at
 *                  the TOP of the file, before any early-return `[ -z "$PS1" ]`
 *                  guards, so non-interactive ssh actually picks it up.
 *                  Idempotent via a marker block.
 *   6. Verify    — `ssh -o BatchMode=yes ... 'wp --info'`. On 127 / not found,
 *                  fall back to `$HOME/bin/wp --info` to detect the PATH-not-
 *                  -picked-up edge case (some shared hosts ignore ~/.bashrc).
 *
 * Self-contained on purpose — does NOT import from other src/lib modules.
 * The project architecture forbids lib→lib horizontal imports, so this file
 * carries its own thin spawn() wrapper (identical contract to the one in
 * ssh-mu-plugin-installer.mjs).
 */

import { spawn } from 'node:child_process';
import { logger } from './logger.mjs';

export const WP_CLI_PHAR_URL =
	'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';

const PATH_MARKER_OPEN = '# >>> seomi-wp-mcp: PATH >>>';
const PATH_MARKER_CLOSE = '# <<< seomi-wp-mcp: PATH <<<';
const PATH_BLOCK = [
	PATH_MARKER_OPEN,
	'export PATH="$HOME/bin:$PATH"',
	PATH_MARKER_CLOSE,
	'',
].join( '\n' );

const WRAPPER_CONTENT = '#!/bin/sh\nexec php "$HOME/bin/wp-cli.phar" "$@"\n';

/**
 * Spawn a child process and resolve with { code, stdout, stderr }.
 *
 * Custom opts (stripped before the real spawn call):
 *   - `input: <string|Buffer>` → `stdio: ['pipe', 'pipe', 'pipe']`. Pipes the
 *     given payload through stdin (used by the loader-write / wrapper-write /
 *     ssh-pipe download steps). stdout/stderr stay captured so the caller can
 *     inspect remote errors.
 *
 * Without `input` the default is fully-piped stdio (stdout/stderr captured,
 * stdin closed) — used for probes and one-shot `ssh ... cmd` calls.
 */
function exec( cmd, args, opts = {} ) {
	const { input, ...spawnOpts } = opts;
	if ( input !== undefined ) {
		spawnOpts.stdio = [ 'pipe', 'pipe', 'pipe' ];
		logger.debug( `ssh-wp-cli-installer exec: pipe-stdin stdio for ${ cmd }` );
	}
	return new Promise( ( resolve ) => {
		const child = spawn( cmd, args, { shell: false, windowsHide: true, ...spawnOpts } );
		let stdout = '';
		let stderr = '';
		child.stdout?.on( 'data', ( d ) => { stdout += d.toString(); } );
		child.stderr?.on( 'data', ( d ) => { stderr += d.toString(); } );
		child.on( 'error', ( err ) => resolve( { code: -1, stdout, stderr: stderr + err.message } ) );
		child.on( 'close', ( code ) => resolve( { code: code ?? 0, stdout, stderr } ) );
		if ( input !== undefined && child.stdin ) {
			child.stdin.write( input );
			child.stdin.end();
		}
	} );
}

function portArgs( sshPort ) {
	return sshPort ? [ '-p', String( sshPort ) ] : [];
}

function sshTarget( cfg ) {
	return `${ cfg.sshUser }@${ cfg.sshHost }`;
}

/**
 * Parse `[user@]host[:port][/wp-root-path]` (WP-CLI --ssh spec format) back
 * into discrete fields. Returns null when the spec is unparseable.
 *
 * Examples:
 *   ai@host                 → { sshUser: 'ai',   sshHost: 'host', sshPort: '',   wpRoot: '' }
 *   ai@host:2222            → { sshUser: 'ai',   sshHost: 'host', sshPort: '2222', wpRoot: '' }
 *   ai@host/var/www         → { sshUser: 'ai',   sshHost: 'host', sshPort: '',   wpRoot: '/var/www' }
 *   ai@host:2222/var/www    → { sshUser: 'ai',   sshHost: 'host', sshPort: '2222', wpRoot: '/var/www' }
 *   host                    → { sshUser: '',     sshHost: 'host', sshPort: '',   wpRoot: '' }
 */
export function parseSshSpec( spec ) {
	if ( ! spec || typeof spec !== 'string' ) return null;
	const m = spec.match( /^(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/ );
	if ( ! m ) return null;
	return {
		sshUser: m[ 1 ] || '',
		sshHost: m[ 2 ],
		sshPort: m[ 3 ] || '',
		wpRoot: m[ 4 ] || '',
	};
}

/**
 * Probe whether wp (or wp-cli.phar) is reachable on the remote host's
 * non-interactive shell PATH. Returns { ok, remotePath, exit, stderr }.
 *
 * Idempotency: if wp is already there, the rest of the chain short-circuits.
 */
export async function probeRemoteWpCli( cfg ) {
	const port = portArgs( cfg.sshPort );
	const target = sshTarget( cfg );
	logger.debug( `probeRemoteWpCli: target=${ target } port=${ cfg.sshPort || '22' }` );
	const cmd = 'command -v wp 2>/dev/null || command -v wp-cli.phar 2>/dev/null';
	const r = await _internals.exec( 'ssh', [ ...port, target, cmd ] );
	logger.debug( `probeRemoteWpCli: exit=${ r.code } stdout=${ r.stdout.trim() }` );
	const found = r.stdout.split( /\r?\n/ ).map( ( s ) => s.trim() ).filter( Boolean )[ 0 ] || null;
	const ok = r.code === 0 && !! found;
	if ( ok ) {
		logger.info( `Remote wp found at ${ found }` );
	}
	return { ok, remotePath: found, exit: r.code, stderr: r.stderr };
}

/**
 * Probe remote host for the tools we need: php (mandatory — to run wp-cli.phar),
 * curl/wget (optional — used by the download strategies), and resolve $HOME/bin
 * so callers can write to a stable location.
 *
 * Uses a single ssh round-trip to keep latency down on slow hosts.
 *
 * Returns:
 *   { php: string|null, curl: string|null, wget: string|null, homeBin: string }
 *
 * `homeBin` falls back to `$HOME/bin` literal if the remote shell did not
 * expand $HOME (extremely unusual). Callers should still send commands that
 * use $HOME, not the literal, so this is just a label for logging.
 */
export async function probeRemoteTools( cfg ) {
	const port = portArgs( cfg.sshPort );
	const target = sshTarget( cfg );
	logger.debug( `probeRemoteTools: target=${ target }` );
	// Three printlns + a HOME marker. Empty values are fine (means tool absent).
	const remoteCmd =
		'echo PHP=$(command -v php 2>/dev/null); '
		+ 'echo CURL=$(command -v curl 2>/dev/null); '
		+ 'echo WGET=$(command -v wget 2>/dev/null); '
		+ 'echo HOME_BIN=$HOME/bin';
	const r = await _internals.exec( 'ssh', [ ...port, target, remoteCmd ] );
	logger.debug( `probeRemoteTools: exit=${ r.code } stdout=${ r.stdout.trim() }` );

	const parsed = { php: null, curl: null, wget: null, homeBin: '$HOME/bin' };
	for ( const line of r.stdout.split( /\r?\n/ ) ) {
		const m = line.trim().match( /^([A-Z_]+)=(.*)$/ );
		if ( ! m ) continue;
		const value = m[ 2 ].trim();
		if ( m[ 1 ] === 'PHP' && value ) parsed.php = value;
		else if ( m[ 1 ] === 'CURL' && value ) parsed.curl = value;
		else if ( m[ 1 ] === 'WGET' && value ) parsed.wget = value;
		else if ( m[ 1 ] === 'HOME_BIN' && value ) parsed.homeBin = value;
	}

	if ( parsed.php ) logger.debug( `probeRemoteTools: php at ${ parsed.php }` );
	if ( parsed.curl ) logger.debug( `probeRemoteTools: curl at ${ parsed.curl }` );
	if ( parsed.wget ) logger.debug( `probeRemoteTools: wget at ${ parsed.wget }` );
	logger.debug( `probeRemoteTools: homeBin=${ parsed.homeBin }` );

	return parsed;
}

/**
 * Strategy A — curl. Single ssh round-trip: mkdir + download + chmod.
 * Uses `-fsSL`: fail on HTTP errors, silent, follow redirects (the github
 * raw URL 302-redirects to a CDN).
 */
async function downloadViaCurl( cfg, remotePharPath ) {
	const port = portArgs( cfg.sshPort );
	const target = sshTarget( cfg );
	const cmd =
		`mkdir -p "$HOME/bin" && `
		+ `curl -fsSL -o "${ remotePharPath }" ${ WP_CLI_PHAR_URL } && `
		+ `chmod +x "${ remotePharPath }"`;
	logger.info( `Downloading wp-cli.phar via curl on ${ target }` );
	const r = await _internals.exec( 'ssh', [ ...port, target, cmd ] );
	if ( r.code !== 0 ) {
		logger.warn( `curl download failed (exit ${ r.code }): ${ r.stderr.trim() }` );
	}
	return { ok: r.code === 0, stderr: r.stderr };
}

/**
 * Strategy B — wget. Same shape as curl. -q quiet, -O writes to file.
 */
async function downloadViaWget( cfg, remotePharPath ) {
	const port = portArgs( cfg.sshPort );
	const target = sshTarget( cfg );
	const cmd =
		`mkdir -p "$HOME/bin" && `
		+ `wget -q -O "${ remotePharPath }" ${ WP_CLI_PHAR_URL } && `
		+ `chmod +x "${ remotePharPath }"`;
	logger.info( `Downloading wp-cli.phar via wget on ${ target }` );
	const r = await _internals.exec( 'ssh', [ ...port, target, cmd ] );
	if ( r.code !== 0 ) {
		logger.warn( `wget download failed (exit ${ r.code }): ${ r.stderr.trim() }` );
	}
	return { ok: r.code === 0, stderr: r.stderr };
}

/**
 * Strategy C — local fetch + ssh stdin pipe. Works even when the remote host
 * has no outbound HTTP access (firewalled DBs etc.) as long as our local
 * machine can reach GitHub.
 *
 * Two ssh calls: first creates $HOME/bin, second pipes the phar bytes into
 * the destination file. Doing both in one cat-fed shell would force us to
 * mix shell quoting with binary input, which is fragile.
 */
async function downloadViaSshPipe( cfg, remotePharPath ) {
	const port = portArgs( cfg.sshPort );
	const target = sshTarget( cfg );
	logger.info( `Downloading wp-cli.phar locally, piping to ${ target } via ssh` );

	let buf;
	try {
		const resp = await fetch( WP_CLI_PHAR_URL );
		if ( ! resp.ok ) {
			throw new Error( `HTTP ${ resp.status } for ${ WP_CLI_PHAR_URL }` );
		}
		buf = Buffer.from( await resp.arrayBuffer() );
		logger.debug( `Fetched ${ buf.length } bytes locally` );
	} catch ( err ) {
		logger.warn( `local fetch failed: ${ err.message }` );
		return { ok: false, stderr: err.message };
	}

	const mkdir = await _internals.exec( 'ssh', [ ...port, target, 'mkdir -p "$HOME/bin"' ] );
	if ( mkdir.code !== 0 ) {
		logger.warn( `mkdir $HOME/bin failed (exit ${ mkdir.code }): ${ mkdir.stderr.trim() }` );
		return { ok: false, stderr: mkdir.stderr };
	}

	// `cat > path && chmod +x path` — write payload then make executable in
	// one remote shell so the file is never present without the +x bit.
	const writeCmd = `cat > "${ remotePharPath }" && chmod +x "${ remotePharPath }"`;
	const write = await _internals.exec( 'ssh', [ ...port, target, writeCmd ], { input: buf } );
	if ( write.code !== 0 ) {
		logger.warn( `ssh-pipe write failed (exit ${ write.code }): ${ write.stderr.trim() }` );
		return { ok: false, stderr: write.stderr };
	}
	return { ok: true, stderr: '' };
}

/**
 * Download orchestrator. Tries curl → wget → ssh-pipe in order, returns the
 * first one that succeeded.
 *
 * Tools probe (`probeRemoteTools`) determines which remote-side strategies are
 * even worth attempting — we skip curl/wget if the binary is missing rather
 * than letting the ssh shell waste a round-trip with "command not found".
 *
 * @returns {Promise<{ ok: boolean, strategy: string|null, remotePath: string, stderr: string }>}
 */
async function downloadWpCliPhar( cfg, tools ) {
	const remotePharPath = '$HOME/bin/wp-cli.phar';

	if ( tools.curl ) {
		const r = await downloadViaCurl( cfg, remotePharPath );
		if ( r.ok ) return { ok: true, strategy: 'curl', remotePath: remotePharPath, stderr: '' };
	} else {
		logger.debug( 'curl not present on remote — skipping curl strategy' );
	}

	if ( tools.wget ) {
		const r = await downloadViaWget( cfg, remotePharPath );
		if ( r.ok ) return { ok: true, strategy: 'wget', remotePath: remotePharPath, stderr: '' };
	} else {
		logger.debug( 'wget not present on remote — skipping wget strategy' );
	}

	const r = await downloadViaSshPipe( cfg, remotePharPath );
	if ( r.ok ) return { ok: true, strategy: 'ssh-pipe', remotePath: remotePharPath, stderr: '' };

	return { ok: false, strategy: null, remotePath: remotePharPath, stderr: r.stderr };
}

/**
 * Drop a tiny shell wrapper at $HOME/bin/wp so the user can invoke `wp` as
 * a regular command, without remembering to prefix with `php`. The wrapper
 * sources the phar through php at call time, so re-downloading the phar
 * is enough to upgrade wp-cli.
 *
 * Idempotent: identical content on every run.
 */
async function installWpWrapper( cfg ) {
	const port = portArgs( cfg.sshPort );
	const target = sshTarget( cfg );
	const wrapperPath = '$HOME/bin/wp';
	const writeCmd = `cat > "${ wrapperPath }" && chmod +x "${ wrapperPath }"`;
	logger.info( `Writing wp wrapper at ${ wrapperPath } on ${ target }` );
	const r = await _internals.exec(
		'ssh',
		[ ...port, target, writeCmd ],
		{ input: WRAPPER_CONTENT },
	);
	if ( r.code !== 0 ) {
		logger.warn( `wrapper write failed (exit ${ r.code }): ${ r.stderr.trim() }` );
	}
	return { ok: r.code === 0, path: wrapperPath, stderr: r.stderr };
}

/**
 * Read the remote dotfile contents (or empty string if the file doesn't exist).
 * The remote `cat` returns non-zero on missing file — we treat that as "" so
 * the caller's "prepend our block" logic works uniformly.
 */
async function readRemoteFile( cfg, remotePath ) {
	const port = portArgs( cfg.sshPort );
	const target = sshTarget( cfg );
	// `[ -f path ] && cat path || true` — exit 0 with empty stdout when missing.
	const cmd = `if [ -f "${ remotePath }" ]; then cat "${ remotePath }"; fi`;
	const r = await _internals.exec( 'ssh', [ ...port, target, cmd ] );
	if ( r.code !== 0 ) {
		logger.debug( `readRemoteFile(${ remotePath }) exit=${ r.code }: ${ r.stderr.trim() }` );
		return { exists: false, content: '', error: r.stderr };
	}
	// `if … then cat` writes the file's actual content (and only that) — empty
	// output means the file did not exist.
	return { exists: r.stdout.length > 0, content: r.stdout, error: '' };
}

/**
 * Overwrite a remote dotfile with the given content (idempotent in callers).
 */
async function writeRemoteFile( cfg, remotePath, content ) {
	const port = portArgs( cfg.sshPort );
	const target = sshTarget( cfg );
	const writeCmd = `cat > "${ remotePath }"`;
	const r = await _internals.exec(
		'ssh',
		[ ...port, target, writeCmd ],
		{ input: content },
	);
	return { ok: r.code === 0, stderr: r.stderr };
}

/**
 * Prepend our PATH block to ~/.bashrc and ~/.bash_profile so that
 * non-interactive ssh sessions can find $HOME/bin/wp.
 *
 * Why prepend (not append): Debian/Ubuntu's stock ~/.bashrc opens with
 *   [ -z "$PS1" ] && return
 * which short-circuits the rest of the file for non-interactive shells.
 * Anything appended below that guard is dead code for `ssh user@host wp …`.
 * Putting our `export PATH` before the guard makes it run unconditionally.
 *
 * Idempotency: looks for PATH_MARKER_OPEN in the existing content and skips
 * the write if it's already there.
 *
 * Touches both .bashrc (default bash startup on most distros) and
 * .bash_profile (used by login shells on RHEL family / macOS). For .bashrc
 * we always create it if missing — many minimal hosting accounts ship
 * without one. For .bash_profile we only touch it when it already exists,
 * to avoid breaking systems that intentionally rely on .profile.
 *
 * @returns {{ files: Array<{ path: string, action: 'created'|'updated'|'unchanged' }> }}
 */
async function ensureRemotePath( cfg ) {
	const targets = [
		{ path: '$HOME/.bashrc', createIfMissing: true },
		{ path: '$HOME/.bash_profile', createIfMissing: false },
	];
	const out = [];

	for ( const t of targets ) {
		const existing = await readRemoteFile( cfg, t.path );

		if ( ! existing.exists && ! t.createIfMissing ) {
			logger.debug( `ensureRemotePath: ${ t.path } missing — skipping (createIfMissing=false)` );
			out.push( { path: t.path, action: 'unchanged' } );
			continue;
		}

		if ( existing.content.includes( PATH_MARKER_OPEN ) ) {
			logger.debug( `ensureRemotePath: ${ t.path } already has PATH marker — unchanged` );
			out.push( { path: t.path, action: 'unchanged' } );
			continue;
		}

		// Prepend our block. Keep a blank line between block and existing content
		// so we don't accidentally join with a comment continuation.
		const newContent = existing.exists
			? PATH_BLOCK + '\n' + existing.content
			: PATH_BLOCK + '\n';

		const w = await writeRemoteFile( cfg, t.path, newContent );
		if ( ! w.ok ) {
			logger.warn( `ensureRemotePath: write to ${ t.path } failed: ${ w.stderr.trim() }` );
			out.push( { path: t.path, action: 'unchanged' } );
			continue;
		}
		logger.info( `PATH wired in ${ t.path }` );
		out.push( { path: t.path, action: existing.exists ? 'updated' : 'created' } );
	}

	return { files: out };
}

/**
 * Verify that `wp --info` works on the remote host's non-interactive shell.
 *
 * Primary attempt uses bare `wp` so we exercise the PATH we just wired in.
 * If that fails (typically because the hosting account ignores ~/.bashrc for
 * non-interactive ssh — common on cPanel/Plesk), we retry via the absolute
 * path `$HOME/bin/wp`. A success there means wp-cli IS installed but the
 * PATH did not take; callers should surface that to the user.
 *
 * BatchMode=yes prevents `ssh` from asking for a password — non-zero exit
 * means key auth failed or wp is genuinely unreachable, not "user pressed
 * Ctrl-C at password prompt".
 */
async function verifyRemoteWpCli( cfg ) {
	const port = portArgs( cfg.sshPort );
	const target = sshTarget( cfg );
	const baseArgs = [ '-o', 'BatchMode=yes', ...port, target ];

	logger.debug( `verifyRemoteWpCli: trying bare 'wp --info' on ${ target }` );
	const primary = await _internals.exec( 'ssh', [ ...baseArgs, 'wp --info' ] );
	if ( primary.code === 0 && /WP-CLI/i.test( primary.stdout ) ) {
		logger.info( 'Remote wp --info reachable via PATH' );
		return { ok: true, viaPath: false, remotePath: 'wp', stderr: '' };
	}
	logger.debug( `verifyRemoteWpCli: bare wp exit=${ primary.code } stderr=${ primary.stderr.trim() }` );

	logger.debug( `verifyRemoteWpCli: falling back to "$HOME/bin/wp --info"` );
	const fallback = await _internals.exec( 'ssh', [ ...baseArgs, '"$HOME/bin/wp" --info' ] );
	if ( fallback.code === 0 && /WP-CLI/i.test( fallback.stdout ) ) {
		logger.warn( 'Remote wp reachable only via $HOME/bin/wp — PATH was not picked up by non-interactive ssh' );
		return { ok: true, viaPath: true, remotePath: '$HOME/bin/wp', stderr: '' };
	}

	logger.warn( `verifyRemoteWpCli: both attempts failed (last exit=${ fallback.code })` );
	return {
		ok: false,
		viaPath: false,
		remotePath: null,
		stderr: fallback.stderr || primary.stderr,
	};
}

/**
 * Build a manual-install snippet the user can run themselves when our
 * automation hits a dead-end. Phrased in Russian to match the project's
 * `language.artifacts` setting.
 */
function buildManualSnippet( { sshUser, sshHost, sshPort, failedStep, error } ) {
	const portFragment = sshPort ? ` -p ${ sshPort }` : '';
	const target = `${ sshUser }@${ sshHost }`;
	const lines = [
		`Не удалось автоматически установить WP-CLI на прод (шаг: ${ failedStep }).`,
	];
	if ( error ) {
		lines.push( `Ошибка: ${ String( error ).trim() }` );
	}
	lines.push( '' );
	if ( failedStep === 'probe' ) {
		lines.push( 'SSH-подключение к проду упало. Проверьте ключ/доступ и повторите.' );
	} else if ( failedStep === 'tools' ) {
		lines.push( 'На удалённом хосте отсутствует PHP — WP-CLI без него работать не сможет.' );
		lines.push( 'Установите php (apt install php-cli / yum install php-cli) и повторите.' );
	} else if ( failedStep === 'download' ) {
		lines.push( 'Не удалось скачать wp-cli.phar ни через curl, ни через wget, ни через ssh-pipe.' );
		lines.push( 'Проверьте исходящий HTTPS-доступ с прод-хоста и повторите.' );
	} else if ( failedStep === 'wrapper' ) {
		lines.push( 'wp-cli.phar скачан, но не удалось записать wrapper. Создайте вручную:' );
	} else if ( failedStep === 'verify' ) {
		lines.push( 'wp-cli установлен, но `wp --info` не отрабатывает.' );
		lines.push( 'Возможно non-interactive ssh не подхватил PATH. Команды ниже воспроизводят установку:' );
	}
	lines.push( '' );
	lines.push( '  # Установить WP-CLI на удалённый хост вручную:' );
	lines.push( `  ssh${ portFragment } ${ target } 'mkdir -p $HOME/bin && \\` );
	lines.push( `    curl -fsSL -o $HOME/bin/wp-cli.phar ${ WP_CLI_PHAR_URL } && \\` );
	lines.push( '    chmod +x $HOME/bin/wp-cli.phar && \\' );
	lines.push( "    printf '%s\\n' '#!/bin/sh' 'exec php \"$HOME/bin/wp-cli.phar\" \"$@\"' > $HOME/bin/wp && \\" );
	lines.push( '    chmod +x $HOME/bin/wp && \\' );
	lines.push( '    grep -q "seomi-wp-mcp: PATH" $HOME/.bashrc 2>/dev/null || \\' );
	lines.push( '    (echo \'export PATH="$HOME/bin:$PATH"\' | cat - $HOME/.bashrc > /tmp/.b && mv /tmp/.b $HOME/.bashrc)\'' );
	lines.push( '' );
	lines.push( '  # Проверка:' );
	lines.push( `  ssh${ portFragment } ${ target } 'wp --info'` );
	return lines.join( '\n' );
}

/**
 * Ensure WP-CLI is installed on a remote SSH host. Strategy chain:
 *   1. probe existing wp           → already-present (short-circuit)
 *   2. probe remote tools           → fail if php missing
 *   3. download wp-cli.phar         → curl → wget → ssh-pipe
 *   4. install wrapper $HOME/bin/wp
 *   5. wire $HOME/bin into PATH     → ~/.bashrc + ~/.bash_profile
 *   6. verify wp --info             → installed | installed-no-path | failed
 *
 * @param {Object} cfg
 * @param {string} cfg.sshHost     Remote host.
 * @param {string} cfg.sshUser     Remote SSH user.
 * @param {string} [cfg.sshPort]   Remote SSH port. Blank/omit = ssh default (22).
 * @returns {Promise<{
 *   action: 'already-present' | 'installed' | 'installed-no-path' | 'failed',
 *   remotePath?: string,
 *   downloadStrategy?: string,
 *   pathSetupFiles?: Array<{ path: string, action: string }>,
 *   error?: string,
 *   manualSnippet?: string,
 * }>}
 */
export async function ensureWpCliOnSsh( cfg ) {
	logger.step( 'SSH WP-CLI install' );
	const ctx = { sshHost: cfg.sshHost, sshUser: cfg.sshUser, sshPort: cfg.sshPort || '' };
	logger.debug( `ensureWpCliOnSsh: target=${ ctx.sshUser }@${ ctx.sshHost } port=${ ctx.sshPort || '22' }` );

	// --- 1. Probe -------------------------------------------------------
	const probe = await probeRemoteWpCli( ctx );
	if ( probe.ok ) {
		return { action: 'already-present', remotePath: probe.remotePath };
	}
	if ( probe.exit === 255 ) {
		// SSH connection / auth failure — bail out, the rest of the chain
		// would just re-trigger the same error.
		const error = probe.stderr.trim() || `ssh probe failed with exit ${ probe.exit }`;
		return {
			action: 'failed',
			error,
			manualSnippet: _internals.buildManualSnippet( { ...ctx, failedStep: 'probe', error } ),
		};
	}

	// --- 2. Tool probe --------------------------------------------------
	const tools = await probeRemoteTools( ctx );
	if ( ! tools.php ) {
		const error = 'php not found on remote host';
		logger.warn( error );
		return {
			action: 'failed',
			error,
			manualSnippet: _internals.buildManualSnippet( { ...ctx, failedStep: 'tools', error } ),
		};
	}

	// --- 3. Download phar -----------------------------------------------
	const download = await _internals.downloadWpCliPhar( ctx, tools );
	if ( ! download.ok ) {
		return {
			action: 'failed',
			error: download.stderr,
			manualSnippet: _internals.buildManualSnippet( { ...ctx, failedStep: 'download', error: download.stderr } ),
		};
	}

	// --- 4. Wrapper ------------------------------------------------------
	const wrapper = await _internals.installWpWrapper( ctx );
	if ( ! wrapper.ok ) {
		return {
			action: 'failed',
			error: wrapper.stderr,
			manualSnippet: _internals.buildManualSnippet( { ...ctx, failedStep: 'wrapper', error: wrapper.stderr } ),
		};
	}

	// --- 5. PATH setup ---------------------------------------------------
	const pathRes = await _internals.ensureRemotePath( ctx );

	// --- 6. Verify -------------------------------------------------------
	const verify = await verifyRemoteWpCli( ctx );
	if ( verify.ok && ! verify.viaPath ) {
		logger.success( `WP-CLI installed on ${ ctx.sshUser }@${ ctx.sshHost } (strategy: ${ download.strategy })` );
		return {
			action: 'installed',
			remotePath: wrapper.path,
			downloadStrategy: download.strategy,
			pathSetupFiles: pathRes.files,
		};
	}
	if ( verify.ok && verify.viaPath ) {
		const error = 'WP-CLI installed but $HOME/bin is not on the non-interactive shell PATH';
		return {
			action: 'installed-no-path',
			remotePath: verify.remotePath,
			downloadStrategy: download.strategy,
			pathSetupFiles: pathRes.files,
			error,
			manualSnippet: _internals.buildManualSnippet( { ...ctx, failedStep: 'verify', error } ),
		};
	}

	return {
		action: 'failed',
		error: verify.stderr,
		manualSnippet: _internals.buildManualSnippet( { ...ctx, failedStep: 'verify', error: verify.stderr } ),
	};
}

export const _internals = {
	exec,
	sshTarget,
	portArgs,
	downloadViaCurl,
	downloadViaWget,
	downloadViaSshPipe,
	downloadWpCliPhar,
	installWpWrapper,
	readRemoteFile,
	writeRemoteFile,
	ensureRemotePath,
	verifyRemoteWpCli,
	buildManualSnippet,
};
