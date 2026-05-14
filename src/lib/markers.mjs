/**
 * Idempotent marker-block management for files like CLAUDE.md.
 *
 * Wraps a managed block between:
 *   <!-- seomi-wp-mcp:start --> ... <!-- seomi-wp-mcp:end -->
 *
 * - insertOrUpdate(filePath, content, opts) — creates or replaces the block.
 * - removeBlock(filePath, opts) — strips the block entirely.
 * - hasBlock(filePath, opts) — boolean check.
 *
 * Safe to call repeatedly. Preserves all surrounding content verbatim.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_NAMESPACE = 'seomi-wp-mcp';

function buildMarkers( namespace ) {
	return {
		start: `<!-- ${ namespace }:start -->`,
		end: `<!-- ${ namespace }:end -->`,
	};
}

function buildRegex( namespace ) {
	const ns = namespace.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	// Greedy/global, multi-line. Match optional trailing newline so the block
	// is removed cleanly without leaving a blank line behind.
	return new RegExp(
		`<!--\\s*${ ns }:start\\s*-->[\\s\\S]*?<!--\\s*${ ns }:end\\s*-->\\n?`,
		'g'
	);
}

export async function hasBlock( filePath, { namespace = DEFAULT_NAMESPACE } = {} ) {
	if ( ! existsSync( filePath ) ) return false;
	const text = await readFile( filePath, 'utf8' );
	return buildRegex( namespace ).test( text );
}

export async function insertOrUpdate( filePath, content, { namespace = DEFAULT_NAMESPACE, appendIfNew = true } = {} ) {
	const { start, end } = buildMarkers( namespace );
	const block = `${ start }\n${ content.trim() }\n${ end }\n`;

	if ( ! existsSync( filePath ) ) {
		await mkdir( dirname( filePath ), { recursive: true } );
		await writeFile( filePath, block, 'utf8' );
		return { action: 'created', filePath };
	}

	const text = await readFile( filePath, 'utf8' );
	const regex = buildRegex( namespace );

	if ( regex.test( text ) ) {
		const updated = text.replace( regex, block );
		if ( updated !== text ) {
			await writeFile( filePath, updated, 'utf8' );
			return { action: 'updated', filePath };
		}
		return { action: 'unchanged', filePath };
	}

	if ( ! appendIfNew ) {
		return { action: 'not-found', filePath };
	}

	const sep = text.length > 0 && ! text.endsWith( '\n' ) ? '\n\n' : '\n';
	await writeFile( filePath, text + sep + block, 'utf8' );
	return { action: 'appended', filePath };
}

export async function removeBlock( filePath, { namespace = DEFAULT_NAMESPACE } = {} ) {
	if ( ! existsSync( filePath ) ) return { action: 'not-found', filePath };
	const text = await readFile( filePath, 'utf8' );
	const updated = text.replace( buildRegex( namespace ), '' );
	if ( updated === text ) return { action: 'unchanged', filePath };
	await writeFile( filePath, updated, 'utf8' );
	return { action: 'removed', filePath };
}
