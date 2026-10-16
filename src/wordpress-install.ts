import type { Config } from "./config.js";
import { installWordpress, WORDPRESS_CREDENTIAL_HANDOFF } from "./wordpress-setup.js";
import { sendWordPressInstallCredentials, setupWordpressMcp } from "./wordpress-mcp.js";

// Run setup only after a newly confirmed installation. Never turn a partial
// MCP failure into an installation failure that might prompt a reinstall.
export async function installWordpressWithMcp(config: Config, input: Parameters<typeof installWordpress>[1]) {
  const wordpress = await installWordpress(config, input);
  const credentials = (wordpress as any)[WORDPRESS_CREDENTIAL_HANDOFF] as { login: string; password: string } | undefined;
  if (wordpress.status !== "installed" || !("email" in wordpress)) return wordpress;
  try {
    const mcp = await setupWordpressMcp(config, { username: input.username, domain: input.domain }, true);
    const email = mcp.status === "connected" && credentials
      ? await sendWordPressInstallCredentials(config, { username: input.username, domain: input.domain }, credentials).catch(() => ({ status: "not_queued" as const }))
      : { status: "not_attempted" as const };
    return { ...wordpress, mcp_plugin_installed: mcp.installed === true || mcp.status === "connected",
      mcp_setup: mcp.status === "connected" ? "connected" : "incomplete", mcp,
      credential_email: { ...email, recipient: wordpress.email.recipient, inbox_delivery: "not_verified" } };
  } catch {
    return { ...wordpress, mcp_plugin_installed: "not_verified", mcp_setup: "incomplete",
      credential_email: { status: "not_attempted" as const, recipient: wordpress.email.recipient, inbox_delivery: "not_verified" },
      mcp: { status: "not_confirmed", next_step: "WordPress is installed. Inspect plugin inventory, then use hosting_setup_wordpress_mcp to retry setup; do not reinstall WordPress. No connection credentials are exposed." } };
  }
}
