import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { detectMetrikaState, setupMetrika, metrikaAuthorizeUrl, browserOpenArgv, verifyMetrikaToken, METRIKA_MCP_SERVER } from '../src/lib/metrika-setup.mjs';
import { venvPythonPath, CLIENT_SERVER_REL } from '../src/lib/metrika-mcp-installer.mjs';

/**
 * setupMetrika is exercised end-to-end against temp dirs; only the Python
 * detection + command runner are injected (via _internals, forwarded to
 * installMetrikaMcp), so mergeEnv / addServerEntry run for real and we assert
 * on the actual .claude/.env and .mcp.json written to disk.
 */

async function tmp() {
	return mkdtemp( join( tmpdir(), 'seomi-metrika-setup-' ) );
}

/** Fake package root with a minimal bundled server. */
async function makeFakeRoot() {
	const root = await tmp();
	const srv = join( root, 'mcp-servers', 'yandex-metrika' );
	await mkdir( join( srv, 'src', 'seomi_metrika' ), { recursive: true } );
	await writeFile( join( srv, 'pyproject.toml' ), '[project]\nname="x"\n', 'utf8' );
	await writeFile( join( srv, 'src', 'seomi_metrika', '__init__.py' ), '', 'utf8' );
	return root;
}

const okPython = () => ( { command: 'py', baseArgs: [ '-3.12' ], version: '3.12.4' } );

/** run() that materialises the venv python on `-m venv`. */
function fakeRun() {
	return ( command, args, opts = {} ) => {
		if ( args.includes( 'venv' ) ) {
			const vp = venvPythonPath( opts.cwd );
			mkdirSync( dirname( vp ), { recursive: true } );
			writeFileSync( vp, '' );
		}
		return { status: 0, output: '' };
	};
}

