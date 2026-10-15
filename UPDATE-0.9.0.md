# Update 0.9.0: domain-based WordPress routing

The shared WHM Gateway can now select WordPress sites by exact primary domain, so one authenticated MCP connection can manage multiple eligible reseller-owned accounts.

## What changed

- WordPress status, installation email configuration, MCP setup, reads, and writes accept an exact primary domain. Supplying a cPanel username remains supported; supplying both requires an exact match.
- WordPress installation can resolve the cPanel username from the domain through WHM.
- The gateway verifies the domain-to-account mapping, rechecks reseller ownership, checks the Softaculous installation, then uses that site's independent HMAC-derived Bearer token.
- The WordPress MCP Manager remains a per-site adapter. The same 2.0.5 code is installed on each WordPress site; no shared token is introduced.
- No new Auth0 scopes or Render environment variables are required. Keep the existing `whm:read` and `whm:wordpress` grants.

## Limits

- Domain routing supports the account's exact primary domain and its primary-domain WordPress installation. Addon domains, arbitrary URLs, external hosts, and multiple WordPress installations under one account are not routed by this release.
- WordPress requests still require valid HTTPS.
- Existing plugin installations and tokens are preserved. A pre-existing plugin without the gateway-managed token reports a setup issue rather than replacing its credentials.

## Example prompts

> For `example.com`, show the WordPress version, active theme, and plugins. Do not make changes.

> Install WordPress on `example.com` with site title “Example Company” and administrator email `owner@example.com`.

> For `example.com`, create a draft About page and show me the result.

No hosting settings or WordPress sites are changed by this software update itself.
