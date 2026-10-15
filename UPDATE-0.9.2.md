# Update 0.9.2: Softaculous plugin inventory compatibility

The deployed diagnostic identified the installed-plugin inventory as `plugins_list`. The gateway now accepts the verified `plugins_list` field as well as `plugins`, checks it for an existing WordPress MCP Manager before upload, and keeps unsupported or missing inventory responses fail-closed.

Tests cover both an existing MCP plugin and an inventory without MCP Manager. Diagnostics remain value-free; no plugin is uploaded unless a structured inventory is present and confirms that MCP Manager is absent.
