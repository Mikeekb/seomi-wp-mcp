---
name: wp-forms
description: >
  Activate whenever working with contact forms, lead forms, form submission
  handling, Ajax form sending, or any HTML form that collects user data.
---

# WP Forms

## Rules

1. Custom forms only — no CF7, no WPForms, no plugins.
2. Ajax submission with a CSS preloader shown during request.
3. Recipient email pulled from ACF options page (not hardcoded).
4. Universal render function/class: caller passes field list, hidden fields attach automatically.
5. Hidden fields always included automatically: current page URL, form name.
6. CPT `inquiry` (non-public) for storing submissions as posts; admin menu item with unread count badge.
7. Always add phpmailer_init hook to prevent spam folders:
```php
add_action('phpmailer_init', 'wp_mail_returnpath_phpmailer_init');
if (!function_exists('wp_mail_returnpath_phpmailer_init')) {
    function wp_mail_returnpath_phpmailer_init($phpmailer) {
        $phpmailer->Sender = $phpmailer->From;
    }
}
```

8. UTM tracking: on every site visit, all `utm_*` GET params (plus `yclid`, `gclid`) are written to cookies for 30 days. Cookies are overwritten **only** when the URL contains a new UTM set — direct revisits preserve existing values (last-touch with persistence).
9. On form submission, UTM / click-ID cookies are (a) appended to the bottom of the email body as an "Источник перехода" block, and (b) saved as post meta on the `inquiry` CPT entry.
10. **Bot protection (verify-code)** — every AJAX form must use a two-step submission:

    1. Step 1 — the browser sends a separate AJAX request to `seomi_get_verify_code` and receives a short-lived code.
    2. Step 2 — the browser sends the form, attaching the code as `verify_code` in the POST body.

    **Server-side code generation:**
    ```
    HMAC-SHA256( REMOTE_ADDR + "|" + HTTP_USER_AGENT + "|" + bucket , key = AUTH_SALT )
    ```
    where `bucket = floor( time() / 60 )`. Use `wp_salt('auth')` only as a defensive fallback when `AUTH_SALT` is undefined. Same browser + same server within the same minute = same code. Any change in IP, User-Agent, or minute changes the code.

    **Server-side verification** (run BEFORE the nonce check, so bots that skip step 1 are stopped first):
    - Rebuild the expected code for `bucket` and `bucket - 1` (gives a 60–119-second validity window — that is the spec's "±1 minute").
    - Compare with `hash_equals` (constant-time). Never use `==` / `===`.
    - On mismatch: log a record via `loger($msg, $meta, 'spam_log')` (writes to `<theme>/logs/spam_log.txt`) and return a generic `wp_send_json_error` message — no hint to the bot about which check failed.
    - Never log the supplied code in full. Log only its length and the first 8 characters as a fingerprint, plus IP, truncated UA (200 chars), `form_type`, `page_url`, and the buckets the server was checking.

    **Verify-code endpoint requirements:**
    - Registered for both `wp_ajax_*` and `wp_ajax_nopriv_*` (anonymous visitors must be able to fetch).
    - Calls `nocache_headers()` so reverse proxies and browsers do not cache the issued code.
    - Response shape: `wp_send_json_success( array( 'code' => $code, 'ttl' => 60 ) )`.

    **Client-side helper (place once at the top of `scripts.js`):**
    ```js
    function seomiGetVerifyCode() {
        const body = new FormData();
        body.append('action', 'seomi_get_verify_code');
        return fetch(seomiFormsData.ajaxUrl, {
            method: 'POST', body, credentials: 'same-origin', cache: 'no-store',
        })
        .then(r => r.json())
        .then(res => {
            if (!res || !res.success || !res.data || !res.data.code) {
                throw new Error('verify_code_failed');
            }
            return res.data.code;
        });
    }
    ```
    Every form's submit handler then chains: `seomiGetVerifyCode().then(code => { body.append('verify_code', code); return fetch(...); })`. On `verify_code_failed`, show the same generic security error as the server returns. Never log the code itself to the browser console — debug-level logging is allowed, but only for "requesting" / "received", never the value.

    **Logging directory:** `<theme>/logs/`. Closed from web access via `.htaccess` (`Require all denied` / `Deny from all`) and a silent `index.php`. The `loger()` helper is placed inside that directory so its `dirname(__FILE__)` resolves to it.

    **Reverse-proxy caveat:** if the site is later put behind Cloudflare / nginx / a load balancer, `REMOTE_ADDR` will become the proxy's IP and the code becomes effectively constant per minute for all visitors. In that case switch the IP source to a trusted forwarded header (`HTTP_CF_CONNECTING_IP`, `HTTP_X_FORWARDED_FOR` validated against a trusted-proxy allowlist). Document this as a follow-up rather than ignore it.
