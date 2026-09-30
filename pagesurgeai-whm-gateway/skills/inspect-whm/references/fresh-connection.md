# Fresh connection recovery

Keep the existing tenant and protected API if they remain available. Verify the API Identifier exactly matches https://pagesurgeai-whm-gateway.onrender.com/mcp and grants whm:read. For renewal, enable Allow Offline Access, allow the Refresh Token grant, and verify the authorization request includes offline_access.

Use one client-registration path. If the ChatGPT form accepts a predefined OAuth Client ID and Client Secret, configure a Regular Web Application in Auth0, enable an application login connection, allow Authorization Code and Refresh Token, and enter its credentials only in ChatGPT's secure fields. Copy the exact callback shown by the ChatGPT connection into that application's callback allowlist. The stable callback is https://chatgpt.com/connector_platform_oauth_redirect only when the issuer-identification requirements are met.

If the form has no client-credential fields, do not imply a manually created Auth0 application is attached automatically. Inspect the registration path and the client actually used. Automatic registration may create a separate client; enable its login connection if necessary.

Remove or replace the ChatGPT connection that references the deleted client. Retain the new application and secret while the connection uses them. Do not change WHM settings based solely on an OAuth failure. For a WHM 401/403, verify the WHM address, token owner, token permissions/expiry and access restrictions with the provider.

Consult current official OpenAI/Auth0 documentation before giving detailed UI instructions. Do not claim the OAuth flow is tested until authentication succeeds, or WHM is tested until a read-only request succeeds.

