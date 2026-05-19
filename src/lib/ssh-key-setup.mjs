/**
 * SSH key wizard for `seomi-wp-mcp init`.
 *
 * Sets up passwordless SSH access to a remote host (typically a WordPress
 * production server) in a self-contained strategy chain:
 *
 *   1. Keygen   — generate ed25519 key if missing (`ssh-keygen -N ''`), or
 *                 reuse an existing one. Empty passphrase is intentional:
 *                 the agent needs non-interactive auth, the user can encrypt
 *                 the key later if they want.
 *   2. Copy     — `ssh-copy-id` (asks for the SSH password ONCE), or a
 *                 portable `ssh` fallback that pipes the public key through
 *                 stdin into ~/.ssh/authorized_keys (deduped).
 *   3. Verify   — `ssh -o BatchMode=yes ... 'echo ok'`. BatchMode disables
 *                 password prompts, so a non-zero exit reliably means
 *                 key-auth did not take.
 *   4. Fallback — if verify fails (typical on hosts like Beget that only
 *                 accept keys via the control panel), return a `manualHint`
 *                 string with the .pub content and a how-to.
 *
 * This module is self-contained on purpose — it does NOT import from
 * src/lib/wp-plugin-installer.mjs (which would create a horizontal lib→lib
 * dependency that the project architecture forbids). It carries its own
 * thin spawn() wrapper.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as resolvePath, dirname } from 'node:path';
import { logger } from './logger.mjs';

/**
 * Resolve a path with a leading `~` to an absolute path using the user's
 * home directory. Leaving the literal `~` in place breaks on Windows where
 * the shell does not expand it.
 */
function expandHome( p ) {
	if ( ! p ) return p;
	if ( p === '~' ) return homedir();
	if ( p.startsWith( '~/' ) || p.startsWith( '~\\' ) ) {
		return resolvePath( homedir(), p.slice( 2 ) );
	}
	return p;
}

/**
 * Spawn a child process and resolve with { code, stdout, stderr }.
 *
 * Custom opts (not real spawn options, stripped before the spawn call):
 *   - `interactive: true` → `stdio: ['inherit', 'pipe', 'inherit']`. Used
 *     for `ssh-copy-id`, which needs the user's terminal for the password
 *     prompt but whose stdout we still want to capture in tests.
 *   - `input: <string>`   → `stdio: ['pipe', 'inherit', 'inherit']`. Used
 *     for the ssh-pipe fallback: we write the public key to stdin, the
 *     remote shell appends it to authorized_keys.
 *
 * Without either flag the default is fully-piped stdio (stdout/stderr
 * captured, stdin closed) — used for `ssh-keygen` and the verify step.
 */
