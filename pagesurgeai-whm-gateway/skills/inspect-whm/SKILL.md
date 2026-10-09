---
name: inspect-whm
description: Inspect PageSurgeAI WHM accounts, packages and usage; create accounts; install and manage WordPress; preview and execute explicitly approved WordPress removal/reinstallation or account termination across accounts accessible to the configured WHM identity.
---

# Manage hosting and WordPress

Use the existing PageSurgeAI WHM Web connection. Preserve its App binding, OAuth settings and sharing. Account-wide capability access is not permission to change or delete any account.

## Inventory and account creation

Use `hosting_list_accounts`, `hosting_get_account`, `hosting_list_packages` and `hosting_get_usage` for read-only inspection. Obtain exact usernames/domains from reads; never guess a package.

Create only when the user requests that exact account and supplies domain, username, package and contact email. Use `hosting_create_account` with `confirm: true`. Requires `whm:read whm:create` and backend WHM Create Accounts permission. Honor authorization already supplied. Report created/already_exists accurately. Generated credentials stay private; use WHM for access.

Never expose passwords, WHM tokens, cPanel sessions or Bearer tokens. Never use arbitrary WHM calls, shell commands, forced privilege changes or bulk deletion. If a write times out, inspect inventory before further action.

Distinguish Auth0/OAuth scope failures from WHM 401/403 and session failures. Reconnecting Auth0 does not repair upstream permissions or credentials. For a deleted Auth0 application use [fresh connection recovery](references/fresh-connection.md).

## WordPress across accessible accounts

There is no fixed test-account restriction. The gateway selects the cPanel username from each request, verifies it through WHM accountsummary, and requires reseller ownership (or the configured WHM identity's own verified cPanel account). It creates a fresh HTTPS cPanel session through the existing WHM token. No extra Render username/password is needed per account. CPANEL_USERNAME is an optional legacy default, not an account allowlist. Legacy CPANEL_AUTH_MODE=password supports only its configured username; use WHM sessions for account-wide access.

All accounts means accounts verified as accessible through this WHM connection. A separate working WordPress connection does not prove WHM account access. If accountsummary rejects pageobol or a domain is absent, report that limitation; do not bypass it or promise hosting deletion/reset. The Namecheap - PageSurgeAI WordPress connection to pagesurgeai.com remains separate and does not itself provide WordPress-core uninstall or hosting termination.

Use `hosting_get_wordpress_status` before installing. Its inventory lists WordPress on the account's primary domain; unmanaged installations may be absent. Use `hosting_install_wordpress` only for a user-requested primary-domain root installation with domain, title, admin email and confirm=true. Requires `whm:read whm:wordpress`. Existing sites return already_exists without changes; existing-file protection remains enabled. Never infer an empty inventory means an empty web directory.

Require valid HTTPS except for the existing explicitly authorized isolated test domain mature-yellow-fish.104-219-248-4.cpanel.site. That HTTP exception never permits Bearer authentication or sending passwords/cPanel sessions over HTTP. Never disable certificate verification. Report completion only after API confirmation. Use Softaculous WordPress Manager Login; passwords stay private.

## Installation emails

`hosting_configure_wordpress_email` configures Softaculous installation email to the verified WHM account contact. Use only when requested with confirm=true and `whm:read whm:wordpress`. Do not substitute recipients. New installations also configure that notification. Password inclusion depends on Softaculous Email settings > Email password in plain text. Report an email request separately from verified inbox delivery. Never reinstall or reset a password to test email delivery.

## WordPress MCP and prompt changes

`hosting_setup_wordpress_mcp` installs the user's pinned WordPress MCP Manager 2.0.5 and configures a private derived Bearer hash for pagesurgeadmin on first activation. The existing OAuth gateway bridges WordPress; no per-account Render secret is needed. Preserve existing plugins/tokens. Report existing_plugin_needs_connection or installed_https_required accurately. Token regeneration or WHM-token rotation can invalidate a bridge; do not perform either merely to troubleshoot.

Call `hosting_wordpress_read` with tool=get_site_info before changes, then read exact IDs/current content. Valid WordPress HTTPS is required. Common reads include content_list (post_type=page/post), content_get (id), themes_list, plugins_list and list_wordpress_capabilities.

Use `hosting_wordpress_write` with `confirm: true` only for user-authorized changes; requires `whm:read whm:wordpress`. Parameters follow WordPress MCP Manager. content_create takes post_type, title, content, status and optional slug/excerpt/parent/featured_media/terms/meta. content_update takes exact id and requested fields. New pages default to draft unless publication was requested. Theme/plugin installation uses base64_zip; activation uses stylesheet/plugin from reads. Never invent writes to test connectivity.

## WordPress removal, fresh reinstall and account termination

For an explicit request to destroy a named target, first call `hosting_prepare_destructive_action` with action=delete_wordpress, reinstall_wordpress or delete_account, exact username and primary domain. WordPress actions also need the exact installation_id from inventory. This tool reads state, makes no hosting changes, and returns impact, backup_created=false, a ten-minute single-use plan_id, and the exact confirmation text.

Present the material impact before executing and ensure the user authorized this specific operation and target. A request to add capabilities, use all accounts, inspect capabilities, or prepare a preview does not authorize deletion. Honor an already explicit target-specific instruction without asking again unnecessarily; clarify ambiguous targets.

WordPress removal deletes all files within its installation directory (including unmanaged files), its database and its database user, while keeping the hosting account/mailboxes. Shared paths/databases/users or incomplete Softaculous metadata block removal. Reinstall currently supports the primary-domain root. The tools do not create backups; do not claim otherwise.

Account termination deletes every website/file/database/mailbox in that account, while retaining the DNS zone. The reseller's own account may also disable automation and reseller access. Explain this additional impact if that account is selected. The upstream WHM token must have Terminate Accounts (kill-acct) permission; do not grant it automatically.

Execute the matching tool: `hosting_delete_wordpress`, `hosting_reinstall_wordpress` or `hosting_delete_account`, supplying the returned plan_id, exact confirmation and confirm=true only for target-specific approval. All need `whm:read whm:delete`; WordPress destruction also needs `whm:wordpress`. Reinstall also takes site_title, admin_email and setup_mcp (default true). It validates connectivity/email settings before removal and then installs fresh WordPress and attempts fresh MCP setup.

The backend revalidates ownership, account identity and installation inventory. Plans expire, are single-use and become invalid after a gateway restart. They are consumed before destructive I/O. If removal/termination is uncertain, inspect current state; never blindly retry or reuse a plan. Report removed_reinstall_not_confirmed separately from reinstalled. A completed removal with failed/uncertain reinstallation is not a successful reset.

After deployment refresh the existing connection's tools. Add whm:delete to the existing Auth0 API permissions, grant it to the authorized connection/user and reauthorize with required scopes. A healthy process and passing automated tests do not prove upstream deletion permission. Do not perform a live destructive test unless explicitly requested for an exact target.

