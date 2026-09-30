# PageSurgeAI WHM Gateway: recover after deleting Auth0 applications

This gateway has two separate credentials: ChatGPT signs in through Auth0, then Render uses a WHM API token to read hosting data. Rebuilding the plugin does not recreate an Auth0 client or replace a WHM token.

## 1. Keep the Auth0 tenant and protected API

Open https://manage.auth0.com/ and select the same tenant that Render uses. Deleting applications does not require a new tenant.

Under Applications → APIs, find the API with this exact Identifier:

`https://pagesurgeai-whm-gateway.onrender.com/mcp`

If missing, create it with name PageSurgeAI WHM Gateway, that Identifier, and RS256 signing. Add the permission `whm:read`. Enable Allow Offline Access under the API's Settings and save.

## 2. Create one application

Under Applications → Applications → Create Application, choose Regular Web Application and name it PageSurgeAI ChatGPT.

In Settings → Allowed Callback URLs, add:

`https://chatgpt.com/connector_platform_oauth_redirect`

The exact production callback shown by ChatGPT's connection-management page is authoritative. If ChatGPT shows another callback, add that entire exact URL too. Save.

In the application's Connections tab, enable your database login connection, usually Username-Password-Authentication. Under Advanced Settings → Grant Types, enable Authorization Code and Refresh Token. Save. Keep any existing supported client authentication method unless ChatGPT's setup explicitly asks for another.

If you have no application login user, go to User Management → Users → Create User and create your user in the enabled database connection. Your Auth0 dashboard login and the application's user database are separate.

## 3. Replace the stale ChatGPT connection

Deleting the old Auth0 application invalidated its Client ID. Remove the failed MCP draft/connection that references it. Keep the existing PageSurgeAI plugin definition.

Create a fresh OAuth MCP connection to:

`https://pagesurgeai-whm-gateway.onrender.com/mcp`

If ChatGPT offers OAuth Client ID and OAuth Client Secret fields, copy those values from the new Auth0 application's Settings into ChatGPT's credential fields. Do not paste the secret in chat or put it in GitHub.

If no client-credential fields are available, stop this manual-client path. ChatGPT may use automatic client registration instead. Capture the connection form without secrets so the client-registration path can be configured correctly; an independently created application is not automatically attached to ChatGPT.

Verify the exact callback shown in ChatGPT is in the Auth0 application allowlist, then sign in using the application user and approve `whm:read`.

Do not delete this new application or rotate its client secret while the connection uses it.

## 4. Check Render separately

Keep these values if you retained the same tenant:

| Variable | Value |
| --- | --- |
| PUBLIC_BASE_URL | https://pagesurgeai-whm-gateway.onrender.com |
| OAUTH_ISSUER | Your existing Auth0 tenant URL, without a final slash |
| OAUTH_AUDIENCE | https://pagesurgeai-whm-gateway.onrender.com/mcp |
| OAUTH_SCOPE | whm:read |

The gateway normalizes the Auth0 issuer to include the trailing slash in protocol metadata and token validation. A newly created application has a new Client ID, but does not change the tenant issuer.

Deploy the rebuilt v0.2.2 source through the existing Render service. The /health endpoint reports process health only; OAuth and WHM are not tested by that endpoint. Check its version explicitly.

## 5. Run one read-only test

Select the gateway in ChatGPT and ask: List the available WHM hosting packages. Do not make any changes.

| Error | Where to check |
| --- | --- |
| invalid_client | ChatGPT is using deleted/stale Auth0 client credentials |
| Callback URL mismatch | Exact callback allowlist in the application actually used |
| Service not found | Auth0 API Identifier and requested audience/resource |
| No login connection | Connections tab of the application actually used |
| Authentication required / invalid_token | OAuth linking, token issuer, audience, signature or expiry |
| insufficient_scope | Access token's scope must contain whm:read |
| WHM returned HTTP 401 or 403 | WHM credentials, permissions, or hosting access restrictions |

For WHM HTTP 401/403, open Render → Environment and verify WHM_BASE_URL is the provider's actual WHM HTTPS address (commonly port 2087), WHM_USERNAME is the reseller owning the token, and WHM_API_TOKEN is that user's valid token. Check token expiry, read permissions for the requested endpoint and any firewall/IP restrictions with the host. Never broaden the token to unrestricted administrator access just to bypass an error.

For token renewal, Allow Offline Access and the Refresh Token grant alone do not guarantee a refresh token. The authorization request must also include `offline_access`. If renewal still fails, inspect the requested scopes and Auth0 logs before changing token lifetimes.

## References

- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/troubleshooting
- https://auth0.com/docs/get-started/applications/application-settings
- https://auth0.com/docs/secure/tokens/refresh-tokens/get-refresh-tokens

No credential or hosting account data is included in this guide.
