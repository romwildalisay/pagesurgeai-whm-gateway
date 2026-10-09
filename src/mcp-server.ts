import { createHostingAccount, creationInput, CREATE_SCOPE } from "./account-creation.js";
import { configureWordpressEmail, installWordpress, wordpressStatus, wordpressInput, WORDPRESS_SCOPE } from "./wordpress-setup.js";
import { setupWordpressMcp, wordpressRead, wordpressWrite, wordpressReads, wordpressWrites, wordpressAccountInput, wordpressParameters } from "./wordpress-mcp.js";
import { DELETE_SCOPE, prepareDestructiveAction, destructivePlanInput, destructiveExecuteInput, deleteHostingAccount, deleteWordpress, reinstallWordpress } from "./destructive-actions.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { extractAccounts, extractPackages, validateCpanelUser, WhmClient } from "./whm-client.js";

const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

function result(data: unknown, summary: string) {
  return { structuredContent: data as Record<string, unknown>, content: [{ type: "text" as const, text: summary }] };
}

function accountView(a: any) {
  return {
    user: String(a.user ?? ""),
    domain: String(a.domain ?? ""),
    owner: String(a.owner ?? ""),
    plan: String(a.plan ?? a.package ?? ""),
    suspended: Boolean(Number(a.suspended ?? 0)),
    suspend_reason: String(a.suspendreason ?? ""),
    disk_used_mb: a.diskused ?? null,
    disk_limit_mb: a.disklimit ?? null,
    bandwidth_used: a.bwused ?? null,
    bandwidth_limit: a.bwlimit ?? null,
    ip: String(a.ip ?? ""),
    contact_email: String(a.email ?? "")
  };
}

