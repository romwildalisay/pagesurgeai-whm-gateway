---
name: inspect-whm
description: Inspect PageSurgeAI WHM accounts, packages, and usage, create a hosting account, or set up WordPress on the configured test account when explicitly requested. Use for hosting inventory, account lookup, usage, account provisioning, and WordPress installation through the connected Web gateway.
---

# Manage WHM hosting

Use the existing PageSurgeAI WHM Web connection. Preserve its App binding and working OAuth settings.

For inspection, use the four read-only tools:

- Call `hosting_list_accounts` to discover usernames and domains.
- Call `hosting_get_account` with an exact cPanel username for details.
- Call `hosting_list_packages` to inspect available reseller packages.
- Call `hosting_get_usage` with an exact cPanel username for usage.

For account creation:

1. Require an explicit user request to create an account. Never infer this from an inventory request.
2. Obtain the domain, cPanel username, exact package name, and contact email. List packages to verify the choice; never invent a package.
3. Use `hosting_create_account` with those fields and `confirm: true` when the user has authorized that specific account. Honor authorization already provided; do not ask again unnecessarily.
4. Require both `whm:read` and `whm:create` in OAuth and Create Accounts permission on the backend WHM token. If the tool is absent, explain that the deployed gateway and the existing Web connection's discovered tools must be refreshed; do not claim creation succeeded.
5. Report `created` or `already_exists` exactly. For a timeout, network failure, or uncertain result, inspect inventory before any retry. Never blindly repeat a write.
6. Explain that account credentials are generated privately. Direct the user to WHM to access cPanel or reset its password. Never request or display secrets in chat.

Never use arbitrary WHM calls, shell commands, or unsupported account modification, suspension, restoration, or deletion. Account creation does not install WordPress.

Distinguish OAuth challenges from upstream WHM errors. For missing creation scope, reauthorize the existing connection after granting that permission. For WHM HTTP 401/403, check backend credentials, token permissions, and access restrictions. A healthy process does not prove OAuth or WHM access works.

If the user deleted an Auth0 application, use [fresh connection recovery](references/fresh-connection.md). Never request a client secret, access token, password, or WHM API token in chat.

## WordPress setup on the test account

Use `hosting_get_wordpress_status` with the exact test-account username to inspect Softaculous before installation. The server verifies reseller ownership and restricts access to `CPANEL_USERNAME` configured privately in Render. Use the existing WHM reseller token for a temporary cPanel session; keep cookies and session URLs private. Never request root access or automatically change token/reseller privileges. If session creation is rejected, report the failure and required operation without claiming authentication succeeded.

Require the target domain, site title, and admin email. Install only on the test account's primary domain at its root. Require HTTPS except for the explicitly authorized isolated test domain `mature-yellow-fish.104-219-248-4.cpanel.site`, which currently uses HTTP while SSL is unavailable. Keep all WHM and cPanel authentication on verified HTTPS. Explain that website traffic is unencrypted until SSL is installed; do not extend the exception to another domain. Treat a user request to proceed with WordPress setup on a named domain as authorization to install there; honor authorization already provided. Call `hosting_install_wordpress` with those settings and `confirm: true` only within that request.

Installation requires `whm:read whm:wordpress`, the existing backend WHM reseller token, and `CPANEL_USERNAME` identifying the restricted test account in Render. By default, `CPANEL_AUTH_MODE=whm-session` creates a temporary session via WHM `create_user_session`; individual cPanel passwords are not required. Keep ownership and test-account checks before all operations. The optional legacy `CPANEL_AUTH_MODE=password` adapter requires `CPANEL_PASSWORD` entered only in Render's secure environment settings, never in chat. The adapter uses the WHM hostname over HTTPS on cPanel port 2083 with the Jupiter Softaculous endpoint; authentication or endpoint availability must be tested on the actual server.

Never disable TLS verification, overwrite files, reinstall an existing site, or retry an uncertain write blindly. Inspect WordPress Manager and inventory after timeout or partial success. An empty Softaculous inventory does not prove that no unmanaged website files exist.

Report `installed` only after the API confirms completion and verify status afterward. Report `already_exists` as no changes. Use the WordPress Manager Login button for admin access; generated passwords remain private. The WordPress MCP plugin is a separate next step and is not installed by this tool.

## WordPress installation emails

Use `hosting_configure_wordpress_email` with the exact configured test-account username and `confirm: true` only when email setup is requested. Require `whm:read whm:wordpress`. The server verifies ownership and uses the current WHM contact email; never substitute an arbitrary recipient. This configures Softaculous installation notifications, not an email of an existing password.

New WordPress installations automatically configure installation email delivery to the verified hosting contact before installing. Report the email request separately from inbox receipt. Password inclusion requires Softaculous Email settings > Email password in plain text; do not claim the password was included or delivered without evidence. The user must enable that setting in Softaculous; the gateway does not guess an undocumented API field.

Never reinstall a site, retrieve stored passwords, reset a password, or send a credential message merely to test this setup. If the user requests existing-site credentials, explain that this function cannot resend the original password. Keep all credentials out of chat. Inspect inbox receipt only when a future explicitly authorized installation sends its email.

## WordPress MCP Manager and prompt changes

Use `hosting_setup_wordpress_mcp` with the configured test-account username and `confirm: true` when the user requests installation/connection of their WordPress MCP Manager. Version 2.0.5 is bundled from the user's package. This modifies the shared gateway's available tools, while retaining the existing Web App/OAuth connection and account restrictions. The first activation configures a private token hash for `pagesurgeadmin`; the gateway derives the Bearer token from its existing private WHM token with account and installation separation. No extra per-account Render variable or WordPress password is needed. Tokens never appear in chat. Rotating the WHM token or regenerating the WordPress token changes this connection; do not do either to troubleshoot without an explicit request.

Public Bearer requests always require valid HTTPS. The HTTP installation exception does not permit Bearer authentication over HTTP or disabling TLS verification. Report `installed_https_required` as installation requested/confirmed by Softaculous with connection pending, never as connected. Report `existing_plugin_needs_connection` accurately; do not overwrite an existing plugin or token. On uncertain upload results, inspect WordPress Manager before retrying. If these tools are absent, explain that the existing PageSurgeAI WHM Web connection's tools need refreshing; do not claim plugin installation or token configuration has occurred.

Call `hosting_wordpress_read` with `tool: get_site_info` to verify the target before writes, then read existing content or exact IDs. Use the tool's `parameters` object for WordPress MCP Manager arguments. Common reads: `content_list` with `post_type: page` or `post`, `content_get` with `id`, and `themes_list`/`plugins_list` with an empty object. Use `list_wordpress_capabilities` to inspect supported actions.

Use `hosting_wordpress_write` only for user-authorized changes, with `confirm: true`. The server requires `whm:read whm:wordpress`, reseller ownership, the configured test account and verified HTTPS. For `content_create`, parameters include `post_type`, `title`, `content` (WordPress-compatible HTML), `status: draft`, optional `slug`, `excerpt`, `parent`, `featured_media`, `terms`, and `meta`. For `content_update`, provide the exact `id` and only requested fields. Keep new pages as drafts unless publication was requested. Theme/plugin installation uses `base64_zip`; activation uses `stylesheet` or `plugin` from a prior read. Do not invent site changes to test the connection. Honor authorization already given; do not ask again unnecessarily. Inspect current state after any uncertain write and never blindly repeat it. Native WordPress capabilities also apply. No shell or arbitrary WHM command is exposed.

