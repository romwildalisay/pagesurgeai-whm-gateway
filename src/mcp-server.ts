import { installWordpressWithMcp } from "./wordpress-install.js";
import { createHostingAccount, creationInput, CREATE_SCOPE } from "./account-creation.js";
import { configureWordpressEmail, wordpressStatus, wordpressInput, wordpressInstallInput, wordpressSiteSelectorFields, WORDPRESS_SCOPE } from "./wordpress-setup.js";
import { setupWordpressMcp, wordpressRead, wordpressWrite, wordpressReads, wordpressWrites, wordpressAccountInput, wordpressParameters } from "./wordpress-mcp.js";
import { DELETE_SCOPE, prepareDestructiveAction, destructivePlanInput, destructiveExecuteInput, deleteHostingAccount, deleteWordpress, reinstallWordpress } from "./destructive-actions.js";
import { BANDWIDTH_SCOPE, SSL_SCOPE, accountTargetInput, bandwidthInput, sslArchiveInput, getBandwidth, setAccountBandwidth, validateAccountSslZip, installAccountSslZip, getAccountSslStatus } from "./account-management.js";
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

export function createMcpServer(config: Config, access: { canCreate: boolean; canInstall?: boolean; canDelete?: boolean; canBandwidth?: boolean; canSsl?: boolean } = { canCreate: false }): McpServer {
  const whm = new WhmClient(config);
  const securitySchemes = [{ type: "oauth2" as const, scopes: [config.OAUTH_SCOPE] }];
  const server = new McpServer(
    { name: "pagesurgeai-whm-gateway", version: "0.9.2" },
    { instructions: "Inspect hosting, create accounts with creation permission, and manage WordPress on verified reseller-owned accounts. Select WordPress sites by exact primary domain; the gateway resolves the account through WHM and uses an independent private Bearer token per installation. Install the user's WordPress MCP Manager through hosting_setup_wordpress_mcp. Valid WordPress HTTPS is required. Read site identity and current content before writes. Set confirm=true only for user-authorized actions. Do not retry uncertain writes. Destructive hosting operations require a fresh preview, exact target approval and whm:delete. No shell access is implemented." }
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
    description: "Read Softaculous inventory for one reseller-owned account. Select by exact primary domain (recommended) or cPanel username; the gateway resolves and verifies the target through WHM. Use before installation and after uncertain results; never returns credentials. Unmanaged installations may not appear.",
    inputSchema: wordpressSiteSelectorFields, annotations, _meta: { securitySchemes }
  }, async ({ username, domain }) => {
    const status = await wordpressStatus(config, { username, domain });
    return result(status, `Found ${status.count} WordPress installation(s) in Softaculous for ${status.domain}.`);
  });

  server.registerTool("hosting_configure_wordpress_email", {
    title: "Configure WordPress installation emails",
    description: "Enable Softaculous installation emails to the verified WHM contact email of the selected verified account. Requires whm:read and whm:wordpress. Use confirm=true only when requested. Does not send existing credentials, reset passwords, reinstall WordPress, or accept an arbitrary recipient. Password inclusion is requested automatically. Inbox delivery is not verified.",
    inputSchema: { ...wordpressSiteSelectorFields, confirm: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE] }] }
  }, async ({ username, domain }) => {
    if (!access.canInstall) throw new Error("WordPress email configuration requires the whm:wordpress permission.");
    const configured = await configureWordpressEmail(config, { username, domain });
    return result(configured, `Configured Softaculous installation emails to ${configured.recipient}. Password inclusion was requested automatically. No existing credentials were sent.`);
  });

  server.registerTool("hosting_install_wordpress", {
    title: "Install WordPress on selected account",
    description: "Install WordPress at the root of a reseller-owned account's primary domain through Softaculous. The exact domain is required; cPanel username is optional because the gateway resolves it from WHM and verifies ownership. HTTPS is required except for the explicitly authorized mature-yellow-fish.104-219-248-4.cpanel.site HTTP test. Requires whm:read and whm:wordpress plus WHM reseller session access. Set confirm=true only when the user requests installation on this domain. Never overwrites existing files; existing installations are returned without changes. New installations request an email to the verified hosting contact address; password inclusion is requested automatically. Admin password is generated privately; use Softaculous Login. Automatically installs and connects WordPress MCP Manager 2.0.5 after a new installation; reports incomplete MCP setup separately.",
    inputSchema: wordpressInstallInput, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE] }] }
  }, async (input) => {
    if (!access.canInstall) throw new Error("WordPress installation requires whm:wordpress. Reauthorize the existing Web connection with that permission.");
    const installed = await installWordpressWithMcp(config, input);
    return result(installed, installed.status === "already_exists" ? "WordPress is already listed on this domain; no changes made." : ("mcp_setup" in installed && installed.mcp_setup === "connected" ? "WordPress installed and MCP connection verified." : "WordPress installed; MCP setup incomplete. Inspect plugin inventory and retry hosting_setup_wordpress_mcp without reinstalling WordPress."));
  });
  server.registerTool("hosting_setup_wordpress_mcp", {
    title: "Install and connect WordPress MCP Manager",
    description: "Install and connect WordPress MCP Manager 2.0.5 on one verified reseller-owned account. Select by exact primary domain (recommended) or cPanel username; the gateway resolves and verifies the account through WHM. Configure a private per-site Bearer token automatically on first activation, using the existing pagesurgeadmin user. One gateway connection can manage multiple eligible sites; tokens remain separate per site and no per-account Render secret is needed. Requires whm:read and whm:wordpress and explicit confirm=true. Never overwrites an existing plugin/token. Public MCP authentication requires valid HTTPS. Inspect plugin inventory after uncertain writes.",
    inputSchema: { ...wordpressAccountInput, confirm: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE] }] }
  }, async ({ username, domain, confirm }) => {
    if (!access.canInstall) throw new Error("WordPress MCP setup requires whm:wordpress.");
    const configured = await setupWordpressMcp(config, { username, domain }, confirm);
    return result(configured, `WordPress MCP setup: ${configured.status}. No Bearer token is returned in chat.`);
  });
  server.registerTool("hosting_wordpress_read", {
    title: "Read connected WordPress",
    description: "Read site identity, capabilities, content, media, settings, menus, themes, plugins or users through the private WordPress MCP bridge. Select by exact primary domain (recommended) or cPanel username; the gateway resolves and verifies ownership through WHM, then routes to that site's own MCP endpoint and token. Verify get_site_info before changes. Valid HTTPS is required. Parameters follow WordPress MCP Manager's tool schema. Does not accept arbitrary URLs or expose credentials.",
    inputSchema: { ...wordpressAccountInput, tool: z.enum(wordpressReads), parameters: wordpressParameters },
    annotations, _meta: { securitySchemes }
  }, async ({ username, domain, tool, parameters }) => result(await wordpressRead(config, { username, domain }, tool, parameters), `Read WordPress using ${tool}.`));
  server.registerTool("hosting_wordpress_write", {
    title: "Change connected WordPress",
    description: "Run a user-authorized WordPress MCP Manager write on one verified site. Select by exact primary domain (recommended) or cPanel username; the gateway resolves and verifies ownership through WHM, then uses that site's private Bearer token. Requires whm:read, whm:wordpress and confirm=true. Read exact IDs/current content first. Use draft status for new pages unless publishing was requested. Parameters follow WordPress MCP Manager's tool schema. Installation/activation/deletion/settings/user changes must be explicitly requested. Never retry uncertain writes automatically; inspect state instead. Does not accept arbitrary URLs or WHM commands.",
    inputSchema: { ...wordpressAccountInput, tool: z.enum(wordpressWrites), parameters: wordpressParameters, confirm: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, WORDPRESS_SCOPE] }] }
  }, async ({ username, domain, tool, parameters, confirm }) => {
    if (!access.canInstall) throw new Error("WordPress changes require whm:wordpress.");
    return result(await wordpressWrite(config, { username, domain }, tool, parameters, confirm), `WordPress confirmed ${tool}.`);
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
  server.registerTool("hosting_get_bandwidth", {
    title: "Inspect monthly bandwidth limit and usage",
    description: "Read exact account ownership and primary domain, then current-month WHM showbw inventory. Returns limit in MB and usage, including explicit unlimited. Requires WHM View Account Bandwidth Usage permission. Makes no changes; use before and after bandwidth adjustments.",
    inputSchema: accountTargetInput, annotations, _meta: { securitySchemes }
  }, async input => result(await getBandwidth(config, input), "Read monthly bandwidth limit and usage; no changes made."));
  server.registerTool("hosting_set_bandwidth", {
    title: "Adjust one account's monthly bandwidth limit",
    description: "Set one verified account's monthly bandwidth quota to explicit integer limit_mb or unlimited. 1 GB in prompts means 1024 MB; 0 is rejected to avoid accidental unlimited access. Requires whm:read whm:bandwidth and WHM Bandwidth Limit Modification permission. Supply exact username/primary domain and confirm=true only for the requested adjustment. Read usage first and warn if reducing below current usage. Does not edit shared packages or unsuspend accounts. Verifies read-back; never retry uncertain writes automatically.",
    inputSchema: bandwidthInput, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, BANDWIDTH_SCOPE] }] }
  }, async input => {
    if (!access.canBandwidth) throw new Error("Bandwidth changes require whm:bandwidth. Grant the API permission and reauthorize the existing Web connection.");
    const state = await setAccountBandwidth(config, input); return result(state, `Bandwidth adjustment: ${state.status}.`);
  });
  server.registerTool("hosting_validate_ssl_zip", {
    title: "Validate an attached SSL ZIP without installation",
    description: "Verify account/domain ownership and an attached ZIP encoded as zip_base64. Accepts PEM certificate, exactly one matching unencrypted RSA/ECDSA private key, and intermediate CA certificates. Bounded archive parsing; reject unsafe paths, encryption, expiry, mismatched domains/keys and untrusted TLS-server chains. Requires whm:read whm:ssl. Returns safe certificate metadata and replacement impact only; never returns keys or the ZIP. Makes no SSL changes. Validation does not purchase/activate a certificate or check revocation.",
    inputSchema: sslArchiveInput, annotations,
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, SSL_SCOPE] }] }
  }, async input => {
    if (!access.canSsl) throw new Error("SSL ZIP validation requires whm:ssl. Reauthorize the existing Web connection.");
    return result(await validateAccountSslZip(config, input), "SSL ZIP validated; no SSL changes made. Installation may replace the certificate for the domain and its shared aliases.");
  });
  server.registerTool("hosting_install_ssl_zip", {
    title: "Install SSL from an attached certificate ZIP",
    description: "Install a user-requested certificate ZIP on an exact verified account domain. Supply zip_base64 of the attachment and confirm=true only for that domain-specific installation. Revalidates the archive, matching key, domain, dates, public CA chain and ownership; posts secrets privately to WHM over verified HTTPS. Requires whm:read whm:ssl and WHM SSL Site Management permission. Replaces the domain's Apache-vhost certificate and may affect shared aliases. No purchase, renewal, DNS changes or WordPress URL changes. Reports WHM installation separately from public TLS verification. Never return private keys/raw responses or retry uncertain writes.",
    inputSchema: { ...sslArchiveInput, confirm: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [config.OAUTH_SCOPE, SSL_SCOPE] }] }
  }, async input => {
    if (!access.canSsl) throw new Error("SSL installation requires whm:ssl. Grant the API permission and reauthorize the existing Web connection.");
    const state = await installAccountSslZip(config, input); return result(state, "WHM confirmed SSL installation. Check public_tls for independent HTTPS verification; no private key returned.");
  });
  server.registerTool("hosting_get_ssl_status", {
    title: "Check public domain HTTPS certificate",
    description: "Verify account/domain ownership and attempt a public TLS connection with certificate verification enabled. Returns safe fingerprint/expiry and HTTPS status. Private network addresses are excluded. A CDN may serve a different certificate. Makes no changes and does not prove WordPress/MCP authentication.",
    inputSchema: accountTargetInput, annotations, _meta: { securitySchemes }
  }, async input => result(await getAccountSslStatus(config, input), "Public HTTPS check completed; inspect https_verified."));
  return server;
}
