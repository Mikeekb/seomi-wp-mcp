# @seomi/wp-mcp

**English** | [Русский](./README.ru.md)

Universal installer for SEOMI MCP Abilities — wires any WordPress project to AI agents in one command. Inspired by `ai-factory`'s ergonomics: install globally once, then `init` per project.

```
npm install -g @seomi/wp-mcp
cd my-wp-project
seomi-wp-mcp init
```

That single `init` will:

1. Ask for WP credentials (URL, user, application password) — locally and optionally for prod.
2. Write `.claude/.env` (merging keys, never clobbering anything else).
3. **Auto-install** the WP plugin dependencies (`abilities-api` and `mcp-adapter`) via WP-CLI when available, or extract them into `wp-content/plugins/` as a fallback.
4. Connect the [`seomi/wp-mcp-abilities`](https://github.com/Mikeekb/wp-mcp-abilities) mu-plugin as a git submodule (or via Composer / plain clone).
5. Drop the `aif-wp-mcp` skill into `.claude/skills/` so future `/aif`-style sessions see it.
6. Insert a managed block into `CLAUDE.md` between `<!-- seomi-wp-mcp:start -->` markers.
7. Register the MCP server(s) in your Claude config (`claude mcp add`), or print copy-paste fallback commands if the `claude` CLI is missing.

Re-run any time — it's **idempotent**. Nothing duplicates, nothing gets clobbered.

## Why this exists

When you wire a WordPress project to Claude/an AI agent, you typically have to:

- Install the [WP Abilities API](https://github.com/WordPress/abilities-api) plugin.
- Install the [MCP Adapter](https://github.com/WordPress/mcp-adapter) plugin.
- Drop a mu-plugin that registers your own `seomi/*` (or `your-brand/*`) abilities.
- Generate an application password.
- Save credentials in `.claude/.env`.
- Register the MCP server in Claude with `claude mcp add ...`.
- Document the abilities in `CLAUDE.md`.
- Maybe add an ai-factory skill so AI assistants know to use the abilities first.

That's ~30 minutes of error-prone manual work, repeated for every WP project. `seomi-wp-mcp init` collapses it into one interactive flow.

## Commands

| Command                              | What it does                                                           |
|--------------------------------------|------------------------------------------------------------------------|
| `seomi-wp-mcp init`                  | Interactive first-time setup (see above)                               |
| `seomi-wp-mcp update`                | Pull the latest mu-plugin and regenerate the managed CLAUDE.md block   |
| `seomi-wp-mcp doctor`                | Diagnose env, mu-plugin presence, MCP server registration, plugin deps |
| `seomi-wp-mcp doctor --fix`          | Auto-install/activate Abilities API + MCP Adapter if missing           |
| `seomi-wp-mcp --verbose <command>`   | Add debug-level logging to any command                                 |
| `seomi-wp-mcp --version`             | Print version                                                          |

## Requirements

- **Node 20+** for the CLI itself.
- **PHP 8.0+** + **WordPress 6.4+** on the target project.
- **WP-CLI** (recommended) for the auto-install fallback chain.
- **Claude Code CLI** for `claude mcp add` registration (without it, the CLI just prints copy-paste commands instead of running them).

## Using with `ai-factory`

This CLI is designed to live alongside [ai-factory](https://github.com/lee-to/ai-factory). Two equivalent paths:

**Path A — full installer (recommended for first-time setup):**

```
aif init                          # ai-factory base setup
seomi-wp-mcp init                 # our integration (creds, mu-plugin, MCP server, etc.)
```

`seomi-wp-mcp init` drops the `aif-wp-mcp` skill at `.claude/skills/aif-wp-mcp/`, which subsequent `/aif`-style sessions will recognize whenever they see a `wp-content/` directory.

**Path B — skill-only (when you already have the abilities deployed and just want the AI context):**

```
npx skills add Mikeekb/seomi-wp-mcp
```

This installs only the `aif-wp-mcp` skill (from `skills/aif-wp-mcp/` in this repo) — the agent now knows about our abilities, but no `.claude/.env` is written and no MCP server is registered. Useful for read-only sessions where the WP project is already wired up.

> **Discovery from `aif init`:** an issue is open with [vercel-labs/skills](https://github.com/vercel-labs/skills) to index `aif-wp-mcp` on [skills.sh](https://skills.sh) so `aif init`'s `npx skills search` finds it automatically when it detects a WordPress project. Until that lands, the two-step flow above is the way.

The skill lives in its own folder under `.claude/skills/aif-wp-mcp/`, separate from the `aif-*` skills shipped by ai-factory, so updates to `ai-factory` never overwrite it.

## Configuration

All credentials live in `.claude/.env` (which is gitignored). Keys managed by this CLI:

| Key                       | Purpose                                              |
|---------------------------|------------------------------------------------------|
| `WP_LOCAL_URL`            | Local WordPress site URL                             |
| `WP_LOCAL_USER`           | Local WP admin username for Basic auth               |
| `WP_LOCAL_APP_PASSWORD`   | Local WP application password                        |
| `WP_LOCAL_MCP_SERVER`     | Name of the MCP server registered in Claude         |
| `WP_PROD_URL` / `_USER` / `_APP_PASSWORD` / `_MCP_SERVER` | Same for production         |
| `WP_DEPS_REF`             | Optional pin for `abilities-api` / `mcp-adapter` (default `trunk`) |

Other keys (added by you, by `deploy-prod`, etc.) are preserved across re-runs.

## Plugin dependency installation chain

For each dependency, `init` tries strategies in order:

1. **WP-CLI** (`wp plugin install <github-zip> --activate --force`) — preferred, works on local and remote with proper `--path` and `--ssh`.
2. **Zip download + extract** into `wp-content/plugins/<slug>/` — used when WP-CLI is missing. **No activation** happens in this mode — you'll be prompted to activate from WP admin.
3. **Manual command print** — last-resort, the CLI emits a copy-paste snippet.

The default refs are the `trunk` branches of `WordPress/abilities-api` and `WordPress/mcp-adapter`. Pin to a stable ref with `--pin-deps <tag-or-branch>` or set `WP_DEPS_REF` in `.claude/.env`.

## Idempotency contract

- `.claude/.env` is merged — keys you didn't touch (comments, deploy creds, third-party tokens) are preserved.
- The CLAUDE.md block is wrapped in `<!-- seomi-wp-mcp:start --> ... <!-- seomi-wp-mcp:end -->` markers and is regenerated in place; everything outside the markers stays untouched.
- MCP server registration checks `claude mcp list` before `claude mcp add` — no duplicates.
- `wp plugin is-active <slug>` is checked before install — no re-installs.

Run `seomi-wp-mcp init` ten times in a row and the project state converges to the same thing.

## Development

```bash
git clone https://github.com/Mikeekb/seomi-wp-mcp.git
cd seomi-wp-mcp
npm install
npm test         # node:test, no extra deps
node bin/seomi-wp-mcp.mjs --help
```

Layout:

```
bin/                    Entry point
src/
  commands/             init, update, doctor
  lib/                  logger, markers, env-writer, claude-mcp, wp-plugin-installer
skills/
  aif-wp-mcp/           Standard-path skill (npx skills compatible);
                        also copied into .claude/skills/ on init by our CLI
templates/
  claude-md-block.md    Managed block injected into CLAUDE.md
  claude-dotenv/        Reference .env.example
test/                   Node test runner suites
```

## License

Proprietary — © SEOMI. See `LICENSE`.

## Related projects

- [seomi/wp-mcp-abilities](https://github.com/Mikeekb/wp-mcp-abilities) — the mu-plugin this CLI installs.
- [WordPress/abilities-api](https://github.com/WordPress/abilities-api) — runtime dependency.
- [WordPress/mcp-adapter](https://github.com/WordPress/mcp-adapter) — runtime dependency.
- [ai-factory](https://github.com/lee-to/ai-factory) — companion project for AI dev context.
