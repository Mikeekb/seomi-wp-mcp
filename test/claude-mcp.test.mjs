import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildStdioLocalConfig, buildStdioSshConfig, composeSshSpec, buildMetrikaMcpConfig } from '../src/lib/claude-mcp.mjs';

test( 'buildStdioLocalConfig: appends --url when siteUrl is given', () => {
	const cfg = buildStdioLocalConfig( {
		wpCliPharPath: 'C:/wp-cli/wp-cli.phar',
		wpRoot: 'C:/site',
		user: 'ai-agent',
		siteUrl: 'https://os-ndtnew',
	} );
	assert.equal( cfg.command, 'php' );
	assert.equal( cfg.type, 'stdio' );
	// --url must sit in wp-cli global scope (before the `mcp-adapter` subcommand).
	const pathIdx = cfg.args.indexOf( '--path=C:/site' );
	const urlIdx = cfg.args.indexOf( '--url=https://os-ndtnew' );
	const subIdx = cfg.args.indexOf( 'mcp-adapter' );
	assert.ok( pathIdx >= 0, 'expected --path arg' );
	assert.ok( urlIdx >= 0, 'expected --url arg' );
	assert.ok( subIdx > urlIdx, '--url must precede mcp-adapter subcommand' );
} );

test( 'buildStdioLocalConfig: omits --url when siteUrl is missing', () => {
	const cfg = buildStdioLocalConfig( {
		wpCliPharPath: 'C:/wp-cli/wp-cli.phar',
		wpRoot: 'C:/site',
		user: 'ai-agent',
	} );
	assert.ok( ! cfg.args.some( ( a ) => a.startsWith( '--url=' ) ), 'expected no --url' );
} );

test( 'buildStdioSshConfig: appends --url when siteUrl is given', () => {
	const cfg = buildStdioSshConfig( {
		wpCliPharPath: 'C:/wp-cli/wp-cli.phar',
		sshSpec: 'user@host:22/srv/www',
		user: 'ai-agent',
		siteUrl: 'https://www.example.com',
	} );
	const sshIdx = cfg.args.indexOf( '--ssh=user@host:22/srv/www' );
	const urlIdx = cfg.args.indexOf( '--url=https://www.example.com' );
	const subIdx = cfg.args.indexOf( 'mcp-adapter' );
	assert.ok( sshIdx >= 0 );
	assert.ok( urlIdx >= 0 );
	assert.ok( subIdx > urlIdx, '--url must precede mcp-adapter subcommand' );
} );

test( 'buildStdioSshConfig: omits --url when siteUrl is missing', () => {
	const cfg = buildStdioSshConfig( {
		wpCliPharPath: 'C:/wp-cli/wp-cli.phar',
		sshSpec: 'user@host:22/srv/www',
		user: 'ai-agent',
	} );
	assert.ok( ! cfg.args.some( ( a ) => a.startsWith( '--url=' ) ) );
} );

test( 'composeSshSpec: assembles user@host:port/path', () => {
	assert.equal(
		composeSshSpec( { sshUser: 'c7006', sshHost: '91.226.81.214', sshPort: 22, wpRoot: '/home/c7006/www' } ),
		'c7006@91.226.81.214:22/home/c7006/www'
	);
} );

test( 'buildMetrikaMcpConfig: windows venv path, no secrets, stdio', () => {
	const cfg = buildMetrikaMcpConfig( { platform: 'win32' } );
	assert.equal( cfg.command, '.claude/mcp-servers/yandex-metrika/.venv/Scripts/python.exe' );
	assert.deepEqual( cfg.args, [ '-m', 'seomi_metrika.server' ] );
	assert.equal( cfg.type, 'stdio' );
	// Only LOG_LEVEL in env — never the OAuth token (this file is committed).
	assert.deepEqual( Object.keys( cfg.env ), [ 'LOG_LEVEL' ] );
	const serialized = JSON.stringify( cfg ).toLowerCase();
	assert.ok( ! serialized.includes( 'token' ), 'config must not carry any token' );
	assert.ok( ! serialized.includes( 'oauth' ), 'config must not carry oauth secrets' );
} );

test( 'buildMetrikaMcpConfig: posix venv path', () => {
	const cfg = buildMetrikaMcpConfig( { platform: 'linux' } );
	assert.equal( cfg.command, '.claude/mcp-servers/yandex-metrika/.venv/bin/python' );
} );
