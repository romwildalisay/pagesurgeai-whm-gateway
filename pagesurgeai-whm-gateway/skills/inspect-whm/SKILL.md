---
name: inspect-whm
description: Inspect PageSurgeAI WHM accounts, packages and usage; create accounts; adjust monthly bandwidth; install SSL from certificate ZIPs; install and manage WordPress; preview and execute explicitly approved WordPress removal/reinstallation or account termination across accounts accessible to the configured WHM identity.
---

# Manage hosting and WordPress

Use the existing PageSurgeAI WHM Web connection. Preserve its App binding, OAuth settings and sharing. Account-wide capability access is not permission to change or delete any account.

## Inventory and account creation

Use `hosting_list_accounts`, `hosting_get_account`, `hosting_list_packages` and `hosting_get_usage` for read-only inspection. Obtain exact usernames/domains from reads; never guess a package.

Create only when the user requests that exact account and supplies domain, username, package and contact email. Use `hosting_create_account` with `confirm: true`. Requires `whm:read whm:create` and backend WHM Create Accounts permission. Honor authorization already supplied. Report created/already_exists accurately. Generated credentials stay private; use WHM for access.

Never expose passwords, WHM tokens, cPanel sessions or Bearer tokens. Never use arbitrary WHM calls, shell commands, forced privilege changes or bulk deletion. If a write times out, inspect inventory before further action.

Distinguish Auth0/OAuth scope failures from WHM 401/403 and session failures. Reconnecting Auth0 does not repair upstream permissions or credentials. For a deleted Auth0 application use [fresh connection recovery](references/fresh-connection.md).

## WordPress across accessible accounts

There is no fixed test-account restriction. WordPress tools accept an exact primary domain (preferred) or a cPanel username. When only a domain is provided, the gateway resolves it through WHM account inventory, then verifies the selected cPanel account and reseller ownership before making a request. If both username and domain are supplied, they must match. It creates a fresh HTTPS cPanel session through the existing WHM token. No extra Render username/password is needed per account. CPANEL_USERNAME is an optional legacy default, not an account allowlist. Legacy CPANEL_AUTH_MODE=password supports only its configured username; use WHM sessions for account-wide access.

All accounts means accounts verified as accessible through this WHM connection. A separate working WordPress connection does not prove WHM account access. If accountsummary rejects pageobol or a domain is absent, report that limitation; do not bypass it or promise hosting deletion/reset. The Namecheap - PageSurgeAI WordPress connection to pagesurgeai.com remains separate and does not itself provide WordPress-core uninstall or hosting termination.

Use `hosting_get_wordpress_status` before installing. Supply the exact primary domain; a username is optional. Its inventory lists WordPress on that account's primary domain; unmanaged installations may be absent. Use `hosting_install_wordpress` only for a user-requested primary-domain root installation with domain, title, admin email and confirm=true. The gateway resolves the account automatically through WHM. Requires `whm:read whm:wordpress`. Existing sites return already_exists without changes; existing-file protection remains enabled. Never infer an empty inventory means an empty web directory.

Require valid HTTPS except for the existing explicitly authorized isolated test domain mature-yellow-fish.104-219-248-4.cpanel.site. That HTTP exception never permits Bearer authentication or sending passwords/cPanel sessions over HTTP. Never disable certificate verification. Report completion only after API confirmation. Use Softaculous WordPress Manager Login; passwords stay private.

## Installation emails

`hosting_configure_wordpress_email` configures Softaculous installation email to the verified WHM account contact and requests password inclusion for new installs. Use only when requested with confirm=true and `whm:read whm:wordpress`. Do not substitute recipients. New installations use the same verified contact. Report email requested separately from inbox delivery; never reinstall or reset a password to test email delivery.

## WordPress MCP and prompt changes

