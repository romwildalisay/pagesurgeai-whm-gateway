# Update 0.9.1: safe Softaculous inventory diagnostics

The fresh WordPress installation succeeded, but the gateway could not interpret the Softaculous installed-plugin list and correctly stopped before uploading WordPress MCP Manager.

This diagnostic release keeps that fail-closed behavior and adds a safe description of the response shape: approved top-level field names and value types only. It does not return response values or secrets. The diagnostic can identify whether Softaculous returned an API error, omitted the expected `plugins` field, or used an unsupported type.

No WordPress site changes are made by this release. After deployment, run `hosting_setup_wordpress_mcp` again on the existing installation to receive the sanitized diagnostic. Do not reinstall WordPress or upload the plugin manually while the gateway-managed token setup is unresolved.
