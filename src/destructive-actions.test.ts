import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { WhmClient } from "./whm-client.js";
import { SoftaculousClient, wordpressStatus } from "./wordpress-setup.js";
import { prepareDestructiveAction, deleteHostingAccount, deleteWordpress, reinstallWordpress } from "./destructive-actions.js";
const config: Config = { WHM_BASE_URL: "https://whm.test:2087", WHM_USERNAME: "reseller", WHM_API_TOKEN: "a".repeat(32), PUBLIC_BASE_URL: "https://gateway.test", OAUTH_ISSUER: "https://auth.test", OAUTH_AUDIENCE: "gateway", OAUTH_SCOPE: "whm:read", PORT: 3000, WHM_TIMEOUT_MS: 1000 };
const acct = { user: "newsite", domain: "new.example.com", owner: "reseller", startdate: "123", suspended: 0, email: "owner@example.com" };
const site = { softurl: "https://new.example.com/", softpath: "/home/newsite/public_html/", softdb: "newsite_wp", softdbuser: "newsite_wpuser" };
function setup(extra: Record<string, unknown> = {}) {
  const whm = vi.spyOn(WhmClient.prototype, "call").mockResolvedValue({ data: { acct: [{ ...acct, ...extra }] } });
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ installations: { "26_42": site } });
  return { whm, api };
}
const wpRequest = { action: "delete_wordpress" as const, username: acct.user, domain: acct.domain, installation_id: "26_42" };
const exec = (p: { plan_id: string; confirmation: string }) => ({ plan_id: p.plan_id, confirmation: p.confirmation, confirm: true as const });
afterEach(() => vi.restoreAllMocks());

