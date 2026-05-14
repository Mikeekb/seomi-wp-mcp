## Custom MCP Abilities (mu-plugin)

This project exposes custom WordPress abilities for AI agents through the must-use plugin
**`seomi-wp-mcp-abilities`** ([repo](https://github.com/Mikeekb/wp-mcp-abilities)), connected
here as a git submodule (or composer-managed dependency) at
`wp-content/mu-plugins/seomi-mcp-abilities/`. A tiny loader at
`wp-content/mu-plugins/mcp-abilities.php` bootstraps the package (WordPress only auto-loads
mu-plugin files in the directory root, not subdirectories).

Abilities are served via the **`{{WP_LOCAL_MCP_SERVER}}`** MCP server (production:
**`{{WP_PROD_MCP_SERVER}}`**) under the `seomi/*` namespace. Call
`mcp__{{WP_LOCAL_MCP_SERVER}}__mcp-adapter-discover-abilities` to list them at any time.

**Use these abilities first** for any read/write of content stored in the WordPress DB (posts,
pages, categories, tags, term descriptions, media, and — when WooCommerce is active —
products, product categories, and orders). They are aware of Yoast hook quirks — in particular
they keep rich HTML (`<table>`, `<tr>`, `<td>`, etc.) inside term descriptions intact, which
neither WP-CLI nor the plain REST API do.

| Method                                                          | Purpose                                                                |
|-----------------------------------------------------------------|------------------------------------------------------------------------|
| `seomi/get-posts`, `seomi/get-post`, `seomi/get-post-meta`      | Read posts                                                             |
| `seomi/create-post`, `seomi/update-post`, `seomi/delete-post`   | Posts CRUD                                                             |
| `seomi/find-posts-by-thumbnail`                                 | Find posts by featured-image file substring                            |
| `seomi/bulk-replace-in-posts`                                   | Regex/string replace across `post_content`                             |
| `seomi/get-pages`, `seomi/get-page` + CRUD                      | Pages                                                                  |
| `seomi/get-categories` + CRUD                                   | Categories                                                             |
| `seomi/get-tags` + CRUD                                         | Tags                                                                   |
| `seomi/search-terms`                                            | Find terms by substring (any taxonomy)                                 |
| `seomi/bulk-replace-in-term-descriptions`                       | Mass regex/string replace inside term descriptions (preserves tables)  |
| `seomi/get-attachment`, `seomi/find-attachments-by-file`        | Media lookups                                                          |
| `seomi/set-post-thumbnail`                                      | Set featured image                                                     |
| `seomi/wc/*`                                                    | WooCommerce CRUD (products, categories, orders) — when WC active       |

## Lifecycle

This integration is installed and maintained by the **`@seomi/wp-mcp`** npm CLI:

- `seomi-wp-mcp init` — first-time setup (run once per project)
- `seomi-wp-mcp update` — pull latest mu-plugin and regenerate this CLAUDE.md block
- `seomi-wp-mcp doctor` — diagnose env, mu-plugin, MCP server, plugin deps
- `seomi-wp-mcp doctor --fix` — auto-install/activate Abilities API + MCP Adapter

Credentials live in `.claude/.env` (gitignored). The block between
`<!-- seomi-wp-mcp:start -->` and `<!-- seomi-wp-mcp:end -->` is **CLI-managed** —
edit it via `seomi-wp-mcp update`, not by hand.

## Hard rules

1. Never write term descriptions via `$wpdb->update( $wpdb->term_taxonomy, ... )` — Yoast
   actions won't fire.
2. Never create/update WooCommerce products via `wp_insert_post` — use WC CRUD
   (`wc_get_product`, `$product->save()`). The `seomi/wc/*` abilities already do this.
3. When extending the mu-plugin, route every term-description write through
   `Seomi\Mcp\Core::with_admin_term_kses()` (it detaches `wp_filter_kses` from
   `pre_term_description` while the callback runs, mimicking admin behaviour).

**Smoke tests:** `wp eval-file wp-content/mu-plugins/seomi-mcp-abilities/tests/smoke.php`
(34 checks).