export function createMcpServer(config: Config, access: { canCreate: boolean; canInstall?: boolean; canDelete?: boolean } = { canCreate: false }): McpServer {
  const whm = new WhmClient(config);
  const securitySchemes = [{ type: "oauth2" as const, scopes: [config.OAUTH_SCOPE] }];
  const server = new McpServer(
    { name: "pagesurgeai-whm-gateway", version: "0.7.0" },
    { instructions: "Inspect hosting, create accounts with creation permission, and manage WordPress only on the verified reseller-owned accounts. Install the user's WordPress MCP Manager through hosting_setup_wordpress_mcp. Bearer authentication stays private in this gateway and requires valid WordPress HTTPS. Read site identity and current content before writes. Set confirm=true only for user-authorized actions. Do not retry uncertain writes. Destructive hosting operations require a fresh preview, exact target approval and whm:delete. No shell access is implemented." }
  );

  server.registerTool("hosting_list_accounts", {
    title: "List hosting accounts",
    description: "List cPanel accounts visible to the configured WHM reseller. Use for inventory and account lookup. This tool never changes hosting state.",
    inputSchema: { search: z.string().trim().max(253).optional() },
    annotations,
    _meta: { securitySchemes }
  }, async ({ search }) => {
    const body = await whm.call("listaccts", search ? { search, searchtype: "domain" } : {});
    const accounts = extractAccounts(body).map(accountView);
    return result({ accounts, count: accounts.length }, `Found ${accounts.length} hosting account${accounts.length === 1 ? "" : "s"}.`);
  });

  server.registerTool("hosting_get_account", {
    title: "Get hosting account",
    description: "Return details for one cPanel username. Use after listing accounts when an exact account needs inspection. This tool never changes hosting state.",
    inputSchema: { username: z.string().min(1).max(16) },
    annotations,
    _meta: { securitySchemes }
  }, async ({ username }) => {
    const user = validateCpanelUser(username);
    const body = await whm.call("accountsummary", { user });
    const account = extractAccounts(body).map(accountView)[0] ?? null;
    return result({ account }, account ? `Retrieved hosting account ${user}.` : `No hosting account was found for ${user}.`);
  });

  server.registerTool("hosting_list_packages", {
    title: "List hosting packages",
    description: "List hosting packages available to the configured WHM reseller. This tool never changes hosting state.",
    inputSchema: {},
    annotations,
    _meta: { securitySchemes }
  }, async () => {
    const body = await whm.call("listpkgs");
    const packages = extractPackages(body);
    return result({ packages, count: packages.length }, `Found ${packages.length} hosting package${packages.length === 1 ? "" : "s"}.`);
  });

  server.registerTool("hosting_get_usage", {
    title: "Get hosting usage",
    description: "Return disk and bandwidth usage for one cPanel username. This tool never changes hosting state.",
    inputSchema: { username: z.string().min(1).max(16) },
    annotations,
    _meta: { securitySchemes }
  }, async ({ username }) => {
    const user = validateCpanelUser(username);
    const body = await whm.call("accountsummary", { user });
    const a = extractAccounts(body)[0];
    const usage = a ? {
      username: user,
      disk_used_mb: a.diskused ?? null,
      disk_limit_mb: a.disklimit ?? null,
      bandwidth_used: a.bwused ?? null,
      bandwidth_limit: a.bwlimit ?? null
    } : null;
    return result({ usage }, usage ? `Retrieved usage for ${user}.` : `No hosting account was found for ${user}.`);
  });

  server.registerTool("hosting_create_account", {
    title: "Create hosting account",
    description: "Create one cPanel account after the user specifies domain, username, package, and contact email. Requires whm:read and whm:create plus WHM Create Accounts permission. Set confirm=true only for an explicit creation request. Checks existing accounts first; never overwrites them. Password is generated on the server and never returned; use WHM to access the new cPanel account. If creation times out, inspect inventory before retrying. Does not install WordPress.",
    inputSchema: creationInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, CREATE_SCOPE] }] }
  }, async (input) => {
    if (!access.canCreate) throw new Error("Account creation requires the whm:create permission. Reauthorize the existing Web connection with that scope.");
    const created = await createHostingAccount(whm, input);
    return result(created, created.status === "already_exists" ? `Matching hosting account ${input.username} already exists; no changes made.` : `Created hosting account ${input.username} for ${input.domain}. WordPress is not installed yet. Access cPanel through WHM; no password is exposed in chat.`);
  });

  server.registerTool("hosting_get_wordpress_status", {
    title: "Inspect WordPress installation",
    description: "Read Softaculous inventory for the configured cPanel test account's primary domain. Selects the requested account after WHM ownership verification and uses the existing reseller token. Use before installation and after uncertain results; never returns credentials. Unmanaged installations may not appear.",
    inputSchema: { username: z.string().regex(/^[a-z][a-z0-9]{0,15}$/) }, annotations, _meta: { securitySchemes }
  }, async ({ username }) => {
    const status = await wordpressStatus(config, username);
    return result(status, `Found ${status.count} WordPress installation(s) in Softaculous for ${status.domain}.`);
  });

  server.registerTool("hosting_configure_wordpress_email", {
    title: "Configure WordPress installation emails",
    description: "Enable Softaculous installation emails to the verified WHM contact email of the selected verified account. Requires whm:read and whm:wordpress. Use confirm=true only when requested. Does not send existing credentials, reset passwords, reinstall WordPress, or accept an arbitrary recipient. Password inclusion requires Softaculous's Email password in plain text setting. Inbox delivery is not verified.",
    inputSchema: { username: z.string().regex(/^[a-z][a-z0-9]{0,15}$/), confirm: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE] }] }
  }, async ({ username }) => {
    if (!access.canInstall) throw new Error("WordPress email configuration requires the whm:wordpress permission.");
    const configured = await configureWordpressEmail(config, username);
    return result(configured, `Configured Softaculous installation emails to ${configured.recipient}. Enable Email password in plain text in Softaculous to include passwords. No existing credentials were sent.`);
  });

  server.registerTool("hosting_install_wordpress", {
    title: "Install WordPress on selected account",
    description: "Install WordPress at the root of the selected verified account's primary domain through Softaculous. HTTPS is required except for the explicitly authorized mature-yellow-fish.104-219-248-4.cpanel.site HTTP test. Requires whm:read and whm:wordpress plus WHM reseller session access to the selected verified account. Set confirm=true only when the user requests installation on this domain. Never overwrites existing files; existing installations are returned without changes. New installations request an email to the verified hosting contact address; password inclusion depends on Softaculous email settings. Admin password is generated privately; use Softaculous Login. On uncertain results inspect WordPress Manager before retrying. Does not install the WordPress MCP plugin.",
    inputSchema: wordpressInput, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE] }] }
  }, async (input) => {
    if (!access.canInstall) throw new Error("WordPress installation requires whm:wordpress. Reauthorize the existing Web connection with that permission.");
    const installed = await installWordpress(config, input);
    return result(installed, installed.status === "already_exists" ? "WordPress is already listed on this domain; no changes made." : "Softaculous confirmed WordPress installation. Use WordPress Manager's Login button. The WordPress MCP plugin is not installed yet.");
  });
  server.registerTool("hosting_setup_wordpress_mcp", {
    title: "Install and connect WordPress MCP Manager",
    description: "Install the user's pinned WordPress MCP Manager 2.0.5 through HTTPS Softaculous on the selected verified account. Configure a private Bearer token automatically on first activation, using the existing pagesurgeadmin user. No admin password change or per-account Render secret. Requires whm:read and whm:wordpress and explicit confirm=true. Never overwrites an existing plugin/token. Public MCP authentication requires valid HTTPS; HTTP test-site installation may return installed_https_required. Inspect WordPress Manager after uncertain writes. Then use hosting_wordpress_read and hosting_wordpress_write through this existing connection.",
    inputSchema: { ...wordpressAccountInput, confirm: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE] }] }
  }, async ({ username, confirm }) => {
    if (!access.canInstall) throw new Error("WordPress MCP setup requires whm:wordpress.");
    const configured = await setupWordpressMcp(config, username, confirm);
    return result(configured, `WordPress MCP setup: ${configured.status}. No Bearer token is returned in chat.`);
  });
  server.registerTool("hosting_wordpress_read", {
    title: "Read connected WordPress",
    description: "Read site identity, capabilities, content, media, settings, menus, themes, plugins or users through the private WordPress MCP bridge. Verify get_site_info before changes. Restricted to the selected verified account's verified WordPress installation. Valid HTTPS and gateway-configured token required. Parameters follow WordPress MCP Manager's tool schema. Does not accept arbitrary URLs or expose credentials.",
    inputSchema: { ...wordpressAccountInput, tool: z.enum(wordpressReads), parameters: wordpressParameters },
    annotations, _meta: { securitySchemes }
  }, async ({ username, tool, parameters }) => result(await wordpressRead(config, username, tool, parameters), `Read WordPress using ${tool}.`));
  server.registerTool("hosting_wordpress_write", {
    title: "Change connected WordPress",
    description: "Run a user-authorized WordPress MCP Manager write on the selected verified account using a private Bearer token and valid HTTPS. Requires whm:read, whm:wordpress and confirm=true. Read exact IDs/current content first. Use draft status for new pages unless publishing was requested. Parameters follow WordPress MCP Manager's tool schema. Installation/activation/deletion/settings/user changes must be explicitly requested. Never retry uncertain writes automatically; inspect state instead. Does not accept arbitrary URLs or WHM commands.",
    inputSchema: { ...wordpressAccountInput, tool: z.enum(wordpressWrites), parameters: wordpressParameters, confirm: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE] }] }
  }, async ({ username, tool, parameters, confirm }) => {
    if (!access.canInstall) throw new Error("WordPress changes require whm:wordpress.");
    return result(await wordpressWrite(config, username, tool, parameters, confirm), `WordPress confirmed ${tool}.`);
  });
  server.registerTool("hosting_prepare_destructive_action", {
    title: "Preview WordPress reset or account deletion",
    description: "Read and verify a single accessible account, primary domain and (for WordPress) exact Softaculous installation ID. Return full deletion impact, exact confirmation and a ten-minute single-use plan_id. Makes no hosting changes and creates no backup. Rejects shared installation directories/databases/users. All files in the selected installation directory may be removed, including unmanaged files. Account termination removes all websites, databases and mailboxes; DNS is retained. Capability enablement and a preview are not permission to execute deletion.",
    inputSchema: destructivePlanInput, annotations, _meta: { securitySchemes }
  }, async input => result(await prepareDestructiveAction(config, input), "Deletion preview prepared; no hosting changes made. Review impact and obtain explicit target-specific approval before execution."));
  server.registerTool("hosting_delete_account", {
    title: "Delete one hosting account",
    description: "Terminate the exact account from a fresh delete_account preview. Requires whm:read whm:delete and WHM Terminate Accounts permission. Use single-use plan_id, exact preview confirmation and confirm=true only after the user authorizes this specific deletion. Removes all websites, files, databases and mailboxes in the account, retains DNS and creates no backup. Ownership/identity are rechecked. No bulk deletion or automatic retry.",
    inputSchema: destructiveExecuteInput, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, DELETE_SCOPE] }] }
  }, async input => {
    if (!access.canDelete) throw new Error("Account deletion requires whm:delete. Add that API permission and reauthorize the existing Web connection.");
    return result(await deleteHostingAccount(config, input), "WHM confirmed account termination. DNS retained; no backup created.");
  });
  server.registerTool("hosting_delete_wordpress", {
    title: "Uninstall one WordPress installation",
    description: "Remove the exact installation from a fresh delete_wordpress preview: installation-directory files, database and database user. Keep the hosting account and mailboxes. Requires whm:read whm:wordpress whm:delete. Creates no backup. Execute only after target-specific user approval with exact preview confirmation. Ownership/inventory are rechecked and the plan is consumed before deletion. Never blindly retry.",
    inputSchema: destructiveExecuteInput, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE, DELETE_SCOPE] }] }
  }, async input => {
    if (!access.canInstall || !access.canDelete) throw new Error("WordPress destruction requires whm:wordpress and whm:delete.");
    return result(await deleteWordpress(config, input), "Softaculous confirmed WordPress removal. Hosting retained; no backup created.");
  });
  server.registerTool("hosting_reinstall_wordpress", {
    title: "Remove WordPress and install a fresh site",
    description: "Execute a target-approved reinstall_wordpress preview at the primary-domain root. Validate title, admin/contact emails and public connectivity before removal, recheck inventory, remove the old site, then install a fresh WordPress. Requires whm:read whm:wordpress whm:delete and exact confirmation. Old content/users/MCP credentials are lost; no backup created. setup_mcp defaults true to configure a new private bridge. Report partial results exactly; never repeat deletion automatically.",
    inputSchema: { ...destructiveExecuteInput, site_title: wordpressInput.site_title, admin_email: wordpressInput.admin_email, setup_mcp: z.boolean().default(true) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE, DELETE_SCOPE] }] }
  }, async input => {
    if (!access.canInstall || !access.canDelete) throw new Error("WordPress destruction requires whm:wordpress and whm:delete.");
    const state = await reinstallWordpress(config, input);
    return result(state, `WordPress reinstall: ${state.status}. Never retry deletion automatically.`);
  });
  return server;
}
