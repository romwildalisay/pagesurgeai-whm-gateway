import { randomBytes, createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { WhmClient, verifyOwnedAccount } from "./whm-client.js";
import { configureInstallationEmail, hasErrors, installWordpress, SoftaculousClient, wordpressInput } from "./wordpress-setup.js";
import { setupWordpressMcp } from "./wordpress-mcp.js";

export const DELETE_SCOPE = "whm:delete";
export const destructiveActions = ["delete_wordpress", "reinstall_wordpress", "delete_account"] as const;
export const destructivePlanInput = {
  action: z.enum(destructiveActions), username: wordpressInput.username, domain: wordpressInput.domain,
  installation_id: z.string().regex(/^26_[0-9]+$/).optional()
};
export const destructiveExecuteInput = { plan_id: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.string().max(400), confirm: z.literal(true) };
type PlanRequest = z.infer<ReturnType<typeof planSchema>>;
function planSchema() { return z.object(destructivePlanInput).strict(); }
type RecordInfo = { id: string; url: string; path: string; database: string; databaseUser: string };
type Plan = PlanRequest & { expires: number; binding: string; account: string; installation?: RecordInfo; inventory?: string; confirmation: string };
// Single-use plans are process-local and expire in ten minutes. A restart
// invalidates them; no secret, approval or deletion state is written to disk.
const plans = new Map<string, Plan>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (c: Config) => digest([c.WHM_BASE_URL, c.WHM_USERNAME, c.WHM_API_TOKEN]);
const accountFingerprint = (a: any) => digest([a.user, a.domain, a.owner, a.startdate, a.uid]);

async function records(client: SoftaculousClient) {
  const body = await client.request("installations");
  if (hasErrors(body.error) || !body.installations || typeof body.installations !== "object") throw new Error("Full Softaculous inventory could not be verified; deletion is blocked.");
  const result: RecordInfo[] = [];
  function inspect(value: any, key: string, depth: number) {
    if (!value || typeof value !== "object" || depth > 4) throw new Error("Softaculous inventory format was not recognized; deletion is blocked.");
    if (typeof value.softurl === "string") {
      const url = new URL(value.softurl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.port) throw new Error("Installation URL could not be verified.");
      const settings = value._settings ?? {};
      result.push({ id: String(value.insid ?? value.ins_id ?? key), url: url.href, path: String(value.softpath ?? settings.softpath ?? "").replace(/\/+$/, ""), database: String(value.softdb ?? settings.softdb ?? ""), databaseUser: String(value.softdbuser ?? settings.softdbuser ?? "") });
      return;
    }
    for (const [childKey, child] of Object.entries(value)) inspect(child, childKey, depth + 1);
  }
  inspect(body.installations, "", 0);
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

async function siteTarget(config: Config, request: PlanRequest) {
  const client = new SoftaculousClient(config, request.username);
  const inventory = await records(client);
  const selected = inventory.find(i => i.id === request.installation_id && /^26_[0-9]+$/.test(i.id) && new URL(i.url).hostname === request.domain);
  if (!selected) throw new Error("The exact WordPress installation ID and domain were not found in this account; deletion is blocked.");
  if (!new RegExp(`^/home[0-9]*/${request.username}/.+`).test(selected.path) || posix.normalize(selected.path) !== selected.path || !selected.database || !selected.databaseUser) throw new Error("Installation directory, database and database user must be present in Softaculous inventory before deletion. Import or inspect the installation; no changes made.");
  for (const other of inventory.filter(i => i.id !== selected.id)) {
    if (!other.path || posix.normalize(other.path) !== other.path || !other.database || !other.databaseUser || other.path === selected.path || other.path.startsWith(selected.path + "/") || selected.path.startsWith(other.path + "/") || other.database === selected.database || other.databaseUser === selected.databaseUser) throw new Error("Another installation may share this directory/database/user. Separate or verify the installations before removal; no changes made.");
  }
  if (request.action === "reinstall_wordpress" && new URL(selected.url).pathname !== "/") throw new Error("Fresh reinstall currently supports the account's primary-domain root only. No changes made.");
  return { client, inventory, selected };
}

export async function prepareDestructiveAction(config: Config, input: PlanRequest) {
  const request = planSchema().parse(input);
  const account = await verifyOwnedAccount(config, request.username, request.action === "delete_account");
  if (String(account.domain).toLowerCase() !== request.domain) throw new Error("Domain does not match this hosting account's primary domain.");
  for (const [id, plan] of plans) if (plan.expires <= Date.now()) plans.delete(id);
  if (plans.size >= 1000) throw new Error("Too many pending previews. Wait for older previews to expire.");
  const verb = request.action === "delete_account" ? "DELETE ACCOUNT" : request.action === "delete_wordpress" ? "DELETE WORDPRESS" : "REINSTALL WORDPRESS";
  const confirmation = `${verb} ${request.username} ${request.domain}${request.action === "delete_account" ? "" : ` ${request.installation_id}`}`;
  const plan: Plan = { ...request, expires: Date.now() + 10 * 60_000, binding: binding(config), account: accountFingerprint(account), confirmation };
  let impact: string[];
  if (request.action === "delete_account") {
    if (request.installation_id) throw new Error("Account deletion does not accept a WordPress installation ID.");
    impact = ["Entire cPanel account: all websites, files, databases, database users and mailboxes", "DNS zone retained; account data is not retained", "Backups are not created by this tool"];
    if (request.username === config.WHM_USERNAME) impact.push("This is the gateway's own WHM identity. Deleting it can disable hosting automation and reseller access.");
  } else {
    const site = await siteTarget(config, request);
    plan.installation = site.selected; plan.inventory = digest(site.inventory);
    impact = [`All files in ${site.selected.path}, including unmanaged files in that directory`, `Database ${site.selected.database} and database user ${site.selected.databaseUser}`, "Hosting account and mailboxes remain", "Backups are not created by this tool", ...(request.action === "reinstall_wordpress" ? ["A fresh site replaces the deleted installation; prior content, users and MCP credentials are lost"] : [])];
  }
  const id = randomBytes(32).toString("hex"); plans.set(id, plan);
  return { status: "preview_only", action: request.action, username: request.username, domain: request.domain, installation_id: request.installation_id ?? null, site_url: plan.installation?.url ?? null, impact, backup_created: false, plan_id: id, expires_at: new Date(plan.expires).toISOString(), confirmation, changes_made: false };
}

async function checkedPlan(config: Config, action: PlanRequest["action"], input: z.infer<ReturnType<typeof executeSchema>>) {
  executeSchema().parse(input);
  const plan = plans.get(input.plan_id);
  if (!plan || plan.expires <= Date.now() || plan.binding !== binding(config) || plan.action !== action) throw new Error("Preview is missing, expired, used, or for a different operation. Prepare a new preview after inspecting current state.");
  if (input.confirmation !== plan.confirmation) throw new Error("Exact account/domain confirmation does not match the preview. No changes made.");
  const account = await verifyOwnedAccount(config, plan.username, action === "delete_account");
  if (String(account.domain).toLowerCase() !== plan.domain || accountFingerprint(account) !== plan.account) throw new Error("Account changed since preview; deletion is blocked.");
  if (action !== "delete_account") {
    const site = await siteTarget(config, plan);
    if (digest(site.inventory) !== plan.inventory) throw new Error("Installation inventory changed since preview; deletion is blocked.");
  }
  return { plan, account };
}
function executeSchema() { return z.object(destructiveExecuteInput).strict(); }
type ExecuteRequest = z.infer<ReturnType<typeof executeSchema>>;
function consume(id: string) {
  if (!plans.delete(id)) throw new Error("Preview was already used. No repeated deletion is allowed.");
}
async function removeInstallation(config: Config, plan: Plan) {
  const client = new SoftaculousClient(config, plan.username);
  const response = await client.request("remove", new URLSearchParams({ insid: plan.installation!.id, removeins: "1", remove_dir: "1", remove_datadir: "1", remove_db: "1", remove_dbuser: "1" }));
  if (hasErrors(response.error) || ![1, "1", true].includes(response.done)) throw new Error("WordPress removal was not confirmed. Inspect Softaculous and files; do not retry automatically.");
  if ((await client.installations()).some(i => i.id === plan.installation!.id)) throw new Error("Softaculous still lists the removed installation. Reinstallation was blocked; inspect current state.");
}
export async function deleteHostingAccount(config: Config, input: ExecuteRequest) {
  const { plan } = await checkedPlan(config, "delete_account", input);
  consume(input.plan_id);
  return new WhmClient(config).deleteAccount(plan.username, plan.domain);
}
export async function deleteWordpress(config: Config, input: ExecuteRequest) {
  const { plan } = await checkedPlan(config, "delete_wordpress", input);
  consume(input.plan_id); await removeInstallation(config, plan);
  return { status: "removed", username: plan.username, domain: plan.domain, installation_id: plan.installation!.id, hosting_account_retained: true, backup_created: false };
}
export async function reinstallWordpress(config: Config, input: ExecuteRequest & { site_title: string; admin_email: string; setup_mcp?: boolean }) {
  const { site_title, admin_email, setup_mcp = true, ...execution } = input;
  const { plan, account } = await checkedPlan(config, "reinstall_wordpress", execution);
  const fresh = z.object(wordpressInput).strict().parse({ username: plan.username, domain: plan.domain, site_title, admin_email, confirm: true });
  // Before removing anything, verify installation inputs, account contact,
  // public HTTPS (or the existing exact test exception) and email configuration.
  const protocol = plan.domain === "mature-yellow-fish.104-219-248-4.cpanel.site" ? "http" : "https";
  try {
    const response = await fetch(`${protocol}://${plan.domain}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(config.WHM_TIMEOUT_MS) });
    if (response.status >= 300) throw new Error("Site is not ready");
  } catch { throw new Error("Public site connectivity/HTTPS preflight failed. Nothing was removed."); }
  await configureInstallationEmail(new SoftaculousClient(config, plan.username), account.email);
  // Revalidate after preflight; consume atomically before the first deletion.
  await checkedPlan(config, "reinstall_wordpress", execution); consume(execution.plan_id);
  await removeInstallation(config, plan);
  try {
    const installed = await installWordpress(config, fresh);
    if (installed.status !== "installed") return { status: "removed_reinstall_not_confirmed", username: plan.username, domain: plan.domain, next_step: "Inspect inventory/files; a fresh installation was not confirmed. Do not repeat deletion." };
    let mcp: unknown = { status: "not_requested" };
    if (setup_mcp) {
      try { mcp = await setupWordpressMcp(config, plan.username, true); }
      catch { mcp = { status: "not_confirmed", next_step: "Inspect plugin inventory before retrying MCP setup. WordPress was installed." }; }
    }
    return { status: "reinstalled", wordpress: installed, mcp, backup_created: false };
  } catch {
    return { status: "removed_reinstall_not_confirmed", username: plan.username, domain: plan.domain, next_step: "Inspect inventory and files. Fresh installation may have completed; never repeat deletion automatically." };
  }
}
