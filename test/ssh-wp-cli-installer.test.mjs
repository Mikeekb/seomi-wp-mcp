import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
	ensureWpCliOnSsh,
	probeRemoteWpCli,
	probeRemoteTools,
	parseSshSpec,
	WP_CLI_PHAR_URL,
	_internals,
} from '../src/lib/ssh-wp-cli-installer.mjs';

/**
 * Common router-based stub for `_internals.exec`. The router takes (cmd, args, opts)
 * and returns { code, stdout, stderr } for that specific call. Unrecognized
 * commands fall back to { code: 0, stdout: '', stderr: '' }.
 */
function makeStub( router ) {
	const calls = [];
	const fn = async ( cmd, args, opts = {} ) => {
		calls.push( { cmd, args, opts } );
		return router( cmd, args, opts ) || { code: 0, stdout: '', stderr: '' };
	};
	fn.calls = calls;
	return fn;
}

async function withStubExec( router, run ) {
	const original = _internals.exec;
	const stub = makeStub( router );
	_internals.exec = stub;
	try {
		const result = await run( stub );
		return { result, stub };
	} finally {
		_internals.exec = original;
	}
}

const BASE_CFG = { sshHost: 'host.example', sshUser: 'web', sshPort: '' };

// Detectors for the specific remote commands we issue.
const isProbeWp = ( cmd, args ) =>
	cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a.includes( 'command -v wp' ) );
const isProbeTools = ( cmd, args ) =>
	cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a.includes( 'echo PHP=' ) );
const isCurlDownload = ( cmd, args ) =>
	cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a.includes( 'curl -fsSL' ) );
const isWgetDownload = ( cmd, args ) =>
	cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a.includes( 'wget -q' ) );
const isMkdirBin = ( cmd, args ) =>
	cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a.trim() === 'mkdir -p "$HOME/bin"' );
const isPharWrite = ( cmd, args, opts ) =>
	cmd === 'ssh'
	&& args.some( ( a ) => typeof a === 'string' && a.includes( 'cat > "$HOME/bin/wp-cli.phar"' ) )
	&& opts && opts.input !== undefined;
const isWrapperWrite = ( cmd, args, opts ) =>
	cmd === 'ssh'
	&& args.some( ( a ) => typeof a === 'string' && a.includes( 'cat > "$HOME/bin/wp"' ) && ! a.includes( 'wp-cli.phar' ) )
	&& opts && typeof opts.input === 'string' && opts.input.startsWith( '#!/bin/sh' );
const isReadDotfile = ( file ) => ( cmd, args ) =>
	cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a.includes( `if [ -f "${ file }" ]` ) );
const isWriteDotfile = ( file ) => ( cmd, args, opts ) =>
	cmd === 'ssh'
	&& args.some( ( a ) => typeof a === 'string' && a === `cat > "${ file }"` )
	&& opts && typeof opts.input === 'string';
const isBareVerify = ( cmd, args ) =>
	cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a === 'wp --info' );
const isFallbackVerify = ( cmd, args ) =>
	cmd === 'ssh' && args.some( ( a ) => typeof a === 'string' && a === '"$HOME/bin/wp" --info' );

// ---------------------------------------------------------------------------
// parseSshSpec
// ---------------------------------------------------------------------------

test( 'parseSshSpec: user@host', () => {
	assert.deepEqual( parseSshSpec( 'ai@host' ), {
		sshUser: 'ai', sshHost: 'host', sshPort: '', wpRoot: '',
	} );
} );

test( 'parseSshSpec: user@host:port', () => {
	assert.deepEqual( parseSshSpec( 'ai@host:2222' ), {
		sshUser: 'ai', sshHost: 'host', sshPort: '2222', wpRoot: '',
	} );
} );

test( 'parseSshSpec: user@host/path', () => {
	assert.deepEqual( parseSshSpec( 'ai@host/var/www' ), {
		sshUser: 'ai', sshHost: 'host', sshPort: '', wpRoot: '/var/www',
	} );
} );

test( 'parseSshSpec: user@host:port/path', () => {
	assert.deepEqual( parseSshSpec( 'ai@host:2222/var/www' ), {
		sshUser: 'ai', sshHost: 'host', sshPort: '2222', wpRoot: '/var/www',
	} );
} );

test( 'parseSshSpec: host-only', () => {
	assert.deepEqual( parseSshSpec( 'host' ), {
		sshUser: '', sshHost: 'host', sshPort: '', wpRoot: '',
	} );
} );

test( 'parseSshSpec: empty/garbage', () => {
	assert.equal( parseSshSpec( '' ), null );
	assert.equal( parseSshSpec( null ), null );
	assert.equal( parseSshSpec( 123 ), null );
} );

