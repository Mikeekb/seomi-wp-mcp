import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectIdeaSshDeployment } from '../src/lib/idea-deployment-detector.mjs';

async function tmp() {
	return mkdtemp( join( tmpdir(), 'seomi-wp-mcp-ideadet-' ) );
}

async function writeIdeaFile( dir, name, content ) {
	await mkdir( join( dir, '.idea' ), { recursive: true } );
	await writeFile( join( dir, '.idea', name ), content, 'utf8' );
}

const FULL_DEPLOYMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="PublishConfigData" autoUpload="Always">
    <serverData>
      <paths name="my-prod">
        <serverdata>
          <mappings>
            <mapping deploy="/home/user/site/public_html" local="$PROJECT_DIR$" />
          </mappings>
        </serverdata>
      </paths>
    </serverData>
  </component>
  <component name="WebServers">
    <option name="servers">
      <webServer id="abc-123" name="my-prod" url="http://example.com">
        <fileTransfer host="example.com" port="22" sshConfig="deploy-user@example.com:22 password" accessType="SFTP">
          <advancedOptions>
            <advancedOptions dataProtectionLevel="Private" keepAliveTimeout="0" passiveMode="true" shareSSLContext="true" />
          </advancedOptions>
        </fileTransfer>
      </webServer>
    </option>
  </component>
</project>
`;

test( 'detectIdeaSshDeployment: no .idea/ — found=false', async () => {
	const dir = await tmp();
	try {
		const r = detectIdeaSshDeployment( dir );
		assert.equal( r.found, false );
		assert.equal( r.host, null );
		assert.equal( r.source, null );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectIdeaSshDeployment: full deployment.xml — all fields extracted', async () => {
	const dir = await tmp();
	try {
		await writeIdeaFile( dir, 'deployment.xml', FULL_DEPLOYMENT_XML );
		const r = detectIdeaSshDeployment( dir );
		assert.equal( r.found, true );
		assert.equal( r.host, 'example.com' );
		assert.equal( r.port, '22' );
		assert.equal( r.user, 'deploy-user' );
		assert.equal( r.deployPath, '/home/user/site/public_html' );
		assert.equal( r.source, '.idea/deployment.xml' );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectIdeaSshDeployment: SFTP but no <mapping> — deployPath null', async () => {
	const dir = await tmp();
	try {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="WebServers">
    <option name="servers">
      <webServer id="abc" name="prod" url="http://example.com">
        <fileTransfer host="example.com" port="2222" sshConfig="me@example.com:2222 password" accessType="SFTP" />
      </webServer>
    </option>
  </component>
</project>`;
		await writeIdeaFile( dir, 'deployment.xml', xml );
		const r = detectIdeaSshDeployment( dir );
		assert.equal( r.found, true );
		assert.equal( r.host, 'example.com' );
		assert.equal( r.port, '2222' );
		assert.equal( r.user, 'me' );
		assert.equal( r.deployPath, null );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectIdeaSshDeployment: webServers.xml fallback (no deployment.xml)', async () => {
	const dir = await tmp();
	try {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <component name="WebServers">
    <option name="servers">
      <webServer name="prod" url="http://x.example">
        <fileTransfer host="x.example" port="22" accessType="SFTP" />
      </webServer>
    </option>
  </component>
</project>`;
		await writeIdeaFile( dir, 'webServers.xml', xml );
		const r = detectIdeaSshDeployment( dir );
		assert.equal( r.found, true );
		assert.equal( r.host, 'x.example' );
		assert.equal( r.port, '22' );
		assert.equal( r.user, null );
		assert.equal( r.source, '.idea/webServers.xml' );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectIdeaSshDeployment: multiple servers, first SFTP is picked', async () => {
	const dir = await tmp();
	try {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <component name="WebServers">
    <option name="servers">
      <webServer name="local" url="http://local"><fileTransfer host="local.test" accessType="LOCAL" /></webServer>
      <webServer name="staging" url="http://stg"><fileTransfer host="stg.example" port="22" sshConfig="stg@stg.example:22" accessType="SFTP" /></webServer>
      <webServer name="prod" url="http://prod"><fileTransfer host="prod.example" port="22" sshConfig="prod@prod.example:22" accessType="SFTP" /></webServer>
    </option>
  </component>
</project>`;
		await writeIdeaFile( dir, 'deployment.xml', xml );
		const r = detectIdeaSshDeployment( dir );
		assert.equal( r.found, true );
		assert.equal( r.host, 'stg.example' );
		assert.equal( r.user, 'stg' );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectIdeaSshDeployment: malformed XML — found=false, no throw', async () => {
	const dir = await tmp();
	try {
		// Truncated/broken: detector reads it as text, regex finds no SFTP tag.
		await writeIdeaFile( dir, 'deployment.xml', '<project><componen' );
		const r = detectIdeaSshDeployment( dir );
		assert.equal( r.found, false );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectIdeaSshDeployment: HTTP-only webServer (no SFTP) — found=false', async () => {
	const dir = await tmp();
	try {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <component name="WebServers">
    <option name="servers">
      <webServer name="http-only" url="http://example.com">
        <fileTransfer host="example.com" port="80" accessType="LOCAL" />
      </webServer>
    </option>
  </component>
</project>`;
		await writeIdeaFile( dir, 'deployment.xml', xml );
		const r = detectIdeaSshDeployment( dir );
		assert.equal( r.found, false );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectIdeaSshDeployment: SFTP tag without host attribute — skipped, found=false', async () => {
	const dir = await tmp();
	try {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <component name="WebServers">
    <option name="servers">
      <webServer name="bad" url="http://x">
        <fileTransfer port="22" accessType="SFTP" />
      </webServer>
    </option>
  </component>
</project>`;
		await writeIdeaFile( dir, 'deployment.xml', xml );
		const r = detectIdeaSshDeployment( dir );
		assert.equal( r.found, false );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'detectIdeaSshDeployment: attributes split across lines (multiline)', async () => {
	const dir = await tmp();
	try {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <component name="WebServers">
    <option name="servers">
      <webServer name="multi" url="http://m">
        <fileTransfer
          host="m.example"
          port="2200"
          sshConfig="muser@m.example:2200 password"
          accessType="SFTP" />
      </webServer>
    </option>
  </component>
</project>`;
		await writeIdeaFile( dir, 'deployment.xml', xml );
		const r = detectIdeaSshDeployment( dir );
		assert.equal( r.found, true );
		assert.equal( r.host, 'm.example' );
		assert.equal( r.port, '2200' );
		assert.equal( r.user, 'muser' );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );
