import type { Config } from "./config.js";
import { installWordpress } from "./wordpress-setup.js";
import { setupWordpressMcp } from "./wordpress-mcp.js";

// Run setup only after a newly confirmed installation. Never turn a partial
// MCP failure into an installation failure that might prompt a reinstall.
export async function installWordpressWithMcp(config: Config, input: Parameters<typeof installWordpress>[1]) {
  const wordpress = await installWordpress(config, input);
  if (wordpress.status !== "installed") return wordpress;
  try {
    const mcp = await setupWordpressMcp(config, { username: input.username, domain: input.domain }, true);
    return { ...wordpress, mcp_plugin_installed: mcp.installed === true || mcp.status === "connected",
      mcp_setup: mcp.status === "connected" ? "connected" : "incomplete", mcp };
  } catch {
    return { ...wordpress, mcp_plugin_installed: "not_verified", mcp_setup: "incomplete",
      mcp: { status: "not_confirmed", next_step: "WordPress is installed. Inspect plugin inventory, then use hosting_setup_wordpress_mcp to retry setup; do not reinstall WordPress. No connection credentials are exposed." } };
  }
}
