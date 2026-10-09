import { createHostingAccount, creationInput, CREATE_SCOPE } from "./account-creation.js";
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

export function createMcpServer(config: Config, access: { canCreate: boolean } = { canCreate: false }): McpServer {
  const whm = new WhmClient(config);
  const securitySchemes = [{ type: "oauth2" as const, scopes: [config.OAUTH_SCOPE] }];
  const server = new McpServer(
    { name: "pagesurgeai-whm-gateway", version: "0.3.0" },
    { instructions: "Inspect the configured WHM reseller account and create accounts only when explicitly requested with the required creation permission. No account modification, suspension, restoration, deletion, or WordPress installation is implemented." }
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

  return server;
}
