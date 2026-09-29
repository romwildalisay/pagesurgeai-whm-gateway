# PageSurgeAI WHM Gateway v0.2.1

A standalone, read-only MCP gateway for a cPanel/WHM reseller account, with OAuth 2.1-compatible discovery for ChatGPT.

## Included tools

- `hosting_list_accounts`
- `hosting_get_account`
- `hosting_list_packages`
- `hosting_get_usage`

No tool can create, change, suspend, restore, or delete hosting resources. There is no arbitrary WHM proxy, shell access, or WP-CLI execution.

## What v0.2.1 fixes

v0.1 required a custom bearer API key before MCP initialization. ChatGPT could not discover the tools or start a supported account-linking flow. v0.2.1:

- allows MCP initialization and tool discovery without exposing WHM data;
- publishes protected-resource metadata;
- advertises the `whm:read` OAuth scope;
- returns a standard MCP OAuth challenge when an unauthenticated tool is called;
- verifies issuer, audience, signature, expiration, and scope on every tool call.
- publishes Auth0's exact issuer identifier, including its required trailing slash.

## Security boundary

ChatGPT authenticates through an OAuth 2.1 identity provider. The gateway validates the access token and separately authenticates to WHM using `WHM_API_TOKEN`. The WHM token remains only in Render.

Use an established identity provider such as Auth0. Do not implement your own password or token issuer for production.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `WHM_BASE_URL` | WHM HTTPS endpoint, normally ending in `:2087` |
| `WHM_USERNAME` | Restricted reseller username |
| `WHM_API_TOKEN` | Restricted WHM API token |
| `PUBLIC_BASE_URL` | Render service origin without a trailing slash |
| `OAUTH_ISSUER` | OAuth issuer origin without a trailing slash |
| `OAUTH_AUDIENCE` | API audience; use the full public `/mcp` URL |
| `OAUTH_SCOPE` | Required scope; default `whm:read` |
| `WHM_TIMEOUT_MS` | Optional WHM timeout; default `15000` |

## Local verification

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and fill in non-placeholder values.
3. Run `npm ci`.
4. Run `npm run build`.
5. Run `npm test`.
6. Run `npm start`.
7. Confirm `/health` reports version `0.2.1` and `auth: oauth2`.
8. Confirm `/.well-known/oauth-protected-resource` returns the configured issuer and `whm:read` scope.

## Deployment and ChatGPT

Follow `BEGINNER-DEPLOYMENT.md`. After Render is live, remove the old v0.1 MCP draft from ChatGPT and create a new developer-mode connection to the same `/mcp` URL. ChatGPT must rediscover the OAuth metadata and tools.

## Release gate

Do not add write-capable WHM functions until the read-only gateway has completed repeated isolated testing, token revocation testing, and audit-log review.
