# Beginner deployment: PageSurgeAI WHM Gateway v0.2.2

If you deleted Auth0 applications, follow [FRESH-START.md](FRESH-START.md) before reconnecting.

This update keeps Render and adds standards-based OAuth. You will use Auth0 for sign-in and access tokens rather than maintaining an authentication server yourself.

## Part 1: Update the GitHub repository

1. Download and unzip `pagesurgeai-whm-gateway-v0.2.2.zip`.
2. Open your existing GitHub repository.
3. Upload the v0.2.2 files over the existing files.
4. Do not upload `.env`, WHM tokens, passwords, or exported Auth0 secrets.
5. Commit the update to the branch Render deploys.

## Part 2: Create the protected API in Auth0

1. Sign in to Auth0 and create or select a tenant.
2. Open **Applications → APIs → Create API**.
3. Name it **PageSurgeAI WHM Gateway**.
4. Use this identifier:

   `https://pagesurgeai-whm-gateway.onrender.com/mcp`

5. Use **RS256** signing.
6. Add the permission `whm:read`.
7. Enable the Auth0 options required for MCP/OAuth clients, including PKCE and Client ID Metadata Documents or dynamic client registration, using Auth0's current MCP authorization guidance.
8. Allow only your intended PageSurgeAI user or organization to authorize this API.

Record the Auth0 issuer domain, for example:

`https://YOUR-TENANT.REGION.auth0.com`

Do not include a trailing slash in Render's `OAUTH_ISSUER` value.

## Part 3: Update Render environment variables

Open the Render service, then **Environment**. Preserve the existing WHM values and set:

| Key | Value |
| --- | --- |
| `PUBLIC_BASE_URL` | `https://pagesurgeai-whm-gateway.onrender.com` |
| `OAUTH_ISSUER` | Your Auth0 issuer without a trailing slash |
| `OAUTH_AUDIENCE` | `https://pagesurgeai-whm-gateway.onrender.com/mcp` |
| `OAUTH_SCOPE` | `whm:read` |

Remove the obsolete `GATEWAY_API_KEY` after v0.2.2 is successfully deployed. It is no longer read by the application.

Select **Save, rebuild, and deploy**.

## Part 4: Verify the deployment

Open:

`https://pagesurgeai-whm-gateway.onrender.com/health`

Expected fields:

`{"status":"ok","name":"pagesurgeai-whm-gateway","version":"0.2.2","mode":"read-only","auth":"oauth2"}`

Then open:

`https://pagesurgeai-whm-gateway.onrender.com/.well-known/oauth-protected-resource`

Confirm that:

- `resource` is the public `/mcp` URL;
- `authorization_servers` contains your Auth0 issuer;
- `scopes_supported` contains `whm:read`.

## Part 5: Reconnect ChatGPT

1. In ChatGPT, enable **Settings → Security and login → Developer mode**.
2. Open **Plugins → Drafts**.
3. Remove the old PageSurgeAI WHM Gateway v0.1 draft connection.
4. Select **+** and enter:

   `https://pagesurgeai-whm-gateway.onrender.com/mcp`

5. Choose OAuth when prompted.
6. Complete the Auth0 sign-in and consent screen.
7. Open the new draft and select **Refresh**.
8. Confirm exactly four tools are present.
9. In a new chat, enable Developer mode and select the gateway.
10. Test: **List the available WHM hosting packages. Do not make any changes.**

## Troubleshooting

| Symptom | Likely cause | Correction |
| --- | --- | --- |
| No Connect prompt | Protected-resource metadata or tool security metadata is unavailable | Check the well-known URL and refresh the ChatGPT draft |
| `invalid_token` | Issuer, signature, audience, or expiry does not match | Compare Auth0 API identifier with `OAUTH_AUDIENCE` |
| `insufficient_scope` | The token lacks `whm:read` | Grant the API permission and reconnect |
| Tool discovery works but calls fail | OAuth linking is incomplete | Disconnect, reconnect, and approve `whm:read` |
| First request times out | Free Render service was sleeping | Retry after the health page responds or use an always-on plan |
| WHM call fails | WHM hostname, username, token, permissions, or port is incorrect | Verify the restricted WHM credentials in Render |

Never make the MCP tools anonymous. Although they are read-only, they expose private hosting account information.
