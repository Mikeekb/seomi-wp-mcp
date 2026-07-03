import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { detectMetrikaState, setupMetrika, metrikaAuthorizeUrl, METRIKA_MCP_SERVER } from '../src/lib/metrika-setup.mjs';
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