test( 'setupMetrika: writes .env, builds venv, registers .mcp.json', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	try {
		const res = await setupMetrika( cwd, {
			env: { METRIKA_OAUTH_TOKEN: 'secret-xyz', METRIKA_COUNTER_ID: '111,222' },
			_internals: { pkgRoot: () => root, detectPython: okPython, run: fakeRun() },
		} );

		// .claude/.env got the keys (token value present in the gitignored env only).
		const envText = await readFile( join( cwd, '.claude', '.env' ), 'utf8' );
		assert.match( envText, /METRIKA_OAUTH_TOKEN=secret-xyz/ );
		assert.match( envText, /METRIKA_COUNTER_ID=111,222/ );

		// Server installed and MCP registered.
		assert.equal( res.installRes.action, 'installed' );
		assert.equal( res.mcpRes.action, 'added' );

		// .mcp.json has the entry and NO token.
		const mcpText = await readFile( join( cwd, '.mcp.json' ), 'utf8' );
		const mcp = JSON.parse( mcpText );
		assert.ok( mcp.mcpServers[ METRIKA_MCP_SERVER ] );
		assert.ok( ! mcpText.toLowerCase().includes( 'secret-xyz' ), '.mcp.json must not contain the token' );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'setupMetrika: python-missing defers .mcp.json registration', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	try {
		const res = await setupMetrika( cwd, {
			env: { METRIKA_OAUTH_TOKEN: 't', METRIKA_COUNTER_ID: '111' },
			_internals: { pkgRoot: () => root, detectPython: () => null, run: fakeRun() },
		} );
		assert.equal( res.installRes.action, 'python-missing' );
		assert.equal( res.mcpRes, null );
		// Creds still persisted so doctor --fix can finish later.
		const envText = await readFile( join( cwd, '.claude', '.env' ), 'utf8' );
		assert.match( envText, /METRIKA_COUNTER_ID=111/ );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'detectMetrikaState: reports partial and full configuration', async () => {
	const cwd = await tmp();
	try {
		// Nothing yet.
		let st = await detectMetrikaState( cwd );
		assert.deepEqual(
			{ hasEnv: st.hasEnv, hasVenv: st.hasVenv, hasMcp: st.hasMcp, configured: st.configured },
			{ hasEnv: false, hasVenv: false, hasMcp: false, configured: false }
		);

		// Add env creds only.
		await mkdir( join( cwd, '.claude' ), { recursive: true } );
		await writeFile( join( cwd, '.claude', '.env' ), 'METRIKA_OAUTH_TOKEN=t\nMETRIKA_COUNTER_ID=111\n', 'utf8' );
		st = await detectMetrikaState( cwd );
		assert.equal( st.hasEnv, true );
		assert.equal( st.configured, false );

		// Add venv + mcp entry → configured.
		const vp = venvPythonPath( join( cwd, CLIENT_SERVER_REL ) );
		await mkdir( dirname( vp ), { recursive: true } );
		await writeFile( vp, '', 'utf8' );
		await writeFile( join( cwd, '.mcp.json' ), JSON.stringify( { mcpServers: { 'yandex-metrika': {} } } ), 'utf8' );
		st = await detectMetrikaState( cwd );
		assert.equal( st.configured, true );
	} finally {
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'metrikaAuthorizeUrl: builds implicit-flow url, trims and encodes client id', () => {
	// Happy path: a plain client id lands verbatim on the token flow endpoint.
	assert.equal(
		metrikaAuthorizeUrl( 'abc123' ),
		'https://oauth.yandex.ru/authorize?response_type=token&client_id=abc123'
	);
	// Surrounding whitespace (easy to paste) is trimmed, not encoded.
	assert.equal(
		metrikaAuthorizeUrl( '  abc123  ' ),
		'https://oauth.yandex.ru/authorize?response_type=token&client_id=abc123'
	);
	// Odd characters get percent-encoded so the URL stays valid.
	assert.match( metrikaAuthorizeUrl( 'a b&c' ), /client_id=a%20b%26c$/ );
	// Nullish input degrades to an empty client_id instead of throwing.
	assert.equal(
		metrikaAuthorizeUrl( undefined ),
		'https://oauth.yandex.ru/authorize?response_type=token&client_id='
	);
} );

test( 'browserOpenArgv: never routes the authorize URL through cmd.exe on win32', () => {
	const url = metrikaAuthorizeUrl( 'abc123' );

	// Regression: `cmd /c start "" <url>` let cmd.exe treat `&` as a command
	// separator, so the browser opened the URL truncated before client_id.
	const [ cmd, args ] = browserOpenArgv( url, 'win32' );
	assert.equal( cmd, 'explorer.exe' );
	assert.deepEqual( args, [ url ] );
	assert.ok( ! cmd.startsWith( 'cmd' ), 'must not go through a shell that splits on &' );
	assert.ok( args.every( ( a ) => ! /^\/c$/i.test( a ) && a !== 'start' ), 'no cmd /c start wrapper' );
	// The single argv entry still carries the whole query string.
	assert.ok( args[ 0 ].includes( '&client_id=abc123' ), 'client_id survives argv construction' );

	// The other platforms hand the URL over without a shell already.
	assert.deepEqual( browserOpenArgv( url, 'darwin' ), [ 'open', [ url ] ] );
	assert.deepEqual( browserOpenArgv( url, 'linux' ), [ 'xdg-open', [ url ] ] );
} );

test( 'verifyMetrikaToken: maps API responses to valid / invalid / unknown', async () => {
	const calls = [];
	const fetchImpl = ( status ) => async ( url, init ) => {
		calls.push( { url, auth: init.headers.Authorization } );
		return { status };
	};

	assert.deepEqual(
		await verifyMetrikaToken( 'y0_good', { fetchImpl: fetchImpl( 200 ) } ),
		{ status: 'valid', code: 200, reason: 'ok' }
	);
	// Revoked / mistyped tokens are the case doctor must stop reporting green.
	assert.equal( ( await verifyMetrikaToken( 'y0_dead', { fetchImpl: fetchImpl( 401 ) } ) ).status, 'invalid' );
	assert.equal( ( await verifyMetrikaToken( 'y0_dead', { fetchImpl: fetchImpl( 403 ) } ) ).status, 'invalid' );
	// Anything else is inconclusive — never a hard failure.
	assert.equal( ( await verifyMetrikaToken( 'y0_x', { fetchImpl: fetchImpl( 500 ) } ) ).status, 'unknown' );

	// Correct endpoint and OAuth header shape.
	assert.equal( calls[ 0 ].url, 'https://api-metrika.yandex.net/management/v1/counters' );
	assert.equal( calls[ 0 ].auth, 'OAuth y0_good' );
} );

test( 'verifyMetrikaToken: degrades gracefully and skips the call on empty input', async () => {
	// Network down / DNS failure must not throw out of the installer.
	const boom = async () => { throw new Error( 'getaddrinfo ENOTFOUND' ); };
	const offline = await verifyMetrikaToken( 'y0_x', { fetchImpl: boom } );
	assert.equal( offline.status, 'unknown' );
	assert.match( offline.reason, /ENOTFOUND/ );

	// A hung API aborts on the timeout instead of blocking the prompt forever.
	const hang = ( url, init ) => new Promise( ( _resolve, reject ) => {
		init.signal.addEventListener( 'abort', () => {
			const err = new Error( 'aborted' );
			err.name = 'AbortError';
			reject( err );
		} );
	} );
	const timedOut = await verifyMetrikaToken( 'y0_x', { fetchImpl: hang, timeoutMs: 10 } );
	assert.equal( timedOut.status, 'unknown' );
	assert.match( timedOut.reason, /timed out/ );

	// Empty/blank token is rejected locally — no pointless request.
	let called = false;
	const spy = async () => { called = true; return { status: 200 }; };
	for ( const value of [ '', '   ', undefined, null ] ) {
		const res = await verifyMetrikaToken( value, { fetchImpl: spy } );
		assert.equal( res.status, 'invalid' );
		assert.equal( res.reason, 'empty token' );
	}
	assert.equal( called, false, 'empty token must not hit the network' );
} );

test( 'detectMetrikaState: empty env value is not "configured"', async () => {
	const cwd = await tmp();
	try {
		await mkdir( join( cwd, '.claude' ), { recursive: true } );
		// Key present but blank — should not count as configured creds.
		await writeFile( join( cwd, '.claude', '.env' ), 'METRIKA_OAUTH_TOKEN=\nMETRIKA_COUNTER_ID=\n', 'utf8' );
		const st = await detectMetrikaState( cwd );
		assert.equal( st.hasEnv, false );
	} finally {
		await rm( cwd, { recursive: true, force: true } );
	}
} );
