import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	metrikaSkillAction,
	syncBundledSkills,
	BUNDLED_SKILLS,
	CORE_SKILLS,
	METRIKA_SKILL,
} from '../src/lib/skill-installer.mjs';
import { maybeSetupMetrikaOnUpdate, _internals as updateInternals } from '../src/commands/update.mjs';
import { resolveInitMetrikaSkillAction } from '../src/commands/init.mjs';

/**
 * The `yandex-metrika` skill ships only alongside the `yandex-metrika` MCP
 * server. These tests pin the decision (`metrikaSkillAction`), how it is
 * applied to the project (`syncBundledSkills`), and how `update` / `init`
 * arrive at it for every Metrica branch.
 */

const emptyGlobal = join( tmpdir(), `seomi-wp-mcp-no-global-gating-${ process.pid }` );

async function tmp( prefix = 'seomi-metrika-gating-' ) {
	return mkdtemp( join( tmpdir(), prefix ) );
}

async function makeFakeRoot( slugs = BUNDLED_SKILLS ) {
	const root = await tmp();
	for ( const slug of slugs ) {
		await mkdir( join( root, 'skills', slug ), { recursive: true } );
		await writeFile( join( root, 'skills', slug, 'SKILL.md' ), `# ${ slug }\n`, 'utf8' );
	}
	return root;
}

function internalsFor( root, globalDir = emptyGlobal ) {
	return { pkgRoot: () => root, globalSkillsDir: () => globalDir };
}

const skillPath = ( cwd, slug ) => join( cwd, '.claude', 'skills', slug );

const ABSENT = { hasEnv: false, hasVenv: false, hasMcp: false, configured: false };
const CONFIGURED = { hasEnv: true, hasVenv: true, hasMcp: true, configured: true };
const ENV_ONLY = { hasEnv: true, hasVenv: false, hasMcp: false, configured: false };
const MCP_ONLY = { hasEnv: false, hasVenv: false, hasMcp: true, configured: false };

// ─────────────────────────────────────────────────────────────────────────────
// metrikaSkillAction — the decision table
// ─────────────────────────────────────────────────────────────────────────────

test( 'metrikaSkillAction: accepted now → install', () => {
	assert.equal( metrikaSkillAction( { state: ABSENT, accepted: true } ), 'install' );
} );

test( 'metrikaSkillAction: already present (configured / env / mcp) → install', () => {
	assert.equal( metrikaSkillAction( { state: CONFIGURED } ), 'install' );
	assert.equal( metrikaSkillAction( { state: ENV_ONLY } ), 'install' );
	assert.equal( metrikaSkillAction( { state: MCP_ONLY } ), 'install' );
} );

test( 'metrikaSkillAction: nothing set up and not accepted → remove', () => {
	assert.equal( metrikaSkillAction( { state: ABSENT } ), 'remove' );
	assert.equal( metrikaSkillAction(), 'remove' );
} );

test( 'metrikaSkillAction: --no-metrika → remove when absent, keep when present', () => {
	assert.equal( metrikaSkillAction( { state: ABSENT, noMetrika: true } ), 'remove' );
	assert.equal( metrikaSkillAction( { state: CONFIGURED, noMetrika: true } ), 'keep' );
	assert.equal( metrikaSkillAction( { state: ABSENT, accepted: true, noMetrika: true } ), 'remove' );
} );

test( 'CORE_SKILLS: bundle without the Metrica skill', () => {
	assert.deepEqual( CORE_SKILLS, [ 'aif-wp-mcp', 'acf-fields', 'wp-forms' ] );
	assert.equal( METRIKA_SKILL, 'yandex-metrika' );
} );

// ─────────────────────────────────────────────────────────────────────────────
// syncBundledSkills — applying the decision to .claude/skills/
// ─────────────────────────────────────────────────────────────────────────────

test( 'syncBundledSkills install: all four skills land in the project', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	const res = await syncBundledSkills( cwd, { metrikaAction: 'install', _internals: internalsFor( root ) } );
	for ( const slug of BUNDLED_SKILLS ) assert.ok( existsSync( join( skillPath( cwd, slug ), 'SKILL.md' ) ), slug );
	assert.deepEqual( res.map( ( r ) => r.action ), [ 'installed', 'installed', 'installed', 'installed' ] );
} );

test( 'syncBundledSkills remove: core skills installed, yandex-metrika not installed', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	const res = await syncBundledSkills( cwd, { metrikaAction: 'remove', _internals: internalsFor( root ) } );
	for ( const slug of CORE_SKILLS ) assert.ok( existsSync( skillPath( cwd, slug ) ), slug );
	assert.ok( ! existsSync( skillPath( cwd, METRIKA_SKILL ) ) );
	assert.deepEqual( res.find( ( r ) => r.slug === METRIKA_SKILL ).action, 'not-needed' );
} );

