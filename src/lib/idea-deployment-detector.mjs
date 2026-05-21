/**
 * Detect a JetBrains SSH/SFTP deployment configuration in `.idea/`.
 *
 * PhpStorm / IntelliJ store the "Deployment" config in either:
 *   - `.idea/deployment.xml`  (the modern default location)
 *   - `.idea/webServers.xml`  (older / split layout)
 *
 * The relevant snippet inside such files looks roughly like:
 *
 *   <webServer id="..." name="my-prod">
 *     <fileTransfer host="example.com" port="22" sshConfig="user@example.com:22 password" accessType="SFTP">
 *       <advancedOptions>...</advancedOptions>
 *     </fileTransfer>
 *   </webServer>
 *
 *   <paths name="my-prod">
 *     <serverdata>
 *       <mappings>
 *         <mapping deploy="/home/user/site/public_html" local="$PROJECT_DIR$" />
 *       </mappings>
 *     </serverdata>
 *   </paths>
 *
 * The format is plain, attribute-driven, and stable enough that regex parsing
 * is justified here — pulling in an XML dependency for this single read-once
 * probe would be heavier than the value. Bad/partial XML never throws — we
 * just return `{ found: false }`.
 *
 * Output contract: extract what we can, leave the rest `null`. `init` decides
 * which fields to use as input-prompt defaults.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.mjs';

const DEPLOYMENT_FILE = 'deployment.xml';
const WEBSERVERS_FILE = 'webServers.xml';

function readIfExists( path ) {
	try {
		if ( ! existsSync( path ) ) return null;
		if ( ! statSync( path ).isFile() ) return null;
		return readFileSync( path, 'utf8' );
	} catch ( err ) {
		logger.debug( `idea-deployment-detector: read failed for ${ path }: ${ err.message }` );
		return null;
	}
}

/**
 * Find the first `<fileTransfer …>` tag with `accessType="SFTP"` and return
 * its attribute string. Returns `null` if none.
 *
 * Multiline-aware: attributes can be split across lines in real PhpStorm
 * exports, so we use the `s` flag.
 */
function findFirstSftpTag( xml ) {
	const re = /<fileTransfer\b([^>]*?)>/gs;
	let m;
	while ( ( m = re.exec( xml ) ) !== null ) {
		const attrs = m[ 1 ];
		if ( /accessType\s*=\s*"SFTP"/i.test( attrs ) ) {
			return attrs;
		}
	}
	return null;
}

function attr( attrs, name ) {
	const re = new RegExp( `${ name }\\s*=\\s*"([^"]*)"`, 'i' );
	const m = attrs.match( re );
	return m ? m[ 1 ] : null;
}

/**
 * Parse `user@host:port …` out of the `sshConfig` attribute. The trailing
 * tokens are auth type or labels, ignored. Missing user → null.
 */
function parseUserFromSshConfig( sshConfig ) {
	if ( ! sshConfig ) return null;
	const m = sshConfig.match( /^\s*([^@\s]+)@/ );
	return m ? m[ 1 ] : null;
}

/**
 * Pull `deploy="…"` from the first `<mapping …/>` in the XML. The JetBrains
 * config can have multiple mappings; we take the first one — covers the
 * overwhelmingly common single-server case.
 */
function findFirstMappingDeploy( xml ) {
	const m = xml.match( /<mapping\b[^>]*?\bdeploy\s*=\s*"([^"]*)"/is );
	return m ? m[ 1 ] : null;
}

/**
 * @param {string} cwd absolute path to inspect
 * @returns {{
 *   found: boolean,
 *   host: string | null,
 *   port: string | null,
 *   user: string | null,
 *   deployPath: string | null,
 *   source: string | null,
 * }}
 */
export function detectIdeaSshDeployment( cwd ) {
	const empty = { found: false, host: null, port: null, user: null, deployPath: null, source: null };

	const ideaDir = join( cwd, '.idea' );
	if ( ! existsSync( ideaDir ) ) {
		logger.debug( 'idea-deployment-detector: no .idea/ directory — skipping' );
		return empty;
	}

	// Try deployment.xml first (modern), then webServers.xml (older). We pick the
	// first file that actually yields an SFTP tag.
	const candidates = [
		{ name: DEPLOYMENT_FILE, path: join( ideaDir, DEPLOYMENT_FILE ) },
		{ name: WEBSERVERS_FILE, path: join( ideaDir, WEBSERVERS_FILE ) },
	];

	for ( const { name, path } of candidates ) {
		logger.debug( `idea-deployment-detector: trying ${ path }` );
		const xml = readIfExists( path );
		if ( ! xml ) continue;

		let sftpAttrs;
		try {
			sftpAttrs = findFirstSftpTag( xml );
		} catch ( err ) {
			logger.debug( `idea-deployment-detector: parse failed for ${ name }: ${ err.message }` );
			continue;
		}
		if ( ! sftpAttrs ) {
			logger.debug( `idea-deployment-detector: no SFTP fileTransfer in ${ name }` );
			continue;
		}

		const host = attr( sftpAttrs, 'host' );
		if ( ! host ) {
			logger.debug( `idea-deployment-detector: SFTP tag without host attr in ${ name }; ignoring` );
			continue;
		}

		const port = attr( sftpAttrs, 'port' );
		const sshConfig = attr( sftpAttrs, 'sshConfig' );
		const user = parseUserFromSshConfig( sshConfig );
		const deployPath = findFirstMappingDeploy( xml );

		logger.debug( `idea-deployment-detector: parsed source=.idea/${ name } host=${ host } port=${ port || '' } user=${ user || '' } deployPath=${ deployPath || '' }` );

		return {
			found: true,
			host,
			port: port || null,
			user,
			deployPath,
			source: `.idea/${ name }`,
		};
	}

	logger.debug( 'idea-deployment-detector: no usable SFTP config found' );
	return empty;
}
