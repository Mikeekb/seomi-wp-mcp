The `--ssh=<spec>` in `mcpServers[*].args` of `.mcp.json` is the prod SSH channel — use it
both for content (via MCP) and for file deploys (`scp`/`rsync`/`ssh`), before suggesting
PhpStorm "Deploy" UI, GUI clients or manual copy. This block is CLI-managed
(`seomi-wp-mcp update` regenerates it) — don't edit it by hand.

{{ACCESS_SECTION}}

## WordPress content: `seomi/*` abilities first

{{ABILITIES_INTRO}}
Use them **first** for any read/write of DB content (posts, pages, terms, term descriptions,
media, WooCommerce products/orders) — unlike WP-CLI or plain REST they keep rich HTML in
term descriptions and fire Yoast hooks. Live list: `{{DISCOVER_COMMAND}}`.
If `seomi/*` is missing there, run `seomi-wp-mcp doctor` — don't silently fall back to WP-CLI.

**Hard rules:**
1. Never write term descriptions via `$wpdb->update( $wpdb->term_taxonomy, ... )` — Yoast
   actions won't fire.
2. Never create/update WooCommerce products via `wp_insert_post` — use WC CRUD
   (`wc_get_product`, `$product->save()`), as `seomi-wc/*` does.
3. In mu-plugin code, route every term-description write through
   `Seomi\Mcp\Core::with_admin_term_kses()`.

Missing an ability, or extending the mu-plugin (`wp-content/mu-plugins/seomi-mcp-abilities/`,
a git submodule in detached HEAD): announce the proposal and wait for OK, then follow the
playbook in the `aif-wp-mcp` skill.