test( 'syncBundledSkills remove: an existing project copy of yandex-metrika is deleted', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	await mkdir( skillPath( cwd, METRIKA_SKILL ), { recursive: true } );
	await writeFile( join( skillPath( cwd, METRIKA_SKILL ), 'SKILL.md' ), '# old\n', 'utf8' );
	const res = await syncBundledSkills( cwd, { metrikaAction: 'remove', _internals: internalsFor( root ) } );
	assert.ok( ! existsSync( skillPath( cwd, METRIKA_SKILL ) ) );
	assert.equal( res.find( ( r ) => r.slug === METRIKA_SKILL ).action, 'removed' );
} );

test( 'syncBundledSkills keep: an existing project copy is left untouched', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	await mkdir( skillPath( cwd, METRIKA_SKILL ), { recursive: true } );
	await writeFile( join( skillPath( cwd, METRIKA_SKILL ), 'SKILL.md' ), '# old\n', 'utf8' );
	await writeFile( join( skillPath( cwd, METRIKA_SKILL ), 'local.md' ), 'x', 'utf8' );
	const res = await syncBundledSkills( cwd, { metrikaAction: 'keep', _internals: internalsFor( root ) } );
	assert.ok( existsSync( join( skillPath( cwd, METRIKA_SKILL ), 'local.md' ) ), 'not wiped/recopied' );
	assert.equal( res.find( ( r ) => r.slug === METRIKA_SKILL ).action, 'kept' );
	for ( const slug of CORE_SKILLS ) assert.ok( existsSync( skillPath( cwd, slug ) ), slug );
} );

test( 'syncBundledSkills remove: a GLOBAL yandex-metrika skill is never touched', async () => {
	const root = await makeFakeRoot();
	const cwd = await tmp();
	const globalDir = await tmp();
	await mkdir( join( globalDir, METRIKA_SKILL ), { recursive: true } );
	await writeFile( join( globalDir, METRIKA_SKILL, 'SKILL.md' ), '# global\n', 'utf8' );
	await syncBundledSkills( cwd, { metrikaAction: 'remove', _internals: internalsFor( root, globalDir ) } );
	assert.ok( existsSync( join( globalDir, METRIKA_SKILL, 'SKILL.md' ) ) );
} );

// ─────────────────────────────────────────────────────────────────────────────
// update — maybeSetupMetrikaOnUpdate returns the skill action per branch
// ─────────────────────────────────────────────────────────────────────────────

async function withUpdateStubs( { state, creds = { enabled: false }, tty = false }, run ) {
	const original = { ...updateInternals };
	const calls = { setup: [], ask: [] };
	updateInternals.detectMetrikaState = async () => state;
	updateInternals.setupMetrika = async ( cwd, o ) => { calls.setup.push( o ); return {}; };
	updateInternals.askMetrikaCredentials = async ( o ) => { calls.ask.push( o ); return creds; };
	updateInternals.isInteractive = () => tty;
	try {
		const action = await run();
		return { action, calls };
	} finally {
		Object.assign( updateInternals, original );
	}
}

test( 'update --no-metrika, Metrica absent → remove, no setup, no prompt', async () => {
	const { action, calls } = await withUpdateStubs( { state: ABSENT, tty: true }, () =>
		maybeSetupMetrikaOnUpdate( '/x', { 'no-metrika': true } ) );
	assert.equal( action, 'remove' );
	assert.equal( calls.setup.length, 0 );
	assert.equal( calls.ask.length, 0 );
} );

test( 'update --no-metrika, Metrica configured → keep, no setup', async () => {
	const { action, calls } = await withUpdateStubs( { state: CONFIGURED }, () =>
		maybeSetupMetrikaOnUpdate( '/x', { 'no-metrika': true } ) );
	assert.equal( action, 'keep' );
	assert.equal( calls.setup.length, 0 );
} );

test( 'update, Metrica configured → refresh + install', async () => {
	const { action, calls } = await withUpdateStubs( { state: CONFIGURED }, () => maybeSetupMetrikaOnUpdate( '/x', {} ) );
	assert.equal( action, 'install' );
	assert.equal( calls.setup.length, 1 );
	assert.equal( calls.ask.length, 0 );
} );

test( 'update, creds only in .env → complete setup + install', async () => {
	const { action, calls } = await withUpdateStubs( { state: ENV_ONLY }, () => maybeSetupMetrikaOnUpdate( '/x', {} ) );
	assert.equal( action, 'install' );
	assert.equal( calls.setup.length, 1 );
} );

