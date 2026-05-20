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
 *
 * Matching is GREEDY (first `:start` to LAST `:end`): older non-greedy
 * versions of this module shipped a template whose body itself mentioned the
 * literal markers, which caused the non-greedy regex to match only up to the
 * first inline `:end` mention and leave orphan tails accumulating on each
 * `init` run. Greedy matching collapses any such corruption into a single
 * fresh block, and `stripOrphanMarkers` cleans up stray marker lines left
 * outside the matched span.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger.mjs';

const DEFAULT_NAMESPACE = 'seomi-wp-mcp';

function escapeRe( s ) {
	return s.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
}

function buildMarkers( namespace ) {
	return {
		start: `<!-- ${ namespace }:start -->`,
		end: `<!-- ${ namespace }:end -->`,
	};
}

/**
 * GREEDY: from the first `:start` to the LAST `:end`. No `g` flag — we want
 * a single match covering all corrupted/duplicated content as one span.
 */
function buildGreedyRegex( namespace ) {
	const ns = escapeRe( namespace );
	return new RegExp(
		`<!--\\s*${ ns }:start\\s*-->[\\s\\S]*<!--\\s*${ ns }:end\\s*-->\\n?`
	);
}

/**
 * Matches a standalone marker line (whitespace-only line containing just the
 * start or end marker). Used to clean orphan markers left outside the main
 * managed span by older broken installs.
 */
function buildOrphanLineRegex( namespace ) {
	const ns = escapeRe( namespace );
	return new RegExp(
		`^[ \\t]*<!--\\s*${ ns }:(?:start|end)\\s*-->[ \\t]*\\r?\\n?`,
		'gm'
	);
}

/**
 * Remove standalone marker lines from `text` EXCEPT inside `block` (the new
 * managed block we are about to write). When `block` is empty, strip
 * everywhere.
 */
function stripOrphanMarkers( text, namespace, block ) {
	const lineRegex = buildOrphanLineRegex( namespace );
	if ( ! block ) return text.replace( lineRegex, '' );
	const parts = text.split( block );
	if ( parts.length === 1 ) return text.replace( lineRegex, '' );
	return parts.map( ( p ) => p.replace( lineRegex, '' ) ).join( block );
}

export async function hasBlock( filePath, { namespace = DEFAULT_NAMESPACE } = {} ) {
	if ( ! existsSync( filePath ) ) return false;
	const text = await readFile( filePath, 'utf8' );
	return buildGreedyRegex( namespace ).test( text );
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
	const greedyRegex = buildGreedyRegex( namespace );

	if ( greedyRegex.test( text ) ) {
		let updated = text.replace( greedyRegex, block );
		updated = stripOrphanMarkers( updated, namespace, block );
		if ( updated === text ) {
			return { action: 'unchanged', filePath };
		}
		await writeFile( filePath, updated, 'utf8' );
		logger.debug( `[FIX] markers: replaced managed block in ${ filePath }` );
		return { action: 'updated', filePath };
	}

	// No managed span — but stray marker lines from past corruption may still
	// linger. Drop them before deciding whether to append.
	const cleaned = stripOrphanMarkers( text, namespace, '' );

	if ( ! appendIfNew ) {
		if ( cleaned !== text ) {
			await writeFile( filePath, cleaned, 'utf8' );
			return { action: 'cleaned', filePath };
		}
		return { action: 'not-found', filePath };
	}

	const sep = cleaned.length > 0 && ! cleaned.endsWith( '\n' ) ? '\n\n' : '\n';
	await writeFile( filePath, cleaned + sep + block, 'utf8' );
	return { action: 'appended', filePath };
}

export async function removeBlock( filePath, { namespace = DEFAULT_NAMESPACE } = {} ) {
	if ( ! existsSync( filePath ) ) return { action: 'not-found', filePath };
	const text = await readFile( filePath, 'utf8' );
	let updated = text.replace( buildGreedyRegex( namespace ), '' );
	updated = stripOrphanMarkers( updated, namespace, '' );
	if ( updated === text ) return { action: 'unchanged', filePath };
	await writeFile( filePath, updated, 'utf8' );
	return { action: 'removed', filePath };
}
