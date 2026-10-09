# PageSurgeAI WHM Gateway v0.5.0

A Node.js MCP gateway for a cPanel/WHM reseller, with Auth0 authentication, five read-only tools and separately authorized account-creation and WordPress-installation tools.

## Tools and permissions

| Tool | OAuth scopes | WHM operation |
| --- | --- | --- |
| `hosting_list_accounts` | `whm:read` | `listaccts` |
| `hosting_get_account` | `whm:read` | `accountsummary` |
| `hosting_list_packages` | `whm:read` | `listpkgs` |
| `hosting_get_usage` | `whm:read` | `accountsummary` |
| `hosting_create_account` | `whm:read whm:create` | `createacct` |

Creation requires domain, lowercase cPanel username, an exact existing package, contact email, and `confirm: true`. The gateway validates inventory and packages before writing. An existing matching username/domain/package returns `already_exists` without changes; conflicting accounts are rejected. WHM applies server limits and username rules, including any database prefix restrictions.

Creation uses a POST form body. A random password is generated privately; neither it nor raw account-creation output is returned to the client. Shell and reseller access are disabled, existing DNS zones are not overwritten, and package quotas are inherited. Access the resulting cPanel account through WHM or reset its password there. No arbitrary WHM proxy, account modification, deletion, or general WordPress management is provided.

## Enable creation on the working connection

1. Keep the current Auth0 tenant, application, callback, audience, and PageSurgeAI WHM Web connection.
2. Add `whm:create` to the protected Auth0 API's permissions alongside `whm:read`. Ensure the authorized user's access token receives both scopes; requesting a scope does not itself grant it. If RBAC is enabled, assign the permission to the appropriate user or role.
3. Enable Create Accounts (`create-acct`) for the existing backend WHM API token and its reseller owner. Retain read permissions and existing IP restrictions. Do not grant root or unrelated permissions.
4. Update the existing Web connection's requested scopes to include both permissions, reauthorize as needed, and refresh its discovered tools. The package preserves the registered Web App binding.
5. Request a specific account, then verify it with account inventory. For WordPress installation, follow the separate test-account setup below.

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

Run `npm ci`, `npm run build`, and `npm test` before deployment. Tests mock WHM writes and do not create hosting resources. `/health` reports version `0.5.0` and process status only; it does not test OAuth or WHM. Protected-resource metadata advertises all three scopes.

For deployment, see `BEGINNER-DEPLOYMENT.md`. Use `FRESH-START.md` only when recovering a deleted Auth0 client; enabling creation does not require deleting or recreating a working application.