test( 'update, not configured, TTY, user agrees → setup + install', async () => {
	const { action, calls } = await withUpdateStubs(
		{ state: ABSENT, tty: true, creds: { enabled: true, env: { METRIKA_OAUTH_TOKEN: 't', METRIKA_COUNTER_ID: '1' } } },
		() => maybeSetupMetrikaOnUpdate( '/x', {} ) );
	assert.equal( action, 'install' );
	assert.equal( calls.ask.length, 1 );
	assert.equal( calls.setup.length, 1 );
} );

test( 'update, not configured, TTY, user declines → remove, no setup', async () => {
	const { action, calls } = await withUpdateStubs( { state: ABSENT, tty: true }, () => maybeSetupMetrikaOnUpdate( '/x', {} ) );
	assert.equal( action, 'remove' );
	assert.equal( calls.ask.length, 1 );
	assert.equal( calls.setup.length, 0 );
} );

test( 'update --metrika without TTY → prompt with assumeYes, install on success', async () => {
	const { action, calls } = await withUpdateStubs(
		{ state: ABSENT, tty: false, creds: { enabled: true, env: {} } },
		() => maybeSetupMetrikaOnUpdate( '/x', { metrika: true } ) );
	assert.equal( action, 'install' );
	assert.deepEqual( calls.ask, [ { assumeYes: true } ] );
} );

test( 'update, not configured, no TTY → remove, no prompt', async () => {
	const { action, calls } = await withUpdateStubs( { state: ABSENT, tty: false }, () => maybeSetupMetrikaOnUpdate( '/x', {} ) );
	assert.equal( action, 'remove' );
	assert.equal( calls.ask.length, 0 );
	assert.equal( calls.setup.length, 0 );
} );

test( 'update, only a yandex-metrika entry in .mcp.json, no TTY → install (server is registered)', async () => {
	const { action } = await withUpdateStubs( { state: MCP_ONLY, tty: false }, () => maybeSetupMetrikaOnUpdate( '/x', {} ) );
	assert.equal( action, 'install' );
} );

// ─────────────────────────────────────────────────────────────────────────────
// init — resolveInitMetrikaSkillAction against real project dirs
// ─────────────────────────────────────────────────────────────────────────────

async function projectWithEnv( text ) {
	const cwd = await tmp( 'seomi-init-gating-' );
	await mkdir( join( cwd, '.claude' ), { recursive: true } );
	await writeFile( join( cwd, '.claude', '.env' ), text, 'utf8' );
	return cwd;
}

test( 'init: user declines Metrica on a fresh project → remove', async () => {
	const cwd = await tmp( 'seomi-init-gating-' );
	assert.equal( await resolveInitMetrikaSkillAction( cwd, { opts: {}, metrikaCreds: { enabled: false } } ), 'remove' );
} );

test( 'init: user agrees to Metrica (prompt or --metrika) → install', async () => {
	const cwd = await tmp( 'seomi-init-gating-' );
	assert.equal( await resolveInitMetrikaSkillAction( cwd, { opts: {}, metrikaCreds: { enabled: true } } ), 'install' );
	assert.equal( await resolveInitMetrikaSkillAction( cwd, { opts: { metrika: true }, metrikaCreds: { enabled: true } } ), 'install' );
} );

test( 'init --no-metrika on a fresh project → remove', async () => {
	const cwd = await tmp( 'seomi-init-gating-' );
	assert.equal( await resolveInitMetrikaSkillAction( cwd, { opts: { 'no-metrika': true } } ), 'remove' );
} );

test( 'init re-run, Metrica creds already in .env, prompt declined → install', async () => {
	const cwd = await projectWithEnv( 'METRIKA_OAUTH_TOKEN=y0_x\nMETRIKA_COUNTER_ID=123\n' );
	assert.equal( await resolveInitMetrikaSkillAction( cwd, { opts: {}, metrikaCreds: { enabled: false } } ), 'install' );
} );

test( 'init re-run --no-metrika, Metrica creds already in .env → keep', async () => {
	const cwd = await projectWithEnv( 'METRIKA_OAUTH_TOKEN=y0_x\nMETRIKA_COUNTER_ID=123\n' );
	assert.equal( await resolveInitMetrikaSkillAction( cwd, { opts: { 'no-metrika': true } } ), 'keep' );
} );

test( 'init: empty METRIKA_* values do not count as configured → remove', async () => {
	const cwd = await projectWithEnv( 'METRIKA_OAUTH_TOKEN=\nMETRIKA_COUNTER_ID=\n' );
	assert.equal( await resolveInitMetrikaSkillAction( cwd, { opts: {}, metrikaCreds: { enabled: false } } ), 'remove' );
} );