`hosting_setup_wordpress_mcp` installs the user's pinned WordPress MCP Manager 2.0.7 and configures a private derived Bearer hash for pagesurgeadmin on first activation. Select sites by exact primary domain; the existing OAuth gateway resolves each site's verified account and routes to that site's independent token. One gateway connection can manage multiple reseller-owned accounts; no per-account Render secret is needed. Preserve existing plugins/tokens. Report existing_plugin_needs_connection or installed_https_required accurately. Token regeneration or WHM-token rotation can invalidate a bridge; do not perform either merely to troubleshoot. The plugin's `users_password_reset_email` action sends WordPress's native reset link only; never send or email a password.

Call `hosting_wordpress_read` with the exact primary domain and tool=get_site_info before changes, then read exact IDs/current content. Valid WordPress HTTPS is required. Common reads include content_list (post_type=page/post), content_get (id), themes_list, plugins_list and list_wordpress_capabilities.

Use `hosting_wordpress_write` with the exact primary domain and `confirm: true` only for user-authorized changes; requires `whm:read whm:wordpress`. Parameters follow WordPress MCP Manager. content_create takes post_type, title, content, status and optional slug/excerpt/parent/featured_media/terms/meta. content_update takes exact id and requested fields. New pages default to draft unless publication was requested. Theme/plugin installation uses base64_zip; activation uses stylesheet/plugin from reads. Never invent writes to test connectivity.

## WordPress removal, fresh reinstall and account termination

For an explicit request to destroy a named target, first call `hosting_prepare_destructive_action` with action=delete_wordpress, reinstall_wordpress or delete_account, exact username and primary domain. WordPress actions also need the exact installation_id from inventory. This tool reads state, makes no hosting changes, and returns impact, backup_created=false, a ten-minute single-use plan_id, and the exact confirmation text.

Present the material impact before executing and ensure the user authorized this specific operation and target. A request to add capabilities, use all accounts, inspect capabilities, or prepare a preview does not authorize deletion. Honor an already explicit target-specific instruction without asking again unnecessarily; clarify ambiguous targets.

WordPress removal deletes all files within its installation directory (including unmanaged files), its database and its database user, while keeping the hosting account/mailboxes. Shared paths/databases/users or incomplete Softaculous metadata block removal. Reinstall currently supports the primary-domain root. The tools do not create backups; do not claim otherwise.

Account termination deletes every website/file/database/mailbox in that account, while retaining the DNS zone. The reseller's own account may also disable automation and reseller access. Explain this additional impact if that account is selected. The upstream WHM token must have Terminate Accounts (kill-acct) permission; do not grant it automatically.

Execute the matching tool: `hosting_delete_wordpress`, `hosting_reinstall_wordpress` or `hosting_delete_account`, supplying the returned plan_id, exact confirmation and confirm=true only for target-specific approval. All need `whm:read whm:delete`; WordPress destruction also needs `whm:wordpress`. Reinstall also takes site_title, admin_email and setup_mcp (default true). It validates connectivity/email settings before removal and then installs fresh WordPress and attempts fresh MCP setup.

The backend revalidates ownership, account identity and installation inventory. Plans expire, are single-use and become invalid after a gateway restart. They are consumed before destructive I/O. If removal/termination is uncertain, inspect current state; never blindly retry or reuse a plan. Report removed_reinstall_not_confirmed separately from reinstalled. A completed removal with failed/uncertain reinstallation is not a successful reset.

After deployment refresh the existing connection's tools. Add whm:delete to the existing Auth0 API permissions, grant it to the authorized connection/user and reauthorize with required scopes. A healthy process and passing automated tests do not prove upstream deletion permission. Do not perform a live destructive test unless explicitly requested for an exact target.


## Account bandwidth limits

Use `hosting_get_bandwidth` with the exact username and primary domain before a change. It reads WHM showbw and returns current-month usage and a limit in MB. WHM showbw reports bytes; the gateway converts using 1024 * 1024. Use 1 GB = 1024 MB in prompts and state the conversion (2 GB = 2048 MB).

Use `hosting_set_bandwidth` only for an explicit account-specific adjustment, with username, primary domain, integer `limit_mb` or literal `unlimited`, and confirm=true. Zero is rejected; unlimited must be explicit. Requires whm:read whm:bandwidth plus WHM Bandwidth Limit Modification (limit-bandwidth), View Account Bandwidth Usage (show-bandwidth), and Account Summary. Preview usage and explain interruption risk if the requested limit is below current usage. `allow_below_usage` defaults false; set true only after the user explicitly accepts that impact, including unknown usage during a reduction.

