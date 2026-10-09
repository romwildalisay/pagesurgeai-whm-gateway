# Connect WordPress MCP Manager to ChatGPT

1. Install and activate the plugin in WordPress.
2. Open **Settings > WordPress MCP**.
3. Select **Generate bearer token**. Copy the token immediately.
4. Copy the MCP endpoint displayed above the token. For the PageSurgeAI staging site it should be:
   `https://holisticwebdevelopment2.com/pagesurgeai/wp-json/wpmcp/v1/mcp`
5. In ChatGPT, enable Developer mode under **Settings > Apps > Advanced Settings**.
6. Choose **Create app**, enter a name such as `Staging PageSurgeAI`, and paste the MCP endpoint.
7. Select bearer-token authentication and paste the token from WordPress.
8. Select **Scan tools**, review the actions, and create the app.
9. In a new chat, select the app and ask: `Get the WordPress site details. Do not make changes.`

If scanning fails, verify that WordPress permalinks are enabled, HTTPS works without a certificate warning, security/CDN rules allow POST requests to `/wp-json/wpmcp/v1/mcp`, and the `Authorization` header reaches PHP.

Regenerating the token under **Settings > WordPress MCP** immediately invalidates the previous token.
