# PageSurgeAI WHM Gateway v0.10.0

A Node.js MCP gateway for a cPanel/WHM reseller. It supports scoped hosting inventory and account creation, WordPress installation and prompt management across verified reseller-owned accounts, bandwidth and SSL operations, plus separately authorized destructive actions.

## Tools and permissions

| Tool | OAuth scopes | WHM operation |
| --- | --- | --- |
| `hosting_list_accounts` | `whm:read` | `listaccts` |
| `hosting_get_account` | `whm:read` | `accountsummary` |
| `hosting_list_packages` | `whm:read` | `listpkgs` |
| `hosting_get_usage` | `whm:read` | `accountsummary` |
| `hosting_get_disk_quota` | `whm:read` | Verified `accountsummary` quota and usage |
| `hosting_set_disk_quota` | `whm:read whm:disk` | `editquota`, then independent `accountsummary` read-back |
| `hosting_create_account` | `whm:read whm:create` | `createacct` |

Creation requires domain, lowercase cPanel username, an exact existing package, contact email, and `confirm: true`. The gateway validates inventory and packages before writing. An existing matching username/domain/package returns `already_exists` without changes; conflicting accounts are rejected. WHM applies server limits and username rules, including any database prefix restrictions.

Creation uses a POST form body. A random password is generated privately; neither it nor raw account-creation output is returned to the client. Shell and reseller access are disabled, existing DNS zones are not overwritten, and package quotas are inherited. Access the resulting cPanel account through WHM or reset its password there. The gateway exposes only the documented, scoped operations; it does not provide an arbitrary WHM proxy.

## Disk storage adjustments from prompts

Use "Decrease thisisatestwebsite.com's disk storage to 5 GB, then verify it." The agent reads the account identity and `hosting_get_disk_quota`, converts 5 GB to 5120 MB, and calls `hosting_set_disk_quota` with the exact username/domain, `limit_mb: 5120` and `confirm: true`.

Disk writes require the new `whm:disk` scope as well as `whm:read`. WHM must permit Quota Modification (`quota`) and Account Summary. See [activation steps](UPDATE-0.10.0.md) for the existing Render/Auth0/App connection. Do not change `OAUTH_SCOPE` from its base read permission.

The backend verifies account ownership and primary domain, rechecks usage immediately before writing, and reads back the resulting quota. Positive integer MB limits and explicit `unlimited` are supported; zero is rejected. A quota below usage may prevent file writes and email delivery. Such reductions, including reductions with unknown usage, require explicit acceptance before `allow_below_usage: true` is used. Uninterpretable limits block writes. Results distinguish `updated`, `already_set` and `change_not_verified`; inspect the read tool before further action after uncertain writes. Shared packages, bandwidth and suspension are unchanged; future package changes may overwrite custom limits.

## Enable creation on the working connection

1. Keep the current Auth0 tenant, application, callback, audience, and PageSurgeAI WHM Web connection.
2. Add `whm:create` to the protected Auth0 API's permissions alongside `whm:read`. Ensure the authorized user's access token receives both scopes; requesting a scope does not itself grant it. If RBAC is enabled, assign the permission to the appropriate user or role.
3. Enable Create Accounts (`create-acct`) for the existing backend WHM API token and its reseller owner. Retain read permissions and existing IP restrictions. Do not grant root or unrelated permissions.
4. Update the existing Web connection's requested scopes to include both permissions, reauthorize as needed, and refresh its discovered tools. The package preserves the registered Web App binding.
5. Request a specific account, then verify it with account inventory. For WordPress installation and site management, use the exact primary domain so the gateway can resolve the account through WHM.

Read-only tokens continue to work for read operations. Creation fails with HTTP 403 and an insufficient-scope challenge unless both OAuth scopes are verified. All MCP HTTP requests remain protected by the existing OAuth boundary.

## Uncertain creation results

There are no automatic write retries. Account creation can exceed the configured request timeout or the client's tool deadline. A timeout, lost connection, or unrecognized response may follow a successful WHM operation. Inspect WHM inventory before retrying; do not assume the account was not created. This is an existing-account check, not a durable background-job system or a guarantee of exactly-once execution.

## Configuration

The WHM token belongs only in Render's environment. Never place credentials in repository files, plugin instructions, or chat.