The gateway verifies ownership/domain, changes only that account, and independently reads back the limit. It does not edit packages, unsuspend accounts or reset usage. Later package changes may overwrite custom limits. Distinguish updated, already_set and change_not_verified. On uncertain results, inspect hosting_get_bandwidth; do not repeat the write automatically.

## SSL installation from an attached ZIP

Use `hosting_get_ssl_status` for a read-only public HTTPS check on a verified account/domain. It reports public TLS status and safe certificate metadata; a CDN may serve a different certificate. It does not establish WordPress/MCP authentication or origin-server status.

An attached ZIP must contain the issued PEM server certificate (.crt/.pem), exactly one matching unencrypted private key (.key/.pem), and required intermediate CA certificates (.ca-bundle/.crt/.pem). Keys alone or a CSR do not provide an issued certificate. No certificate purchase, issuance, activation, automatic renewal or DNS changes are implemented. Password-protected ZIPs, encrypted keys, PFX/P12, self-signed/untrusted certificates, unsafe paths and oversized archives are rejected. Maximum compressed ZIP is 256 KiB, 32 entries, 128 KiB per entry, 512 KiB expanded total. Cert validation checks SAN domain coverage, matching key, dates, supported RSA/ECDSA strength, and a trusted TLS-server chain via Node public roots and OpenSSL 3. Revocation is not checked. Private keys remain in memory and are never extracted to disk by the gateway.

Obtain the actual attached ZIP using the host's supported file access; do not guess a file path or send a local path/attachment URL to the remote server. Encode the ZIP bytes as base64 only for the tool's `zip_base64` argument. Do not print the archive, decoded private key or its base64 in chat, logs, Pages or source files. Do not persist a duplicate of the credential archive. If this host cannot read/encode the attachment, report that limitation rather than inventing its contents.

First call `hosting_validate_ssl_zip` with username, domain and zip_base64. This checks WHM account ownership and exact domain owner (including addon/subdomains verified by getdomainowner), validates the supplied archive, returns safe metadata and impact, and makes no SSL change. Requires whm:read whm:ssl.

Call `hosting_install_ssl_zip` with the same exact target/archive and confirm=true only for an explicitly requested certificate installation. Installation revalidates the ZIP and domain ownership; it may replace the certificate on the Apache SSL virtual host and affect aliases sharing that host. Do not treat a request to add the capability or validate a ZIP as permission to install. Honor an already explicit target-specific installation request without asking again unnecessarily. Requires whm:read whm:ssl plus WHM SSL Site Management (ssl) and domain/account read permissions.

PEM certificate/key/chain are sent only in a verified HTTPS POST body to the configured WHM host, never URLs. Raw upstream output is discarded. Report WHM installation separately from `public_tls.https_verified` and `supplied_certificate_served`; DNS propagation, Apache deployment or a proxy may prevent independent confirmation. Installation does not change WordPress URLs or enable redirects. Inspect public status/WHM after uncertain writes, never automatically reinstall. If OpenSSL 3 is unavailable, validation blocks installation; /health checks.ssl_validator reports runtime readiness.

For activation add/grant whm:bandwidth and whm:ssl to the existing Auth0 API, reauthorize the existing PageSurgeAI WHM Web connection with those scopes, and refresh its tools. Keep existing requested read/create/WordPress scopes; whm:delete is unnecessary for these tools and remains optional. Do not grant upstream privileges or rotate existing secrets automatically.

Example user prompts:
- "For example.com, show the current monthly bandwidth limit and usage. Do not make changes."
- "Set example.com's monthly bandwidth limit to 2 GB (2048 MB). Keep its hosting package unchanged."
- "Validate the attached SSL ZIP for example.com. Do not install it yet."
- "Install the certificate from this attached ZIP for example.com, then check public HTTPS."
