# Deploy v0.8.2

1. Extract the ZIP and upload its contents over the existing GitHub repository files. Commit changes.
2. In Render select Deploy latest commit and wait for Live.
3. Confirm /health reports 0.8.2. Refresh the existing ChatGPT connection tools.

No new environment variables or OAuth permissions are needed. New WordPress installations through hosting_install_wordpress now automatically attempt MCP Manager 2.0.5 installation, activation, private token configuration and get_site_info verification. Existing sites are returned unchanged. Use hosting_setup_wordpress_mcp separately for those sites. Fresh reinstall retains its existing setup_mcp default of true and explicit opt-out.

WordPress success is retained if MCP setup is incomplete. Inspect plugin inventory and retry hosting_setup_wordpress_mcp; do not reinstall WordPress. Valid public HTTPS is required for the authenticated MCP connection. Existing tokens are never overwritten. Credential-email automation from 0.8.1 remains included.

Build and automated tests use mocked hosting operations; live installation and email delivery require verification on the next authorized new site.
