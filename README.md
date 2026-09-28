# PageSurgeAI WHM Gateway v0.1

A standalone, read-only MCP gateway for a cPanel/WHM reseller account.

## Included tools

- `hosting_list_accounts`
- `hosting_get_account`
- `hosting_list_packages`
- `hosting_get_usage`

No tool can create, change, suspend, restore, or delete hosting resources. There is no arbitrary WHM proxy and no shell or WP-CLI execution.

## Security boundary

ChatGPT authenticates to this gateway using `GATEWAY_API_KEY`. The gateway separately authenticates to WHM using `WHM_API_TOKEN`. Never use the WHM token as the gateway key, put either secret in source control, or install this service inside a managed WordPress site.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Fill in the real values locally. Do not send them in chat.
4. Run `npm install`.
5. Run `npm run build`.
6. Run `npm start`.
7. Confirm `http://localhost:3000/health` reports read-only mode.
8. Test `http://localhost:3000/mcp` with MCP Inspector and a Bearer token.

## Deployment

Deploy the included Dockerfile to a standalone managed container host. Add all `.env.example` keys through the host's secret manager. The public MCP URL must use a valid HTTPS certificate and normally ends in `/mcp`.

Docker is optional. For a dashboard-only deployment with no local development tools, follow `BEGINNER-DEPLOYMENT.md`. The included `render.yaml` supplies the build, start, and health-check configuration.

Do not deploy until the WHM API token has only the reseller privileges required by these four read operations. Restrict the token by source IP when the selected host provides a stable outbound IP.

## ChatGPT connection

After deployment:

1. Open ChatGPT Plugins and enable developer mode.
2. Add the stable HTTPS endpoint, such as `https://gateway.example.com/mcp`.
3. Select API-key/Bearer authentication.
4. Enter `GATEWAY_API_KEY`, not the WHM token.
5. Scan tools and confirm exactly four tools appear.
6. Test read-only prompts before adding any future write tools.

## Required tests

- Valid key can initialize and list four tools.
- Missing or invalid key returns HTTP 401.
- Invalid cPanel usernames are rejected before WHM is called.
- WHM timeouts return a redacted error.
- Tool results never contain `WHM_API_TOKEN` or `GATEWAY_API_KEY`.
- No write-capable WHM function is present in the source or advertised tool list.

## Next release gate

Do not add account creation until v0.1 completes repeated read-only tests against the isolated Namecheap laboratory account and its audit logs contain no secrets.
