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
- **WooCommerce (when active):** `seomi/wc/get-products`, `seomi/wc/get-product`,
  `seomi/wc/create-product`, `seomi/wc/update-product`, `seomi/wc/delete-product`,
  `seomi/wc/update-product-price`, `seomi/wc/update-product-stock`, product-category CRUD,
  `seomi/wc/get-orders`, `seomi/wc/get-order`, `seomi/wc/update-order-status`.

## Hard rules

1. **Never** write term descriptions via `$wpdb->update( $wpdb->term_taxonomy, ... )` directly —
   Yoast `created_term` / `edited_term` actions don't fire and SEO indexes go stale.
2. **Never** create/update WooCommerce products via `wp_insert_post` / `wp_update_post` — use
   WC CRUD (`wc_get_product`, `$product->save()`). The `seomi/wc/*` abilities already do this
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