Reference: [WHM createacct](https://api.docs.cpanel.net/specifications/whm.openapi/account-creation/accounts-createacct) and [WHM ACL chart](https://api.docs.cpanel.net/guides/guide-to-whm-plugins/guide-to-whm-plugins-acl-reference-chart).

## WordPress setup with Softaculous (test account only)

The adapter uses Softaculous API script 26 at the Jupiter endpoint on the WHM hostname's cPanel HTTPS port 2083. By default, the existing WHM reseller token creates a temporary cPanel session for the configured owned test account via `create_user_session`. The session login cookie is kept only in memory and restricted to the HTTPS cPanel origin. Root access is never requested. If the existing token lacks permission, the gateway fails without changing privileges.

Set these private Render environment variables:

| Variable | Test value |
| --- | --- |
| `CPANEL_USERNAME` | `authoritysurgeai` |
| `CPANEL_AUTH_MODE` | Optional; defaults to `whm-session`. Set `password` only to use the original password adapter |
| `CPANEL_PASSWORD` | Optional; required only in password mode; enter only in Render |

The optional variables do not affect existing WHM tools when unset. If you do not know the password, reset only this test account's password through WHM and then enter it securely in Render. Keep WHM and Auth0 credentials unchanged.

Add `whm:wordpress` to the Auth0 API permissions. With RBAC enabled, grant that permission to the appropriate user/role. Refresh and reauthorize the existing PageSurgeAI WHM Web connection, preserving its client credentials and callback.

`hosting_get_wordpress_status` (read scope) verifies the configured account and reads Softaculous inventory. Run it first to validate cPanel authentication and the actual inventory format. Nonempty unrecognized inventory blocks installation; real server behavior still needs testing.

`hosting_install_wordpress` requires `whm:read whm:wordpress`, username, primary domain, site title, admin email, and `confirm: true`. For this test use `authoritysurgeai` and `mature-yellow-fish.104-219-248-4.cpanel.site`. It verifies ownership and HTTPS, retains Softaculous existing-file protection, installs at the domain root, and generates admin credentials privately. Use WordPress Manager's Login button afterward.

No automatic retries or durable background jobs are provided. A slow installation may finish after a client timeout; inspect WordPress Manager before retrying. WordPress MCP plugin installation is a separate later extension.

Reference: https://www.softaculous.com/docs/api/api/

In password mode, on a Softaculous inventory HTTP 401/403, the gateway now runs one read-only UAPI authentication probe with the same credentials. It reports only the HTTP outcome and whether UAPI succeeded, distinguishing general cPanel API rejection from a Softaculous-specific restriction. No raw response or credentials are returned. This probe is never run after an installation write.

HTTP is explicitly permitted only for the isolated `mature-yellow-fish.104-219-248-4.cpanel.site` test domain at the user's request while SSL is unavailable. Other domains retain HTTPS checks. Public checks send no credentials; WHM/Softaculous authentication remains HTTPS with TLS verification. Remove this temporary exception and update WordPress URLs when SSL is ready.

## WordPress installation email

New installations verify the account's WHM contact email, configure Softaculous `act=email` with `editemailsettings=1` and `ins_email=1`, then omit `noemail` on installation. No arbitrary recipient is accepted. A configuration failure stops installation. The `hosting_configure_wordpress_email` tool requires `whm:read whm:wordpress` and explicit confirmation; it configures future installation mail and never retrieves an old password, resets one, or resends credentials for an existing site.

Softaculous's separate Email settings > Email password in plain text option must be enabled to include the password; this undocumented API checkbox is not silently guessed or toggled by the adapter. Account email settings may also affect Softaculous's other notifications. Report only an email request, never confirmed inbox delivery. Verify receipt on a future authorized fresh installation without reinstalling an existing site just to test mail.


## WordPress MCP bridge (0.6.0)

`hosting_setup_wordpress_mcp` installs the user-owned WordPress MCP Manager 2.0.5 using a multipart Softaculous upload over the existing WHM-created HTTPS cPanel session. The account remains restricted to `CPANEL_USERNAME`, with reseller ownership and a single primary-domain installation verified. Existing plugins and tokens are preserved; unknown inventory blocks installation. The shipped activation bootstrap configures only the derived bearer hash for the verified `pagesurgeadmin` account and requires HTTPS on the MCP route.

`hosting_wordpress_read` and `hosting_wordpress_write` use the existing OAuth Web connection, then send a private account/installation-specific Bearer token to WordPress over validated HTTPS. The token is derived with domain-separated HMAC-SHA256 from the existing WHM secret, surviving Render restarts without one environment variable per account. Rotating the WHM secret or manually regenerating the WordPress token invalidates the bridge; reconnecting Auth0 will not repair that mismatch. No Bearer token is exposed in tool results. Both setup and writes require `whm:wordpress`, plus explicit confirmation; reads require `whm:read`.

The isolated HTTP test site can receive the plugin through HTTPS cPanel, but cannot authenticate publicly until its SSL certificate works. `installed_https_required` does not mean connected. Refresh the existing Web connection's discovered tools after deployment. Verify `get_site_info` and current content before user-authorized changes. Never automatically retry uncertain writes. New content should remain draft unless publishing was requested.
