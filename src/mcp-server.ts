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

export function createMcpServer(config: Config): McpServer {
  const whm = new WhmClient(config);
  const server = new McpServer(
    { name: "pagesurgeai-whm-gateway", version: "0.1.0" },
    { instructions: "Read-only access to the configured PageSurgeAI WHM reseller account. Never imply that these tools can create, modify, suspend, restore, or delete hosting resources." }
  );

  server.registerTool("hosting_list_accounts", {
    title: "List hosting accounts",
    description: "List cPanel accounts visible to the configured WHM reseller. Use for inventory and account lookup. This tool never changes hosting state.",
    inputSchema: { search: z.string().trim().max(253).optional() },
    annotations
  }, async ({ search }) => {
    const body = await whm.call("listaccts", search ? { search, searchtype: "domain" } : {});
    const accounts = extractAccounts(body).map(accountView);
    return result({ accounts, count: accounts.length }, `Found ${accounts.length} hosting account${accounts.length === 1 ? "" : "s"}.`);
  });

  server.registerTool("hosting_get_account", {
    title: "Get hosting account",
    description: "Return details for one cPanel username. Use after listing accounts when an exact account needs inspection. This tool never changes hosting state.",
    inputSchema: { username: z.string().min(1).max(16) },
    annotations
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
    annotations
  }, async () => {
    const body = await whm.call("listpkgs");
    const packages = extractPackages(body);
    return result({ packages, count: packages.length }, `Found ${packages.length} hosting package${packages.length === 1 ? "" : "s"}.`);
  });

  server.registerTool("hosting_get_usage", {
    title: "Get hosting usage",
    description: "Return disk and bandwidth usage for one cPanel username. This tool never changes hosting state.",
    inputSchema: { username: z.string().min(1).max(16) },
    annotations
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

  return server;
}