it("supports another owned account with no per-account Render username/password", async () => {
  setup(); const status = await wordpressStatus(config, acct.user);
  expect(status.count).toBe(1); expect(status.username).toBe("newsite");
});
it("sends account termination as one bounded authenticated WHM operation with DNS retained", async () => {
  setup();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ metadata: { result: 1 }, private_output: "secret" })));
  const result = await new WhmClient(config).deleteAccount(acct.user, acct.domain);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0][0])).toContain("/json-api/removeacct");
  const init = fetch.mock.calls[0][1]!;
  expect(init.method).toBe("POST"); expect(init.redirect).toBe("error");
  expect((init.body as URLSearchParams).get("username")).toBe(acct.user);
  expect((init.body as URLSearchParams).get("keepdns")).toBe("1");
  expect(JSON.stringify(result)).not.toContain("secret");
  await expect(new WhmClient(config).deleteAccount(acct.user, "wrong.example.com")).rejects.toThrow("domain changed");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("reinstalls fresh WordPress only after confirmed removal and reports MCP separately", async () => {
  const { api } = setup(); const p = await prepareDestructiveAction(config, { ...wpRequest, action: "reinstall_wordpress" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  let removed = false;
  api.mockImplementation(async action => {
    if (action === "remove") { removed = true; return { done: true }; }
    if (action === "email" || action === "software") return { done: true };
    return { installations: removed ? {} : { "26_42": site } };
  });
  const result = await reinstallWordpress(config, { ...exec(p), site_title: "Fresh", admin_email: "owner@example.com", setup_mcp: false });
  expect(result.status).toBe("reinstalled");
  expect(api.mock.calls.findIndex(c => c[0] === "remove")).toBeLessThan(api.mock.calls.findIndex(c => c[0] === "software"));
  expect(JSON.stringify(result)).not.toContain("admin_pass");
});
it("previews exact impact without making writes and blocks unowned/domain mismatches", async () => {
  const { whm, api } = setup(); const remove = vi.spyOn(WhmClient.prototype, "deleteAccount");
  const p = await prepareDestructiveAction(config, wpRequest);
  expect(p.changes_made).toBe(false); expect(p.backup_created).toBe(false);
  expect(p.impact.join(" ")).toContain("unmanaged files"); expect(api).toHaveBeenCalledWith("installations");
  await expect(prepareDestructiveAction(config, { ...wpRequest, domain: "wrong.example.com" })).rejects.toThrow("primary domain");
  whm.mockResolvedValue({ data: { acct: [{ ...acct, owner: "someoneelse" }] } });
  await expect(prepareDestructiveAction(config, wpRequest)).rejects.toThrow("reseller-owned"); expect(remove).not.toHaveBeenCalled();
});
it.each([
 { softpath: "" }, { softdb: "" }, { softdbuser: "" }, { softpath: "/home/newsite/public_html/../other" }
])("blocks unverifiable directory/database ownership", async fields => {
  const { api } = setup(); api.mockResolvedValue({ installations: { "26_42": { ...site, ...fields } } });
  await expect(prepareDestructiveAction(config, wpRequest)).rejects.toThrow("directory");
});
it.each([
 { softpath: "/home/newsite/public_html/nested", softdb: "other", softdbuser: "otheruser" },
 { softpath: "/home/newsite/other", softdb: site.softdb, softdbuser: "otheruser" },
 { softpath: "/home/newsite/other", softdb: "other", softdbuser: site.softdbuser }
])("blocks overlapping installation paths or shared database/user", async fields => {
  const { api } = setup(); api.mockResolvedValue({ installations: { "26_42": site, "26_99": { ...site, softurl: "https://other.example.com/", ...fields } } });
  await expect(prepareDestructiveAction(config, wpRequest)).rejects.toThrow("Another installation");
});
it("requires exact confirmation and fresh account/inventory before WordPress removal", async () => {
  const { api } = setup(); const p = await prepareDestructiveAction(config, wpRequest);
  await expect(deleteWordpress(config, { ...exec(p), confirmation: "yes" })).rejects.toThrow("confirmation");
  await expect(deleteWordpress(config, { ...exec(p), confirm: false } as any)).rejects.toThrow();
  api.mockResolvedValue({ installations: { "26_42": { ...site, softdb: "changed" } } });
  await expect(deleteWordpress(config, exec(p))).rejects.toThrow("changed");
  expect(api.mock.calls.every(c => c[0] === "installations")).toBe(true);
});
it("removes only the selected installation and consumes the plan before mutation", async () => {
  const { api } = setup(); const p = await prepareDestructiveAction(config, wpRequest);
  api.mockImplementation(async (action) => action === "remove" ? { done: true } : { installations: api.mock.calls.some(c => c[0] === "remove") ? {} : { "26_42": site } });
  expect((await deleteWordpress(config, exec(p))).status).toBe("removed");
  expect((api.mock.calls.find(c => c[0] === "remove")![1] as URLSearchParams).get("insid")).toBe("26_42");
  await expect(deleteWordpress(config, exec(p))).rejects.toThrow("used");
  expect(api.mock.calls.filter(c => c[0] === "remove")).toHaveLength(1);
});
it("does not retry deletion after uncertain completion", async () => {
  const { api } = setup(); const p = await prepareDestructiveAction(config, wpRequest);
  api.mockImplementation(async action => { if (action === "remove") throw new Error("Timed out"); return { installations: { "26_42": site } }; });
  await expect(deleteWordpress(config, exec(p))).rejects.toThrow("Timed out");
  await expect(deleteWordpress(config, exec(p))).rejects.toThrow("used");
  expect(api.mock.calls.filter(c => c[0] === "remove")).toHaveLength(1);
});
it("enforces account confirmation, ownership, operation binding, expiry and single use", async () => {
  setup(); const remove = vi.spyOn(WhmClient.prototype, "deleteAccount").mockResolvedValue({ deleted: true, username: acct.user, domain: acct.domain, dns_zone_retained: true });
  const p = await prepareDestructiveAction(config, { action: "delete_account", username: acct.user, domain: acct.domain });
  await expect(deleteWordpress(config, exec(p))).rejects.toThrow("different");
  expect((await deleteHostingAccount(config, exec(p))).deleted).toBe(true);
  await expect(deleteHostingAccount(config, exec(p))).rejects.toThrow("used"); expect(remove).toHaveBeenCalledTimes(1);
  const q = await prepareDestructiveAction(config, { action: "delete_account", username: acct.user, domain: acct.domain });
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
  await expect(deleteHostingAccount(config, exec(q))).rejects.toThrow("expired"); expect(remove).toHaveBeenCalledTimes(1);
});
it("blocks reinstall before deletion when HTTPS preflight fails", async () => {
  const { api } = setup(); const p = await prepareDestructiveAction(config, { ...wpRequest, action: "reinstall_wordpress" });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS"));
  await expect(reinstallWordpress(config, { ...exec(p), site_title: "Fresh", admin_email: "owner@example.com" })).rejects.toThrow("Nothing was removed");
  expect(api.mock.calls.every(c => c[0] === "installations")).toBe(true);
});
it("reports removal separately when a fresh installation fails", async () => {
  const { api } = setup(); const p = await prepareDestructiveAction(config, { ...wpRequest, action: "reinstall_wordpress" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  let removed = false;
  api.mockImplementation(async action => { if (action === "remove") { removed = true; return { done: true }; } if (action === "email") return { done: true }; if (action === "software") throw new Error("uncertain"); return { installations: removed ? {} : { "26_42": site } }; });
  const r = await reinstallWordpress(config, { ...exec(p), site_title: "Fresh", admin_email: "owner@example.com" });
  expect(r.status).toBe("removed_reinstall_not_confirmed"); expect(api.mock.calls.filter(c => c[0] === "remove")).toHaveLength(1);
});