| Variable | Purpose |
| --- | --- |
| `WHM_BASE_URL` | WHM HTTPS endpoint, normally ending in `:2087` |
| `WHM_USERNAME` | Restricted reseller username |
| `WHM_API_TOKEN` | Restricted WHM API token |
| `PUBLIC_BASE_URL` | Render service origin without trailing slash |
| `OAUTH_ISSUER` | Auth0 issuer origin without trailing slash |
| `OAUTH_AUDIENCE` | API audience, the full public `/mcp` URL |
| `OAUTH_SCOPE` | Base read permission, default `whm:read`; creation also requires `whm:create` |
| `WHM_TIMEOUT_MS` | WHM request timeout, default `15000` |

Run `npm ci`, `npm run build`, and `npm test` before deployment. Tests mock WHM writes and do not create hosting resources. `/health` reports the deployed version, process status and OpenSSL readiness; it does not test OAuth or WHM. Protected-resource metadata advertises all supported scopes.

For deployment, see `BEGINNER-DEPLOYMENT.md`. Use `FRESH-START.md` only when recovering a deleted Auth0 client; enabling creation does not require deleting or recreating a working application.

Reference: [WHM createacct](https://api.docs.cpanel.net/specifications/whm.openapi/account-creation/accounts-createacct) and [WHM ACL chart](https://api.docs.cpanel.net/guides/guide-to-whm-plugins/guide-to-whm-plugins-acl-reference-chart).

## WordPress setup across reseller-owned accounts

The adapter uses Softaculous API script 26 through HTTPS cPanel sessions created with the existing WHM reseller token. Each request verifies the account through WHM; no cPanel password or per-account Render variable is needed. `CPANEL_USERNAME` and `CPANEL_PASSWORD` are optional legacy settings for password-mode deployments only.

Add and grant `whm:wordpress` in the existing Auth0 API, then reauthorize the existing PageSurgeAI WHM Web connection while retaining its current permissions. After deployment, refresh the connection's tools.

WordPress tools accept an exact primary `domain` (recommended) or a `username`. Domain requests are resolved through WHM's reseller account inventory and ownership is rechecked before cPanel access. If both are supplied, they must refer to the same primary account. Arbitrary URLs, addon domains and unverified accounts are rejected. This makes one OAuth/MCP connection usable across eligible reseller accounts without storing a username in Render for each site.

`hosting_get_wordpress_status` reads Softaculous inventory without making changes. `hosting_install_wordpress` requires the exact primary domain, site title, admin email and `confirm: true`; cPanel username is optional and resolved from WHM. Existing files remain protected. HTTPS is checked before installation except for the one explicitly authorized isolated HTTP test domain. New installations request a Softaculous email to the verified WHM contact with password inclusion enabled. Inbox delivery is not verified.

No automatic retries or durable background jobs are provided. A slow operation may finish after a client timeout; inspect WordPress Manager before retrying. WordPress MCP setup is attempted after a confirmed new installation.

Reference: https://www.softaculous.com/docs/api/api/

In password mode, on a Softaculous inventory HTTP 401/403, the gateway now runs one read-only UAPI authentication probe with the same credentials. It reports only the HTTP outcome and whether UAPI succeeded, distinguishing general cPanel API rejection from a Softaculous-specific restriction. No raw response or credentials are returned. This probe is never run after an installation write.

HTTP is explicitly permitted only for the isolated `mature-yellow-fish.104-219-248-4.cpanel.site` test domain at the user's request while SSL is unavailable. Other domains retain HTTPS checks. Public checks send no credentials; WHM/Softaculous authentication remains HTTPS with TLS verification. Remove this temporary exception and update WordPress URLs when SSL is ready.

## WordPress installation email

New installations verify the account's WHM contact email, configure Softaculous `act=email` with `editemailsettings=1` and `ins_email=1`, then omit `noemail` on installation. No arbitrary recipient is accepted. A configuration failure stops installation. The `hosting_configure_wordpress_email` tool requires `whm:read whm:wordpress` and explicit confirmation; it configures future installation mail and never retrieves an old password, resets one, or resends credentials for an existing site.

For new installations the gateway requests Softaculous email delivery to the verified WHM contact with password inclusion enabled. Softaculous versions and mail settings may affect delivery; inbox receipt is not verified. For existing WordPress accounts, the MCP Manager's `users_password_reset_email` action uses WordPress's native password recovery email. It requires `confirm=true` and permission to edit the target user; it sends a reset link, never accepts or emails a password, and reports queue status rather than inbox delivery. Existing sites are never reinstalled or reset as an email test.


## WordPress MCP bridge

WordPress MCP Manager 2.0.7 remains a site-local adapter installed separately on each WordPress site. Each installation has its own endpoint and independent Bearer hash. The WHM Gateway is the shared MCP endpoint: it resolves the requested primary domain to its reseller-owned cPanel account, verifies the Softaculous installation, derives that site's token from the existing WHM secret, and routes the request over valid HTTPS. The same connection can therefore manage multiple eligible sites; users do not need a separate ChatGPT connection or Render credential per site.

`hosting_setup_wordpress_mcp`, `hosting_wordpress_read` and `hosting_wordpress_write` accept `domain` or `username`. Use the domain in prompts. Existing plugin installations and tokens are preserved. New installs configure the private per-site token during activation. The token is never returned in results. Rotating the WHM secret or manually regenerating a site's token invalidates the bridge. Verify `get_site_info` before making changes, keep new content as drafts unless publication is requested, and inspect state before retrying an uncertain write.


## Account-wide lifecycle tools (0.7.0)

The fixed CPANEL_USERNAME restriction has been removed. Each operation verifies the requested account against WHM ownership and selects that user's HTTPS cPanel session. CPANEL_USERNAME is now an optional legacy default; per-account cPanel credentials are unnecessary. Legacy password mode remains restricted to its configured user. Only accounts verified by this WHM connection are eligible; an independent WordPress connection cannot establish hosting access.

New tools: hosting_prepare_destructive_action (read-only preview), hosting_delete_wordpress, hosting_reinstall_wordpress and hosting_delete_account. Execution requires an exact target-specific confirmation and a ten-minute single-use preview. The preview shows the impact and does not create backups. WordPress removal deletes the entire installation directory, database and database user; shared or unverified paths/databases block it. Fresh reinstall supports the primary-domain root and defaults to fresh MCP setup. Account termination removes all account data but retains DNS.

Add whm:delete to the existing Auth0 API permissions and grant it to the authorized connection/user; reauthorize with whm:read whm:delete and whm:wordpress for WordPress destruction. WHM termination also requires Terminate Accounts (kill-acct) permission on the existing WHM token. These permissions are not changed automatically. Refresh the Web connection's tools after deployment.

No bulk deletion, forced permission changes or automatic retries are implemented. Ownership, account identity and installation inventory are revalidated; previews are consumed before destructive I/O and lost on restart. Report partial resets as removed_reinstall_not_confirmed. No live deletion was performed during deployment validation.

Official API references: https://www.softaculous.com/docs/api/api/ (Remove an Installed Script), https://api.docs.cpanel.net/specifications/whm.openapi/account-management/accounts-removeacct and https://api.docs.cpanel.net/guides/guide-to-whm-plugins/guide-to-whm-plugins-acl-reference-chart.


## Bandwidth and SSL ZIP tools (0.8.0)

| Tool | OAuth scopes | Action |
| --- | --- | --- |
| hosting_get_bandwidth | whm:read | Exact-account monthly bandwidth inventory via showbw |
| hosting_set_bandwidth | whm:read whm:bandwidth | One-account quota via limitbw; verified read-back |
| hosting_get_ssl_status | whm:read | Public DNS/TLS check after account/domain verification |
| hosting_validate_ssl_zip | whm:read whm:ssl | Validate attached base64 ZIP, no hosting writes |
| hosting_install_ssl_zip | whm:read whm:ssl | Revalidate and install cert/key/chain via WHM installssl POST |

Add and grant `whm:bandwidth` and `whm:ssl` to the existing Auth0 protected API, then reauthorize the existing Web connection and refresh tools. Existing read/create/WordPress scopes remain supported. No per-account Render credentials are required. These capabilities do not require whm:delete.

WHM must permit Account Summary, domain owner lookup, View Account Bandwidth Usage (`show-bandwidth`), Bandwidth Limit Modification (`limit-bandwidth`), and SSL Site Management (`ssl`) as appropriate. Gateway scope grants do not grant WHM privileges. Do not rotate the existing WHM token or change permissions automatically.

Bandwidth accepts positive integer `limit_mb` or explicit `unlimited` (zero is rejected). 1 GB in prompts means 1024 MB. Targets require an exact primary domain and verified account owner. Reductions below current usage, or unknown usage during a reduction, require explicitly authorized `allow_below_usage=true`. No package edits, usage resets or unsuspension. Package changes can subsequently overwrite the account limit. Report `change_not_verified` rather than retrying an uncertain write.

For SSL, attach an unencrypted ZIP containing PEM certificate, exactly one matching RSA >=2048-bit or supported ECDSA private key, and required intermediate CA certificates. Optional CSR is ignored. The client supplies base64 of the actual ZIP in `zip_base64`; local paths and attachment URLs are not server-accessible. Do not print or persist private material. Limit: 256 KiB compressed, 32 entries, 128 KiB per entry, 512 KiB expanded. Stored and deflated ZIP entries only; no unsafe paths, duplicate entries, links, encrypted archives/keys, PFX/P12 or untrusted/self-signed certificates. Keys alone do not suffice.

Validation checks SAN domain/key matching, dates and a complete TLS-server chain to Node's public roots. OpenSSL **3** must be installed in the Node runtime for path constraints/purpose/security-level validation; `/health` reports `checks.ssl_validator`. Only public certificates use temporary files; private keys remain in memory, with no logging or returned key/ZIP. No revocation checking is performed.

Domain ownership includes WHM-verified addon/subdomains through getdomainowner. Installation may replace the certificate on its Apache virtual host, including shared aliases. It does not purchase, issue or renew SSL, change DNS, alter WordPress URLs or create redirects. WHM confirmation is separate from public TLS verification; public address pinning excludes private networks and a CDN may serve a different certificate. No automatic retry after uncertainty.

Example prompts:
- Show example.com's monthly bandwidth limit and usage without changes.
- Set example.com's monthly bandwidth limit to 2 GB (2048 MB), keeping its package unchanged.
- Validate the attached SSL ZIP for example.com without installing.
- Install SSL for example.com from the attached ZIP and verify public HTTPS.

Automated tests use offline certificate fixtures and mocked WHM writes. They do not prove reseller ACL availability or perform live account changes.

## Automatic MCP setup (0.8.2)

New hosting_install_wordpress installations automatically attempt MCP Manager setup and verify get_site_info. Responses retain WordPress status installed with mcp_setup connected or incomplete. Existing sites remain unchanged. Retry incomplete setup using hosting_setup_wordpress_mcp after inspection, never by reinstalling WordPress. See UPDATE-0.8.2.md.

## Domain-based multi-site routing (0.9.0)

WordPress status, installation, email setup and MCP tools can resolve an exact primary domain to a verified reseller-owned account. The username may be omitted; if supplied alongside a domain, both must match. The gateway only accepts domains returned by the existing WHM account inventory and re-verifies the account before any cPanel/WordPress request. Each WordPress installation continues to use its own token. No arbitrary host or URL routing is accepted.

Example prompts:
- Inspect WordPress on `example.com` without changes.
- Install WordPress on `example.com`, titled “Example Company,” with administrator email `owner@example.com`.
- For `example.com`, read the site details, then create a draft About page.

The resolver supports the primary domain at each reseller-owned cPanel account. Addon domains and sites outside this WHM reseller are not routed by this version.

## Softaculous plugin inventory compatibility (0.9.2)

Softaculous plugin inventory can be returned under either `plugins` or `plugins_list`. The gateway now recognizes both structured response forms, checks the inventory for an existing MCP Manager before uploading, and remains fail-closed for missing or unsupported fields. Diagnostics expose only safe field names and value types, never response values or credentials. Retry MCP setup on the existing WordPress installation; do not reinstall WordPress.

## WordPress MCP Manager 2.0.7 (0.10.0)

After a new WordPress install and successful MCP connection, the gateway sends the temporary login details through an authenticated, one-time WordPress endpoint to the WHM-verified account contact. Passwords remain transient in the gateway and request body and are not stored in WordPress options. The gateway distinguishes queue acceptance, non-queueing, and unknown outcomes; inbox delivery still requires confirmation from the recipient or mail logs.
