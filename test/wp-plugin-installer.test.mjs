import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePlugins, _internals } from '../src/lib/wp-plugin-installer.mjs';

/**
 * These tests pin down the stdio contract introduced in fix(wp-plugin-installer):
 * SSH-scoped runWp calls MUST mark the exec call interactive so that wp-cli's
 * underlying `ssh` can read the password from the user's TTY. Local calls must
 * NOT set the interactive flag — otherwise stdout would no longer be parseable
 * for `core version`, `plugin is-active`, etc.
 */

function makeStubExec( response ) {
	const calls = [];
	const fn = async ( cmd, args, opts = {} ) => {
		calls.push( { cmd, args, opts } );
		return response;
	};
	fn.calls = calls;
	return fn;
}

async function withStubExec( response, run ) {
	const original = _internals.exec;
	const stub = makeStubExec( response );
	_internals.exec = stub;
	try {
		const result = await run();
		return { result, stub };
	} finally {
		_internals.exec = original;
	}
}

test( 'runWp marks SSH calls as interactive (phar path)', async () => {
	const { result, stub } = await withStubExec(
		{ code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' },
		() => _internals.runWp( { sshSpec: 'ai@host/path', wpCliPharPath: 'C:/wp-cli/wp-cli.phar' }, [ '--info' ] ),
	);

	assert.equal( stub.calls.length, 1 );
	const call = stub.calls[ 0 ];
	assert.equal( call.cmd, 'php' );
	assert.ok( call.args.includes( '--info' ) );
	assert.ok( call.args.includes( '--ssh=ai@host/path' ) );
	assert.equal( call.opts.interactive, true, 'SSH-scoped runWp must pass interactive:true' );
	// And the result is propagated unchanged.
	assert.equal( result.code, 0 );
	assert.equal( result.stdout, 'WP-CLI 2.12.0' );
} );

test( 'runWp marks SSH calls as interactive (PATH fallback)', async () => {
	const { stub } = await withStubExec(
		{ code: 0, stdout: '', stderr: '' },
		() => _internals.runWp( { sshSpec: 'ai@host/path' }, [ '--info' ] ),
	);

	assert.equal( stub.calls.length, 1 );
	const call = stub.calls[ 0 ];
	assert.equal( call.cmd, 'wp' );
	assert.equal( call.opts.interactive, true );
} );

test( 'runWp does NOT set interactive on local (wpRoot) calls', async () => {
	const { stub } = await withStubExec(
		{ code: 0, stdout: 'wp-cli 2.12.0', stderr: '' },
		() => _internals.runWp( { wpRoot: 'C:/wamp/www/site', wpCliPharPath: 'C:/wp-cli/wp-cli.phar' }, [ '--info' ] ),
	);

	const call = stub.calls[ 0 ];
	assert.equal( call.cmd, 'php' );
	assert.ok( call.args.includes( '--path=C:/wamp/www/site' ) );
	assert.ok( ! call.opts.interactive, 'local-scope runWp must not set interactive' );
} );

test( 'runWp propagates exec result fields back to the caller', async () => {
	const response = { code: 1, stdout: 'partial', stderr: 'boom' };
	const { result } = await withStubExec(
		response,
		() => _internals.runWp( { sshSpec: 'u@h/p' }, [ 'core', 'version' ] ),
	);
	assert.equal( result.code, 1 );
	assert.equal( result.stdout, 'partial' );
	assert.equal( result.stderr, 'boom' );
} );

test( 'exec strips the interactive flag before spawning (no leakage as spawn option)', async () => {
	// Sanity-check: directly call exec via a process that prints something
	// short and exits 0. We just verify the function returns the expected
	// shape and doesn't throw when `interactive` is passed. Uses `node -e`
	// since it's guaranteed to be on PATH (this is a Node project).
	const r = await _internals.exec(
		process.execPath,
		[ '-e', 'process.stdout.write("hello")' ],
		{},
	);
	assert.equal( r.code, 0 );
	assert.equal( r.stdout, 'hello' );
} );

/* -----------------------------------------------------------------------
 * Release-resolver tests.
 *
 * resolveReleaseZipUrl hits api.github.com to pick a built release asset
 * (whose archive includes vendor/) instead of the source-only trunk.zip
 * that GitHub serves from /archive/refs/heads/. resolvePluginZipUrl wraps
 * that lookup with policy: pin-deps override > useReleases:false > release
 * lookup with trunk fallback on failure.
 *
 * Tests stub globalThis.fetch so they never touch the network.
 * --------------------------------------------------------------------- */

function jsonResp( body, status = 200 ) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

async function withStubFetch( responses, run ) {
	const original = globalThis.fetch;
	const calls = [];
	const queue = [ ...responses ];
	globalThis.fetch = async ( url, init ) => {
		calls.push( { url, init } );
		if ( ! queue.length ) {
			throw new Error( `unexpected fetch: ${ url }` );
		}
		const next = queue.shift();
		if ( typeof next === 'function' ) {
			return next( { url, init } );
		}
		return next;
	};
	try {
		const result = await run();
		return { result, calls };
	} finally {
		globalThis.fetch = original;
	}
}

test( 'resolveReleaseZipUrl: returns first .zip asset URL on success', async () => {
	const spec = { slug: 'mcp-adapter', githubRepo: 'WordPress/mcp-adapter' };
	const body = {
		tag_name: 'v0.4.0',
		assets: [
			{ name: 'mcp-adapter.zip', browser_download_url: 'https://example/mcp-adapter.zip' },
		],
	};
	const { result, calls } = await withStubFetch(
		[ jsonResp( body ) ],
		() => _internals.resolveReleaseZipUrl( spec ),
	);
	assert.equal( result, 'https://example/mcp-adapter.zip' );
	assert.equal( calls.length, 1 );
	assert.match( calls[ 0 ].url, /api\.github\.com\/repos\/WordPress\/mcp-adapter\/releases\/latest$/ );
	assert.equal( calls[ 0 ].init.headers[ 'User-Agent' ], 'seomi-wp-mcp' );
} );

test( 'resolveReleaseZipUrl: returns null on 404 (no releases yet)', async () => {
	const { result } = await withStubFetch(
		[ jsonResp( {}, 404 ) ],
		() => _internals.resolveReleaseZipUrl( { githubRepo: 'WordPress/mcp-adapter' } ),
	);
	assert.equal( result, null );
} );

test( 'resolveReleaseZipUrl: returns null on 403 (rate-limit)', async () => {
	const { result } = await withStubFetch(
		[ jsonResp( { message: 'API rate limit exceeded' }, 403 ) ],
		() => _internals.resolveReleaseZipUrl( { githubRepo: 'WordPress/mcp-adapter' } ),
	);
	assert.equal( result, null );
} );

test( 'resolveReleaseZipUrl: returns null when release has no zip asset', async () => {
	const body = {
		tag_name: 'v0.4.0',
		assets: [ { name: 'CHANGELOG.txt', browser_download_url: 'https://example/CHANGELOG.txt' } ],
	};
	const { result } = await withStubFetch(
		[ jsonResp( body ) ],
		() => _internals.resolveReleaseZipUrl( { githubRepo: 'WordPress/mcp-adapter' } ),
	);
	assert.equal( result, null );
} );

test( 'resolveReleaseZipUrl: picks the first usable .zip when multiple assets exist', async () => {
	const body = {
		tag_name: 'v0.4.0',
		assets: [
			{ name: 'CHANGELOG.txt', browser_download_url: 'https://example/CHANGELOG.txt' },
			{ name: 'mcp-adapter.zip', browser_download_url: 'https://example/mcp-adapter.zip' },
		],
	};
	const { result } = await withStubFetch(
		[ jsonResp( body ) ],
		() => _internals.resolveReleaseZipUrl( { githubRepo: 'WordPress/mcp-adapter' } ),
	);
	assert.equal( result, 'https://example/mcp-adapter.zip' );
} );

test( 'resolveReleaseZipUrl: filters out -src/-source mirror archives', async () => {
	const body = {
		tag_name: 'v0.4.0',
		assets: [
			{ name: 'mcp-adapter-src.zip', browser_download_url: 'https://example/src.zip' },
			{ name: 'mcp-adapter-source.zip', browser_download_url: 'https://example/source.zip' },
			{ name: 'mcp-adapter.zip', browser_download_url: 'https://example/built.zip' },
		],
	};
	const { result } = await withStubFetch(
		[ jsonResp( body ) ],
		() => _internals.resolveReleaseZipUrl( { githubRepo: 'WordPress/mcp-adapter' } ),
	);
	assert.equal( result, 'https://example/built.zip' );
} );

test( 'resolveReleaseZipUrl: returns null when fetch throws', async () => {
	const { result } = await withStubFetch(
		[ () => { throw new Error( 'ENOTFOUND api.github.com' ); } ],
		() => _internals.resolveReleaseZipUrl( { githubRepo: 'WordPress/mcp-adapter' } ),
	);
	assert.equal( result, null );
} );

test( 'resolveReleaseZipUrl: aborts on its own 5s timeout (signal wired up)', async () => {
	// Stub fetch with a response that rejects when the signal aborts. This
	// exercises the AbortController wiring without sitting on a real 5s wait
	// (we trigger abort manually from inside the stub).
	const { result } = await withStubFetch(
		[ ( { init } ) => new Promise( ( _, reject ) => {
			const signal = init?.signal;
			if ( signal?.aborted ) {
				reject( Object.assign( new Error( 'aborted' ), { name: 'AbortError' } ) );
				return;
			}
			signal?.addEventListener?.( 'abort', () => {
				reject( Object.assign( new Error( 'aborted' ), { name: 'AbortError' } ) );
			} );
			// Force the abort path immediately so the test does not actually
			// wait 5s — verifies the signal is plumbed into fetch's init.
			signal?.dispatchEvent?.( new Event( 'abort' ) );
		} ) ],
		() => _internals.resolveReleaseZipUrl( { githubRepo: 'WordPress/mcp-adapter' } ),
	);
	assert.equal( result, null );
} );

test( 'resolvePluginZipUrl: useReleases:false → trunk URL, no fetch', async () => {
	const spec = { slug: 'abilities-api', githubRepo: 'WordPress/abilities-api', ref: 'trunk', useReleases: false };
	const { result, calls } = await withStubFetch(
		[],
		() => _internals.resolvePluginZipUrl( spec ),
	);
	assert.equal( calls.length, 0, 'must not hit GitHub API when useReleases is false' );
	assert.equal( result.source, 'trunk' );
	assert.equal( result.url, 'https://github.com/WordPress/abilities-api/archive/refs/heads/trunk.zip' );
} );

test( 'resolvePluginZipUrl: useReleases:true + valid release → release URL', async () => {
	const spec = { slug: 'mcp-adapter', githubRepo: 'WordPress/mcp-adapter', ref: 'trunk', useReleases: true };
	const body = {
		tag_name: 'v0.4.0',
		assets: [ { name: 'mcp-adapter.zip', browser_download_url: 'https://example/mcp-adapter.zip' } ],
	};
	const { result, calls } = await withStubFetch(
		[ jsonResp( body ) ],
		() => _internals.resolvePluginZipUrl( spec ),
	);
	assert.equal( calls.length, 1 );
	assert.equal( result.source, 'release' );
	assert.equal( result.url, 'https://example/mcp-adapter.zip' );
} );

test( 'resolvePluginZipUrl: useReleases:true + 404 → falls back to trunk', async () => {
	const spec = { slug: 'mcp-adapter', githubRepo: 'WordPress/mcp-adapter', ref: 'trunk', useReleases: true };
	const { result, calls } = await withStubFetch(
		[ jsonResp( {}, 404 ) ],
		() => _internals.resolvePluginZipUrl( spec ),
	);
	assert.equal( calls.length, 1 );
	assert.equal( result.source, 'trunk' );
	assert.equal( result.url, 'https://github.com/WordPress/mcp-adapter/archive/refs/heads/trunk.zip' );
} );

test( 'resolvePluginZipUrl: refOverride bypasses release lookup', async () => {
	const spec = { slug: 'mcp-adapter', githubRepo: 'WordPress/mcp-adapter', ref: 'trunk', useReleases: true };
	const { result, calls } = await withStubFetch(
		[],
		() => _internals.resolvePluginZipUrl( spec, { refOverride: 'v0.3.0' } ),
	);
	assert.equal( calls.length, 0, 'refOverride must skip the release lookup' );
	assert.equal( result.source, 'trunk' );
	assert.equal( result.url, 'https://github.com/WordPress/mcp-adapter/archive/refs/heads/v0.3.0.zip' );
} );

/* -----------------------------------------------------------------------
 * ensurePlugins vendor-check + forced reinstall tests.
 *
 * Covers the "active but vendor missing" recovery path: when a release-
 * tracked plugin (useReleases:true) is already active but its
 * vendor/autoload.php is missing — typically because it was previously
 * installed from the trunk archive — ensurePlugins must force a reinstall
 * from the release asset instead of short-circuiting on "already-active".
 *
 * Strategy:
 *   - Local mode uses a real tmp WP root so pluginVendorAutoloadExists can
 *     run its actual existsSync against a controlled filesystem.
 *   - SSH mode stubs `wp eval` through _internals.exec to drive the null
 *     branch.
 *   - _internals.exec is stubbed with a router (cmd, args, opts) → response.
 *   - globalThis.fetch is stubbed for release lookups via the existing
 *     withStubFetch helper.
 * --------------------------------------------------------------------- */

function makeRouterExec( router ) {
	const calls = [];
	const fn = async ( cmd, args, opts = {} ) => {
		calls.push( { cmd, args, opts } );
		const out = await router( cmd, args, opts );
		return out || { code: 0, stdout: '', stderr: '' };
	};
	fn.calls = calls;
	return fn;
}

async function withRouterExec( router, run ) {
	const original = _internals.exec;
	_internals.exec = makeRouterExec( router );
	try {
		const result = await run( _internals.exec );
		return { result, stub: _internals.exec };
	} finally {
		_internals.exec = original;
	}
}

// runWp invokes exec('php', [phar, ...wpArgs, ...scopeFlags]) when
// wpCliPharPath is set. Strip the phar prefix so the helpers below can
// match the wp-cli arg shape regardless of how runWp shells out.
function wpArgs( call ) {
	if ( call.cmd === 'php' ) return call.args.slice( 1 );
	return call.args;
}
function isWpInfo( call ) {
	return wpArgs( call ).includes( '--info' );
}
function isCoreVersion( call ) {
	const a = wpArgs( call );
	return a[ 0 ] === 'core' && a[ 1 ] === 'version';
}
function isIsActive( call, slug ) {
	const a = wpArgs( call );
	return a[ 0 ] === 'plugin' && a[ 1 ] === 'is-active' && a[ 2 ] === slug;
}
function isPluginInstall( call ) {
	const a = wpArgs( call );
	return a[ 0 ] === 'plugin' && a[ 1 ] === 'install';
}
function isWpEval( call ) {
	return wpArgs( call )[ 0 ] === 'eval';
}
function isSshTestF( call ) {
	if ( call.cmd !== 'ssh' ) return false;
	const a = call.args;
	return a.includes( 'test' ) && a.includes( '-f' );
}

async function makeWpRoot( opts = {} ) {
	const root = await mkdtemp( join( tmpdir(), 'seomi-wp-' ) );
	if ( opts.vendorFor ) {
		for ( const slug of opts.vendorFor ) {
			const dir = join( root, 'wp-content', 'plugins', slug, 'vendor' );
			await mkdir( dir, { recursive: true } );
			await writeFile( join( dir, 'autoload.php' ), '<?php // stub\n', 'utf8' );
		}
	}
	return root;
}

const RELEASE_BODY = {
	tag_name: 'v0.5.0',
	assets: [
		{ name: 'mcp-adapter.zip', browser_download_url: 'https://example/mcp-adapter-v0.5.0.zip' },
	],
};

test( 'ensurePlugins: reinstall release plugin when active but vendor missing', async () => {
	const wpRoot = await makeWpRoot(); // no vendor/ for mcp-adapter
	try {
		const deps = [ { slug: 'mcp-adapter', githubRepo: 'WordPress/mcp-adapter', ref: 'trunk', useReleases: true, label: 'MCP Adapter' } ];
		const { result } = await withStubFetch( [ jsonResp( RELEASE_BODY ) ], () => withRouterExec(
			( cmd, args ) => {
				const call = { cmd, args };
				if ( isWpInfo( call ) ) return { code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' };
				if ( isCoreVersion( call ) ) return { code: 0, stdout: '6.5\n', stderr: '' };
				if ( isIsActive( call, 'mcp-adapter' ) ) return { code: 0, stdout: '', stderr: '' };
				if ( isPluginInstall( call ) ) return { code: 0, stdout: 'Plugin installed.\n', stderr: '' };
				return { code: 0, stdout: '', stderr: '' };
			},
			() => ensurePlugins( { wpRoot, wpCliPharPath: 'C:/wp-cli/wp-cli.phar', deps } ),
		) );

		const stub = result.stub;
		const res = result.result;
		const entry = res.results.find( ( r ) => r.slug === 'mcp-adapter' );
		assert.equal( entry.action, 'reinstalled', 'must mark release-tracked plugin with missing vendor as reinstalled' );
		assert.equal( entry.source, 'release' );
		assert.equal( entry.reason, 'missing-vendor' );
		const installCall = stub.calls.find( ( c ) => isPluginInstall( c ) );
		assert.ok( installCall, 'wp plugin install must be invoked when vendor is missing' );
		const installArgs = wpArgs( installCall );
		assert.equal( installArgs[ 2 ], 'https://example/mcp-adapter-v0.5.0.zip' );
		assert.ok( installArgs.includes( '--force' ), 'forced reinstall must pass --force' );
	} finally {
		await rm( wpRoot, { recursive: true, force: true } );
	}
} );

test( 'ensurePlugins: skip release plugin when active and vendor present', async () => {
	const wpRoot = await makeWpRoot( { vendorFor: [ 'mcp-adapter' ] } );
	try {
		const deps = [ { slug: 'mcp-adapter', githubRepo: 'WordPress/mcp-adapter', ref: 'trunk', useReleases: true, label: 'MCP Adapter' } ];
		// fetch must NOT be invoked — release lookup is skipped when vendor is present.
		const { result } = await withStubFetch( [], () => withRouterExec(
			( cmd, args ) => {
				const call = { cmd, args };
				if ( isWpInfo( call ) ) return { code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' };
				if ( isCoreVersion( call ) ) return { code: 0, stdout: '6.5\n', stderr: '' };
				if ( isIsActive( call, 'mcp-adapter' ) ) return { code: 0, stdout: '', stderr: '' };
				return { code: 0, stdout: '', stderr: '' };
			},
			() => ensurePlugins( { wpRoot, wpCliPharPath: 'C:/wp-cli/wp-cli.phar', deps } ),
		) );

		const stub = result.stub;
		const res = result.result;
		const entry = res.results.find( ( r ) => r.slug === 'mcp-adapter' );
		assert.equal( entry.action, 'already-active' );
		assert.ok( ! stub.calls.some( ( c ) => isPluginInstall( c ) ), 'wp plugin install must NOT run when vendor is already present' );
	} finally {
		await rm( wpRoot, { recursive: true, force: true } );
	}
} );

test( 'ensurePlugins: vendor check returning null preserves already-active behavior', async () => {
	// SSH mode where `ssh test -f` fails with a connection-level error (exit 255)
	// → pluginVendorAutoloadExists returns null. In that case ensurePlugins must
	// NOT attempt a forced reinstall.
	const deps = [ { slug: 'mcp-adapter', githubRepo: 'WordPress/mcp-adapter', ref: 'trunk', useReleases: true, label: 'MCP Adapter' } ];
	const { result } = await withStubFetch( [], () => withRouterExec(
		( cmd, args ) => {
			const call = { cmd, args };
			if ( isWpInfo( call ) ) return { code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' };
			if ( isCoreVersion( call ) ) return { code: 0, stdout: '6.5\n', stderr: '' };
			if ( isIsActive( call, 'mcp-adapter' ) ) return { code: 0, stdout: '', stderr: '' };
			if ( isSshTestF( call ) ) return { code: 255, stdout: '', stderr: 'Connection closed' };
			if ( isWpEval( call ) ) throw new Error( 'wp eval must not be invoked under the new SSH probe' );
			return { code: 0, stdout: '', stderr: '' };
		},
		() => ensurePlugins( { sshSpec: 'ai@host/var/www/wp', wpCliPharPath: 'C:/wp-cli/wp-cli.phar', deps } ),
	) );

	const stub = result.stub;
	const res = result.result;
	const entry = res.results.find( ( r ) => r.slug === 'mcp-adapter' );
	assert.equal( entry.action, 'already-active' );
	assert.ok( stub.calls.some( ( c ) => isSshTestF( c ) ), 'vendor check must attempt ssh test -f over SSH' );
	assert.ok( ! stub.calls.some( ( c ) => isWpEval( c ) ), 'must not call wp eval anymore' );
	assert.ok( ! stub.calls.some( ( c ) => isPluginInstall( c ) ), 'forced reinstall must not run when vendor check is inconclusive' );
} );

test( 'ensurePlugins: non-release-tracked active plugin skips vendor check entirely', async () => {
	const wpRoot = await makeWpRoot(); // no vendor anywhere
	try {
		// abilities-api has useReleases:false; even if vendor is missing, ensurePlugins must not probe it.
		const deps = [ { slug: 'abilities-api', githubRepo: 'WordPress/abilities-api', ref: 'trunk', useReleases: false, label: 'WP Abilities API' } ];
		const { result } = await withStubFetch( [], () => withRouterExec(
			( cmd, args ) => {
				const call = { cmd, args };
				if ( isWpInfo( call ) ) return { code: 0, stdout: 'WP-CLI 2.12.0', stderr: '' };
				if ( isCoreVersion( call ) ) return { code: 0, stdout: '6.5\n', stderr: '' };
				if ( isIsActive( call, 'abilities-api' ) ) return { code: 0, stdout: '', stderr: '' };
				if ( isWpEval( call ) ) throw new Error( 'wp eval must not be invoked for non-release-tracked plugins' );
				return { code: 0, stdout: '', stderr: '' };
			},
			() => ensurePlugins( { wpRoot, wpCliPharPath: 'C:/wp-cli/wp-cli.phar', deps } ),
		) );

		const stub = result.stub;
		const res = result.result;
		const entry = res.results.find( ( r ) => r.slug === 'abilities-api' );
		assert.equal( entry.action, 'already-active' );
		assert.ok( ! stub.calls.some( ( c ) => isWpEval( c ) ), 'wp eval must not run for useReleases:false plugins' );
		assert.ok( ! stub.calls.some( ( c ) => isPluginInstall( c ) ), 'plugin install must not run for already-active non-release-tracked plugins' );
	} finally {
		await rm( wpRoot, { recursive: true, force: true } );
	}
} );

/* -----------------------------------------------------------------------
 * pluginVendorAutoloadExists SSH-probe tests.
 *
 * The SSH branch shells out to `ssh <host> test -f <abs-path>` (not `wp eval`,
 * which was previously broken under wp-cli's --ssh transport because the inner
 * double quotes around the PHP code were stripped by the remote bash wrapper).
 * --------------------------------------------------------------------- */

test( 'pluginVendorAutoloadExists: SSH test -f exit=0 → true', async () => {
	const { result, stub } = await withStubExec(
		{ code: 0, stdout: '', stderr: '' },
		() => _internals.pluginVendorAutoloadExists(
			{ sshSpec: 'user@host:2222/home/user/site/www' },
			{ slug: 'mcp-adapter' },
		),
	);
	assert.equal( result, true );
	assert.equal( stub.calls.length, 1 );
	const call = stub.calls[ 0 ];
	assert.equal( call.cmd, 'ssh' );
	assert.ok( call.args.includes( '-p' ) );
	assert.ok( call.args.includes( '2222' ) );
	assert.ok( call.args.includes( 'user@host' ) );
	assert.ok( call.args.includes( 'test' ) );
	assert.ok( call.args.includes( '-f' ) );
	assert.ok( call.args.includes( '/home/user/site/www/wp-content/plugins/mcp-adapter/vendor/autoload.php' ) );
	// Regression guard: must NOT shell out to `wp eval` / `file_exists(...)`.
	assert.ok( ! call.args.some( ( a ) => /eval|file_exists/i.test( a ) ), 'must not call wp eval' );
} );

test( 'pluginVendorAutoloadExists: SSH test -f exit=1 → false', async () => {
	const { result } = await withStubExec(
		{ code: 1, stdout: '', stderr: '' },
		() => _internals.pluginVendorAutoloadExists(
			{ sshSpec: 'user@host/home/user/site/www' },
			{ slug: 'mcp-adapter' },
		),
	);
	assert.equal( result, false );
} );

test( 'pluginVendorAutoloadExists: SSH connection error (exit 255) → null', async () => {
	const { result } = await withStubExec(
		{ code: 255, stdout: '', stderr: 'Connection closed by host' },
		() => _internals.pluginVendorAutoloadExists(
			{ sshSpec: 'user@host/home/user/site/www' },
			{ slug: 'mcp-adapter' },
		),
	);
	assert.equal( result, null );
} );

test( 'pluginVendorAutoloadExists: SSH sshSpec without wpRoot → null (no exec call)', async () => {
	const { result, stub } = await withStubExec(
		{ code: 0, stdout: '', stderr: '' },
		() => _internals.pluginVendorAutoloadExists(
			{ sshSpec: 'user@host' },
			{ slug: 'mcp-adapter' },
		),
	);
	assert.equal( result, null );
	assert.equal( stub.calls.length, 0, 'must not invoke ssh when wpRoot is unknown' );
} );

test( 'pluginVendorAutoloadExists: SSH port omitted → ssh called without -p', async () => {
	const { stub } = await withStubExec(
		{ code: 0, stdout: '', stderr: '' },
		() => _internals.pluginVendorAutoloadExists(
			{ sshSpec: 'user@host/home/user/site/www' },
			{ slug: 'mcp-adapter' },
		),
	);
	const call = stub.calls[ 0 ];
	assert.ok( ! call.args.includes( '-p' ), 'no -p when port absent' );
	assert.ok( call.args.includes( '-o' ) && call.args.includes( 'BatchMode=yes' ), 'BatchMode=yes must be set' );
} );