// ---------------------------------------------------------------------------
// WP_CLI_PHAR_URL
// ---------------------------------------------------------------------------

test( 'WP_CLI_PHAR_URL points to the official phar', () => {
	assert.equal( WP_CLI_PHAR_URL, 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar' );
} );

// ---------------------------------------------------------------------------
// probeRemoteWpCli (direct)
// ---------------------------------------------------------------------------

test( 'probeRemoteWpCli: returns ok with remotePath when wp is present', async () => {
	const { result } = await withStubExec(
		( cmd, args ) => isProbeWp( cmd, args )
			? { code: 0, stdout: '/usr/local/bin/wp\n', stderr: '' }
			: null,
		() => probeRemoteWpCli( BASE_CFG ),
	);
	assert.equal( result.ok, true );
	assert.equal( result.remotePath, '/usr/local/bin/wp' );
} );

test( 'probeRemoteWpCli: empty stdout with exit 0 still counts as not-found', async () => {
	const { result } = await withStubExec(
		() => ( { code: 0, stdout: '', stderr: '' } ),
		() => probeRemoteWpCli( BASE_CFG ),
	);
	assert.equal( result.ok, false );
	assert.equal( result.remotePath, null );
} );

test( 'probeRemoteWpCli: exit 1 → ok=false', async () => {
	const { result } = await withStubExec(
		() => ( { code: 1, stdout: '', stderr: '' } ),
		() => probeRemoteWpCli( BASE_CFG ),
	);
	assert.equal( result.ok, false );
	assert.equal( result.exit, 1 );
} );

// ---------------------------------------------------------------------------
// probeRemoteTools
// ---------------------------------------------------------------------------

test( 'probeRemoteTools: parses PHP/CURL/WGET lines and HOME_BIN', async () => {
	const stdout = [
		'PHP=/usr/bin/php',
		'CURL=/usr/bin/curl',
		'WGET=',
		'HOME_BIN=/home/web/bin',
	].join( '\n' );
	const { result } = await withStubExec(
		() => ( { code: 0, stdout, stderr: '' } ),
		() => probeRemoteTools( BASE_CFG ),
	);
	assert.equal( result.php, '/usr/bin/php' );
	assert.equal( result.curl, '/usr/bin/curl' );
	assert.equal( result.wget, null );
	assert.equal( result.homeBin, '/home/web/bin' );
} );

// ---------------------------------------------------------------------------
// ensureWpCliOnSsh — full orchestrator scenarios
// ---------------------------------------------------------------------------

test( 'ensureWpCliOnSsh: probe finds wp → already-present, no other calls', async () => {
	const { result, stub } = await withStubExec(
		( cmd, args ) => isProbeWp( cmd, args )
			? { code: 0, stdout: '/usr/local/bin/wp\n', stderr: '' }
			: null,
		() => ensureWpCliOnSsh( BASE_CFG ),
	);
	assert.equal( result.action, 'already-present' );
	assert.equal( result.remotePath, '/usr/local/bin/wp' );
	assert.equal( stub.calls.length, 1, 'only probe should run' );
} );

test( 'ensureWpCliOnSsh: probe exit 255 (ssh fail) → failed with manualSnippet', async () => {
	const { result, stub } = await withStubExec(
		( cmd, args ) => isProbeWp( cmd, args )
			? { code: 255, stdout: '', stderr: 'ssh: connect to host: Connection refused' }
			: null,
		() => ensureWpCliOnSsh( BASE_CFG ),
	);
	assert.equal( result.action, 'failed' );
	assert.match( result.manualSnippet, /probe/ );
	assert.equal( stub.calls.length, 1, 'rest of chain must NOT run on ssh fail' );
} );

test( 'ensureWpCliOnSsh: probe miss + no php on remote → failed (tools)', async () => {
	const { result } = await withStubExec(
		( cmd, args ) => {
			if ( isProbeWp( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
			if ( isProbeTools( cmd, args ) ) {
				return { code: 0, stdout: 'PHP=\nCURL=\nWGET=\nHOME_BIN=/home/web/bin\n', stderr: '' };
			}
			return null;
		},
		() => ensureWpCliOnSsh( BASE_CFG ),
	);
	assert.equal( result.action, 'failed' );
	assert.match( result.error, /php/i );
	assert.match( result.manualSnippet, /PHP/ );
} );

test( 'ensureWpCliOnSsh: happy path via curl', async () => {
	const { result, stub } = await withStubExec(
		( cmd, args, opts ) => {
			if ( isProbeWp( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
			if ( isProbeTools( cmd, args ) ) {
				return { code: 0, stdout: 'PHP=/usr/bin/php\nCURL=/usr/bin/curl\nWGET=\nHOME_BIN=/home/web/bin', stderr: '' };
			}
			if ( isCurlDownload( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isWrapperWrite( cmd, args, opts ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isReadDotfile( '$HOME/.bashrc' )( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isReadDotfile( '$HOME/.bash_profile' )( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isWriteDotfile( '$HOME/.bashrc' )( cmd, args, opts ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isBareVerify( cmd, args ) ) return { code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' };
			return null;
		},
		() => ensureWpCliOnSsh( BASE_CFG ),
	);
	assert.equal( result.action, 'installed' );
	assert.equal( result.downloadStrategy, 'curl' );
	assert.equal( result.remotePath, '$HOME/bin/wp' );
	assert.ok( result.pathSetupFiles, 'pathSetupFiles should be populated' );
	// Sanity: wget download must not have been attempted.
	assert.ok( ! stub.calls.some( ( c ) => isWgetDownload( c.cmd, c.args ) ), 'wget must not run when curl succeeds' );
} );

test( 'ensureWpCliOnSsh: curl fails, wget succeeds → strategy=wget', async () => {
	const { result } = await withStubExec(
		( cmd, args, opts ) => {
			if ( isProbeWp( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
			if ( isProbeTools( cmd, args ) ) {
				return { code: 0, stdout: 'PHP=/usr/bin/php\nCURL=/usr/bin/curl\nWGET=/usr/bin/wget\nHOME_BIN=/home/web/bin', stderr: '' };
			}
			if ( isCurlDownload( cmd, args ) ) return { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' };
			if ( isWgetDownload( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isWrapperWrite( cmd, args, opts ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isReadDotfile( '$HOME/.bashrc' )( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isReadDotfile( '$HOME/.bash_profile' )( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isWriteDotfile( '$HOME/.bashrc' )( cmd, args, opts ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isBareVerify( cmd, args ) ) return { code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' };
			return null;
		},
		() => ensureWpCliOnSsh( BASE_CFG ),
	);
	assert.equal( result.action, 'installed' );
	assert.equal( result.downloadStrategy, 'wget' );
} );

test( 'ensureWpCliOnSsh: curl+wget fail, ssh-pipe succeeds → strategy=ssh-pipe', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ( {
		ok: true,
		status: 200,
		arrayBuffer: async () => new Uint8Array( [ 0x23, 0x21 ] ).buffer,
	} );
	try {
		const { result, stub } = await withStubExec(
			( cmd, args, opts ) => {
				if ( isProbeWp( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
				if ( isProbeTools( cmd, args ) ) {
					return { code: 0, stdout: 'PHP=/usr/bin/php\nCURL=/usr/bin/curl\nWGET=/usr/bin/wget\nHOME_BIN=/home/web/bin', stderr: '' };
				}
				if ( isCurlDownload( cmd, args ) ) return { code: 7, stdout: '', stderr: 'curl failed' };
				if ( isWgetDownload( cmd, args ) ) return { code: 1, stdout: '', stderr: 'wget failed' };
				if ( isMkdirBin( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
				if ( isPharWrite( cmd, args, opts ) ) return { code: 0, stdout: '', stderr: '' };
				if ( isWrapperWrite( cmd, args, opts ) ) return { code: 0, stdout: '', stderr: '' };
				if ( isReadDotfile( '$HOME/.bashrc' )( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
				if ( isReadDotfile( '$HOME/.bash_profile' )( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
				if ( isWriteDotfile( '$HOME/.bashrc' )( cmd, args, opts ) ) return { code: 0, stdout: '', stderr: '' };
				if ( isBareVerify( cmd, args ) ) return { code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' };
				return null;
			},
			() => ensureWpCliOnSsh( BASE_CFG ),
		);
		assert.equal( result.action, 'installed' );
		assert.equal( result.downloadStrategy, 'ssh-pipe' );
		// ssh-pipe must have written the phar bytes via stdin
		const pharWriteCall = stub.calls.find( ( c ) => isPharWrite( c.cmd, c.args, c.opts ) );
		assert.ok( pharWriteCall, 'phar write call must be present' );
		assert.ok( Buffer.isBuffer( pharWriteCall.opts.input ), 'phar write input must be a Buffer' );
	} finally {
		globalThis.fetch = originalFetch;
	}
} );

test( 'ensureWpCliOnSsh: verify primary fails, fallback succeeds → installed-no-path', async () => {
	const { result } = await withStubExec(
		( cmd, args, opts ) => {
			if ( isProbeWp( cmd, args ) ) return { code: 1, stdout: '', stderr: '' };
			if ( isProbeTools( cmd, args ) ) {
				return { code: 0, stdout: 'PHP=/usr/bin/php\nCURL=/usr/bin/curl\nWGET=\nHOME_BIN=/home/web/bin', stderr: '' };
			}
			if ( isCurlDownload( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isWrapperWrite( cmd, args, opts ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isReadDotfile( '$HOME/.bashrc' )( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isReadDotfile( '$HOME/.bash_profile' )( cmd, args ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isWriteDotfile( '$HOME/.bashrc' )( cmd, args, opts ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isBareVerify( cmd, args ) ) return { code: 127, stdout: '', stderr: 'bash: wp: command not found' };
			if ( isFallbackVerify( cmd, args ) ) return { code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' };
			return null;
		},
		() => ensureWpCliOnSsh( BASE_CFG ),
	);
	assert.equal( result.action, 'installed-no-path' );
	assert.equal( result.remotePath, '$HOME/bin/wp' );
	assert.ok( result.manualSnippet, 'manualSnippet must be present' );
} );

test( 'ensureRemotePath: marker already present → unchanged, no write', async () => {
	const existing = [
		'# >>> seomi-wp-mcp: PATH >>>',
		'export PATH="$HOME/bin:$PATH"',
		'# <<< seomi-wp-mcp: PATH <<<',
		'',
		'# rest of bashrc',
	].join( '\n' );

	const { result, stub } = await withStubExec(
		( cmd, args, opts ) => {
			if ( isReadDotfile( '$HOME/.bashrc' )( cmd, args ) ) {
				return { code: 0, stdout: existing, stderr: '' };
			}
			if ( isReadDotfile( '$HOME/.bash_profile' )( cmd, args ) ) {
				return { code: 0, stdout: '', stderr: '' };
			}
			if ( isWriteDotfile( '$HOME/.bashrc' )( cmd, args, opts ) ) {
				throw new Error( 'must not write when marker already present' );
			}
			return null;
		},
		() => _internals.ensureRemotePath( BASE_CFG ),
	);

	const bashrcEntry = result.files.find( ( f ) => f.path === '$HOME/.bashrc' );
	assert.equal( bashrcEntry.action, 'unchanged' );
	assert.ok( ! stub.calls.some( ( c ) => isWriteDotfile( '$HOME/.bashrc' )( c.cmd, c.args, c.opts ) ), 'no write to bashrc' );
} );

test( 'ensureRemotePath: bashrc missing → created with marker block at top', async () => {
	let writtenContent = null;
	const { result } = await withStubExec(
		( cmd, args, opts ) => {
			if ( isReadDotfile( '$HOME/.bashrc' )( cmd, args ) ) {
				return { code: 0, stdout: '', stderr: '' };
			}
			if ( isReadDotfile( '$HOME/.bash_profile' )( cmd, args ) ) {
				return { code: 0, stdout: '', stderr: '' };
			}
			if ( isWriteDotfile( '$HOME/.bashrc' )( cmd, args, opts ) ) {
				writtenContent = opts.input;
				return { code: 0, stdout: '', stderr: '' };
			}
			return null;
		},
		() => _internals.ensureRemotePath( BASE_CFG ),
	);

	const bashrcEntry = result.files.find( ( f ) => f.path === '$HOME/.bashrc' );
	assert.equal( bashrcEntry.action, 'created' );
	assert.ok( writtenContent.startsWith( '# >>> seomi-wp-mcp: PATH >>>' ), 'marker block must be at top of file' );
	assert.ok( writtenContent.includes( 'export PATH="$HOME/bin:$PATH"' ) );
} );

test( 'ensureRemotePath: existing bashrc with early-return guard → marker block prepended, original kept', async () => {
	const existing = [
		'# ~/.bashrc: executed by bash(1) for non-login shells.',
		'',
		'# If not running interactively, don\'t do anything',
		'[ -z "$PS1" ] && return',
		'',
		'alias ll="ls -lah"',
	].join( '\n' );
	let writtenContent = null;
	await withStubExec(
		( cmd, args, opts ) => {
			if ( isReadDotfile( '$HOME/.bashrc' )( cmd, args ) ) {
				return { code: 0, stdout: existing, stderr: '' };
			}
			if ( isReadDotfile( '$HOME/.bash_profile' )( cmd, args ) ) {
				return { code: 0, stdout: '', stderr: '' };
			}
			if ( isWriteDotfile( '$HOME/.bashrc' )( cmd, args, opts ) ) {
				writtenContent = opts.input;
				return { code: 0, stdout: '', stderr: '' };
			}
			return null;
		},
		() => _internals.ensureRemotePath( BASE_CFG ),
	);
	const markerIdx = writtenContent.indexOf( '# >>> seomi-wp-mcp: PATH >>>' );
	const guardIdx = writtenContent.indexOf( '[ -z "$PS1" ] && return' );
	assert.ok( markerIdx >= 0, 'marker present' );
	assert.ok( guardIdx >= 0, 'original guard preserved' );
	assert.ok( markerIdx < guardIdx, 'marker block MUST appear before early-return guard' );
} );
