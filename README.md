# PageSurgeAI WHM Gateway v0.3.0

A Node.js MCP gateway for a cPanel/WHM reseller, with Auth0 authentication, four read-only tools, and one separately authorized account-creation tool.

## Tools and permissions

| Tool | OAuth scopes | WHM operation |
| --- | --- | --- |
| `hosting_list_accounts` | `whm:read` | `listaccts` |
| `hosting_get_account` | `whm:read` | `accountsummary` |
| `hosting_list_packages` | `whm:read` | `listpkgs` |
| `hosting_get_usage` | `whm:read` | `accountsummary` |
| `hosting_create_account` | `whm:read whm:create` | `createacct` |

Creation requires domain, lowercase cPanel username, an exact existing package, contact email, and `confirm: true`. The gateway validates inventory and packages before writing. An existing matching username/domain/package returns `already_exists` without changes; conflicting accounts are rejected. WHM applies server limits and username rules, including any database prefix restrictions.

Creation uses a POST form body. A random password is generated privately; neither it nor raw account-creation output is returned to the client. Shell and reseller access are disabled, existing DNS zones are not overwritten, and package quotas are inherited. Access the resulting cPanel account through WHM or reset its password there. No arbitrary WHM proxy, account modification, deletion, or WordPress installation is provided.

## Enable creation on the working connection

1. Keep the current Auth0 tenant, application, callback, audience, and PageSurgeAI WHM Web connection.
2. Add `whm:create` to the protected Auth0 API's permissions alongside `whm:read`. Ensure the authorized user's access token receives both scopes; requesting a scope does not itself grant it. If RBAC is enabled, assign the permission to the appropriate user or role.
3. Enable Create Accounts (`create-acct`) for the existing backend WHM API token and its reseller owner. Retain read permissions and existing IP restrictions. Do not grant root or unrelated permissions.
4. Update the existing Web connection's requested scopes to include both permissions, reauthorize as needed, and refresh its discovered tools. The package preserves the registered Web App binding.
5. Request a specific account, then verify it with account inventory. WordPress installation is a later extension.

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

Run `npm ci`, `npm run build`, and `npm test` before deployment. Tests mock WHM writes and do not create hosting resources. `/health` reports version `0.3.0` and process status only; it does not test OAuth or WHM. Protected-resource metadata advertises both scopes.

For deployment, see `BEGINNER-DEPLOYMENT.md`. Use `FRESH-START.md` only when recovering a deleted Auth0 client; enabling creation does not require deleting or recreating a working application.

Reference: [WHM createacct](https://api.docs.cpanel.net/specifications/whm.openapi/account-creation/accounts-createacct) and [WHM ACL chart](https://api.docs.cpanel.net/guides/guide-to-whm-plugins/guide-to-whm-plugins-acl-reference-chart).