function exec( cmd, args, opts = {} ) {
	const { interactive, input, ...spawnOpts } = opts;
	if ( interactive ) {
		spawnOpts.stdio = [ 'inherit', 'pipe', 'inherit' ];
		logger.debug( `ssh-key-setup exec: interactive stdio for ${ cmd }` );
	} else if ( typeof input === 'string' ) {
		spawnOpts.stdio = [ 'pipe', 'inherit', 'inherit' ];
		logger.debug( `ssh-key-setup exec: pipe-stdin stdio for ${ cmd }` );
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
 * Portable ssh-copy-id replacement: pipe the public key through ssh stdin
 * into ~/.ssh/authorized_keys on the remote host. Deduplicates so repeat
 * runs don't keep appending the same key.
 */
const REMOTE_APPEND_SCRIPT =
	'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && '
	+ 'chmod 600 ~/.ssh/authorized_keys && KEY="$(cat)" && '
	+ 'grep -qxF "$KEY" ~/.ssh/authorized_keys || printf \'%s\\n\' "$KEY" >> ~/.ssh/authorized_keys';

function buildManualHint( { pubKeyContent, sshUser, sshHost, sshPort, keyPath } ) {
	const portFragment = sshPort ? ` -p ${ sshPort }` : '';
	return [
		'Не удалось автоматически добавить SSH-ключ — добавьте его через панель хостинга (cPanel / Beget / DirectAdmin / ISPmanager и т.п.).',
		'',
		'Содержимое публичного ключа:',
		'',
		pubKeyContent,
		'',
		'После добавления повторите `seomi-wp-mcp init` или проверьте подключение вручную:',
		`  ssh -i ${ keyPath }${ portFragment } ${ sshUser }@${ sshHost }`,
	].join( '\n' );
}

/**
 * Set up key-based SSH auth for a remote host.
 *
 * @param {Object} cfg
 * @param {string} cfg.sshHost         Remote host (e.g. 'newbeone.beget.tech').
 * @param {string} cfg.sshUser         Remote SSH user.
 * @param {string} [cfg.sshPort='']    Remote SSH port. Blank = ssh default (22).
 * @param {string} [cfg.keyPath]       Absolute path to the private key. `~`
 *                                     is expanded. Default: ~/.ssh/id_ed25519.
 * @param {string} [cfg.comment]       Key comment. Default: `ai-agent@<host>`.
 * @returns {Promise<{
 *   keyPath: string,
 *   pubKeyPath: string,
 *   pubKeyContent: string,
 *   keygenAction: 'created' | 'reused',
 *   copyAction: 'ssh-copy-id' | 'ssh-fallback' | 'failed' | 'skipped',
 *   verified: boolean,
 *   manualHint: string | null,
 * }>}
 */
export async function ensureSshKey( cfg ) {
	const { sshHost, sshUser } = cfg;
	const sshPort = cfg.sshPort || '';
	const keyPath = expandHome( cfg.keyPath ) || resolvePath( homedir(), '.ssh', 'id_ed25519' );
	const pubKeyPath = keyPath + '.pub';
	const comment = cfg.comment || `ai-agent@${ sshHost }`;
	const sshTarget = `${ sshUser }@${ sshHost }`;

	logger.step( 'SSH key setup' );
	logger.debug( `ssh-key-setup: target=${ sshTarget } port=${ sshPort || '22' } keyPath=${ keyPath }` );

	// --- 1. Keygen --------------------------------------------------------
	const keyExists = existsSync( keyPath );
	logger.debug( `keygen: keyPath=${ keyPath } exists=${ keyExists }` );
	let keygenAction;
	if ( keyExists ) {
		try {
			await access( keyPath );
		} catch ( err ) {
			throw new Error( `Private key exists at ${ keyPath } but cannot be read: ${ err.message }` );
		}
		keygenAction = 'reused';
	} else {
		await mkdir( dirname( keyPath ), { recursive: true } );
		const r = await _internals.exec( 'ssh-keygen', [
			'-t', 'ed25519',
			'-N', '',
			'-C', comment,
			'-f', keyPath,
		] );
		if ( r.code !== 0 ) {
			throw new Error( `ssh-keygen failed (exit ${ r.code }): ${ r.stderr.trim() || 'is ssh-keygen on PATH?' }` );
		}
		keygenAction = 'created';
	}

	const pubKeyContent = ( await readFile( pubKeyPath, 'utf8' ) ).trim();

	// --- 2. Copy ----------------------------------------------------------
	logger.info( 'Copying public key via ssh-copy-id' );
	const port = portArgs( sshPort );
	const copyResult = await _internals.exec(
		'ssh-copy-id',
		[ '-i', pubKeyPath, ...port, sshTarget ],
		{ interactive: true },
	);

	let copyAction;
	if ( copyResult.code === 0 ) {
		copyAction = 'ssh-copy-id';
	} else if ( copyResult.code === -1 ) {
		// ssh-copy-id binary not on PATH (typical on Windows OpenSSH).
		logger.warn( 'ssh-copy-id missing — using ssh fallback' );
		const fb = await _internals.exec(
			'ssh',
			[ ...port, sshTarget, REMOTE_APPEND_SCRIPT ],
			{ input: pubKeyContent + '\n' },
		);
		copyAction = fb.code === 0 ? 'ssh-fallback' : 'failed';
		if ( fb.code !== 0 ) {
			logger.warn( `ssh fallback copy failed (exit ${ fb.code })` );
		}
	} else {
		logger.warn( `ssh-copy-id failed (exit ${ copyResult.code }): ${ copyResult.stderr.trim() }` );
		copyAction = 'failed';
	}

	// --- 3. Verify --------------------------------------------------------
	const verifyArgs = [
		'-o', 'BatchMode=yes',
		'-o', 'StrictHostKeyChecking=accept-new',
		'-o', 'ConnectTimeout=10',
		'-i', keyPath,
		...port,
		sshTarget,
		'echo ok',
	];
	logger.debug( `verify: command=ssh ${ verifyArgs.join( ' ' ) }` );
	const verifyResult = await _internals.exec( 'ssh', verifyArgs );
	const verified = verifyResult.code === 0 && verifyResult.stdout.includes( 'ok' );

	// --- 4. Result --------------------------------------------------------
	let manualHint = null;
	if ( verified ) {
		logger.success( 'SSH key copied and verified' );
	} else {
		logger.warn( 'SSH key copy verified=false; printing manual hint' );
		manualHint = buildManualHint( { pubKeyContent, sshUser, sshHost, sshPort, keyPath } );
	}

	return {
		keyPath,
		pubKeyPath,
		pubKeyContent,
		keygenAction,
		copyAction,
		verified,
		manualHint,
	};
}

export const _internals = { exec, buildManualHint, expandHome, REMOTE_APPEND_SCRIPT };
