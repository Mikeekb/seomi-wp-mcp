---
name: aif-wp-mcp
description: |
  Activate whenever the user works with WordPress content via AI (read/write posts, pages,
  taxonomies, term descriptions, media, or WooCommerce products/orders) AND when setting up
  or repairing a SEOMI WP MCP integration on a project. Auto-trigger when the working
  directory contains wp-content/ or wp-config.php — this signals a WordPress project
  where the seomi/* abilities should be the first-class way of touching the database.

  Triggers (Russian and English):
  - "подключи WP MCP", "настрой MCP для WordPress", "добавь WooCommerce MCP"
  - "обнови WP MCP абилки", "почини WP MCP", "проверь MCP"
  - "set up WP MCP", "install WP MCP", "wire WordPress to MCP", "configure abilities"
  - "MCP server not working", "abilities not appearing", "fix WP MCP"

  Do NOT trigger for:
  - Generic WordPress questions that don't involve content read/write
  - PHP-only debugging not related to abilities or MCP
---

# aif-wp-mcp — SEOMI WordPress MCP integration

This skill manages the SEOMI WP MCP integration for the current project. It is a thin layer
on top of the `seomi-wp-mcp` npm CLI — it tells you which command to run and when, and it
embeds the contract for the abilities exposed by the mu-plugin.

## Auto-trigger conditions

Treat any of these as a signal to activate this skill:

| Signal                                                | Meaning                                          |
|-------------------------------------------------------|--------------------------------------------------|
| `wp-content/` directory in project root               | This is a WordPress project                      |
| `wp-config.php` in project root or one level up       | Same                                             |
| `.claude/.env` with `WP_LOCAL_MCP_SERVER`             | Integration already set up                       |
| `wp-content/mu-plugins/seomi-mcp-abilities/`          | Plugin connected (submodule / composer / copy)   |
| User mentions "MCP", "abilities", or "ai-agent" in a WordPress context | Same |

## When to invoke the CLI

| User intent                                  | Command                                |
|----------------------------------------------|----------------------------------------|
| "Set up WP MCP on this project"              | `npx @seomi/wp-mcp init`               |
| "Install MCP integration"                    | `npx @seomi/wp-mcp init`               |
| "Update WP MCP / pull latest abilities"      | `npx @seomi/wp-mcp update`             |
| "Check WP MCP is working" / "diagnose"       | `npx @seomi/wp-mcp doctor`             |
| "Fix WP MCP plugin deps"                     | `npx @seomi/wp-mcp doctor --fix`       |

If the package is installed globally (`npm i -g @seomi/wp-mcp`), use `seomi-wp-mcp` directly
without `npx`.

## Contract: abilities to prefer for content work

**Always prefer these abilities over `wp-cli`, the plain WP REST API, or `$wpdb` writes
when manipulating content stored in the WordPress DB.** They handle Yoast hook quirks and
preserve rich HTML (tables, etc.) inside term descriptions.

Use `mcp__<server-name>__mcp-adapter-discover-abilities` to see the live list at any time.
Common methods (full reference in `references/abilities.md`):

- **Posts:** `seomi/get-posts`, `seomi/get-post`, `seomi/get-post-meta`, `seomi/create-post`,
  `seomi/update-post`, `seomi/delete-post`, `seomi/find-posts-by-thumbnail`,
  `seomi/bulk-replace-in-posts`.
- **Pages:** `seomi/get-pages`, `seomi/get-page`, `seomi/create-page`, `seomi/update-page`,
  `seomi/delete-page`.
- **Terms (categories + tags + any taxonomy):** `seomi/get-categories`, `seomi/create-category`,
  `seomi/update-category`, `seomi/delete-category`, `seomi/get-tags` and tag CRUD,
  `seomi/search-terms`, `seomi/bulk-replace-in-term-descriptions`.
- **Media:** `seomi/get-attachment`, `seomi/find-attachments-by-file`, `seomi/set-post-thumbnail`.
- **WooCommerce (when active):** `seomi-wc/get-products`, `seomi-wc/get-product`,
  `seomi-wc/create-product`, `seomi-wc/update-product`, `seomi-wc/delete-product`,
  `seomi-wc/update-product-price`, `seomi-wc/update-product-stock`, product-category CRUD,
  `seomi-wc/get-orders`, `seomi-wc/get-order`, `seomi-wc/update-order-status`.

## Hard rules

1. **Never** write term descriptions via `$wpdb->update( $wpdb->term_taxonomy, ... )` directly —
   Yoast `created_term` / `edited_term` actions don't fire and SEO indexes go stale.
2. **Never** create/update WooCommerce products via `wp_insert_post` / `wp_update_post` — use
   WC CRUD (`wc_get_product`, `$product->save()`). The `seomi-wc/*` abilities already do this
   correctly.
3. If `mcp__<server-name>__mcp-adapter-discover-abilities` does not list the expected `seomi/*`
   methods, **stop** and run `seomi-wp-mcp doctor` before any further attempt — don't fall back
   to WP-CLI silently. The user explicitly requested DB-aware writes.
4. Credentials live in `.claude/.env` (gitignored). Never commit `.env` and never paste an app
   password into chat output.

## Where things live

- npm CLI: `@seomi/wp-mcp` (repo: https://github.com/Mikeekb/seomi-wp-mcp)
- mu-plugin: `seomi/wp-mcp-abilities` (repo: https://github.com/Mikeekb/wp-mcp-abilities)
- Skill files (this skill): `.claude/skills/aif-wp-mcp/` — managed by the CLI, regenerated
  on `seomi-wp-mcp update`. Do not hand-edit; changes will be overwritten.

## Proactive gap detection (no explicit user request required)

The agent should **proactively notice when an MCP ability is missing** and propose adding
it — not wait for the user to ask. The triggers below count as a missing-ability signal:

- About to do **3+ sequential** raw calls (`get_post_meta`, `get_term_meta`, `$wpdb` queries)
  to compose data that one ability could return as a single payload.
- Falling back to **`wp eval`**, **`wp db query`**, or **raw `$wpdb`** because no `seomi/*`
  method exists for the operation the user just asked for.
- Doing the **same workaround a second time in the same session** for the same kind of
  read/write.
- Needing to touch a domain the modules don't cover (users, comments, options, menu items,
  scheduled events, transients) and that the user's task plausibly needs again later.
- A bulk operation where the only available abilities require N round-trips (e.g. updating
  prices for 200 products one by one when a bulk method would obviously help).

**What to do when triggered:**

1. **Pause and announce.** One short message to the user, before any file edit, with:
   - the name and one-line description of the proposed ability (`seomi/<module>/<verb>` or
     `seomi/<verb>`),
   - the input/output sketch (JSON schema in plain text, 3–6 lines),
   - **whether it should live in the shared mu-plugin** (`Mikeekb/wp-mcp-abilities`,
     submodule) **or as a project-local module** (separate mu-plugin file inside the parent
     project — see the *Project-local abilities* section below).
2. **Wait for user OK.** Do not edit submodule files or open a PR until the user confirms.
   The submodule is shared across all SEOMI WP projects; pushes there are visible
   everywhere on the next `submodule update --remote`.
3. **On OK → follow the playbook** in "Adding a new ability" below.

**When NOT to propose** (silently keep using the workaround instead):

- One-off task you genuinely won't repeat (debugging investigation, one-time data fix).
- Highly project-specific business logic (`get_field('xyz_partner_id')`, client-only post
  meta). These belong in a project-local module, never in the shared submodule.
- Anything that exists only to bypass a permission or capability check — security boundary,
  not a missing feature.
- Trivial wrappers that don't reduce round-trips or simplify schemas.

## Shared mu-plugin vs project-local abilities

The mu-plugin `seomi-mcp-abilities` (submodule) ships abilities that make sense for **every**
SEOMI WordPress project. If a needed ability is universal — propose adding it there.

If it is project-specific (one client's CPT, one client's ACF schema, one project's
integration), add it as a **project-local module** instead:

1. Create a new mu-plugin file in the parent project at
   `wp-content/mu-plugins/<project>-mcp-extensions.php` (not inside the submodule).
2. Implement `Seomi\Mcp\Modules\ModuleInterface` and register it directly via
   `add_action( 'wp_abilities_api_init', ... )` at priority `20` (after the shared
   plugin runs). Namespace your abilities under `<project>/...` or `seomi/<project>/...`
   — never `seomi/...` for project-local additions, to keep the shared namespace clean.
3. The project-local file is just another mu-plugin and follows the same rules
   (`with_admin_term_kses`, WC CRUD, etc.) — see the mu-plugin README's
   "Adding your own module" section for the boilerplate.
4. Commit it in the parent project's repo, not in the submodule.

Default to project-local whenever the ability touches CPTs, ACF schemas, or business rules
that aren't shared across SEOMI projects. When in doubt, **ask the user** in the same
announcement message: "shared or project-local?"

## Adding a new ability — playbook

Triggers: "добавь абилку <X>", "нужна возможность <X>", "не хватает MCP метода для <X>",
"add a `seomi/<X>` ability", "extend the mu-plugin to support <X>", *or any proactive
detection from the section above with the user's OK*.

When the user asks for a new MCP method, treat the standalone mu-plugin repo as the source
of truth, not the project-local files. The mu-plugin is a git submodule, so the working
tree is in detached HEAD by default — naïve in-place edits get lost.

**Step-by-step sequence:**

1. **Pick the home module** in `wp-content/mu-plugins/seomi-mcp-abilities/src/Modules/`:
   `Posts.php`, `Pages.php`, `Terms.php`, `Media.php`, `WooCommerce.php`. New domain →
   create a new module file and **register it in `$module_map`** inside
   `seomi-mcp-abilities.php` (without this step the ability will never be registered).
2. **Attach HEAD:** `cd wp-content/mu-plugins/seomi-mcp-abilities && git checkout main && git pull --ff-only`.
3. **Implement** following existing patterns:
   - `input_schema` is JSON Schema (`properties`, `required`).
   - `execute_callback` returns the result or `new WP_Error(...)`.
   - `permission_callback` uses `current_user_can( <capability> )`.
   - Term-description writes → wrap in `Seomi\Mcp\Core::with_admin_term_kses()`.
   - Product writes → WC CRUD API (`wc_get_product`, `$product->save()`).
   - Verbose log: `\seomi_mcp_log( "[<module>] <action> ..." )`.
4. **Extend smoke test** in `tests/smoke.php`: add the ability name to `$expected` (or
   `$wc_abilities` for Woo). Optionally add a behavioural check. Run:
   `wp eval-file wp-content/mu-plugins/seomi-mcp-abilities/tests/smoke.php` — must be
   `Failures: 0`.
5. **Push the standalone repo:**
   ```
   cd wp-content/mu-plugins/seomi-mcp-abilities
   git add -A && git commit -m "feat(<module>): add seomi/<name>"
   git push origin main
   ```
6. **Bump the submodule pointer** in the parent project:
   ```
   cd <project-root>
   git add wp-content/mu-plugins/seomi-mcp-abilities
   git commit -m "chore(mcp-abilities): bump submodule with seomi/<name>"
   ```
7. **Verify live:** call `mcp__<server>__mcp-adapter-discover-abilities`. If the new
   ability isn't visible but WP-CLI smoke is green, PHP-FPM opcache is the suspect —
   restart PHP-FPM or wait for opcache TTL.

**Hard don'ts** (the agent must enforce these):
- ❌ Editing submodule files without `git checkout main` first.
- ❌ Adding a new module file without updating `$module_map`.
- ❌ Skipping the smoke run before push.
- ❌ Writing to `$wpdb->term_taxonomy` or `wp_insert_post`-for-products directly.

If the user has already discussed this exact ability before in the conversation, jump
straight to step 1; otherwise summarize the proposed schema and ask for confirmation
before opening any files.
