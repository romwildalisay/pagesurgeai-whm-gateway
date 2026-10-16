import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { WhmClient } from "./whm-client.js";
import { SoftaculousClient } from "./wordpress-setup.js";
import { setupWordpressMcp, sendWordPressInstallCredentials, wordpressRead, wordpressWrite, sanitizeWordpressResult, pluginZip } from "./wordpress-mcp.js";
const config: Config = { WHM_BASE_URL: "https://whm.test:2087", WHM_USERNAME: "reseller", WHM_API_TOKEN: "a".repeat(32), PUBLIC_BASE_URL: "https://gateway.test", OAUTH_ISSUER: "https://auth.test", OAUTH_AUDIENCE: "gateway", OAUTH_SCOPE: "whm:read", PORT: 3000, WHM_TIMEOUT_MS: 1000, CPANEL_USERNAME: "labsite" };
function target() {
  vi.spyOn(WhmClient.prototype, "call").mockResolvedValue({ data: { acct: [{ user: "labsite", owner: "reseller", domain: "lab.example.com", email: "verified@example.com", suspended: 0 }] } });
  vi.spyOn(SoftaculousClient.prototype, "installations").mockResolvedValue([{ id: "26_42", url: "http://lab.example.com/" }]);
}
afterEach(() => vi.restoreAllMocks());
it("blocks unverified accounts and false confirmation before installer I/O", async () => {
  target();
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(setupWordpressMcp(config, "other", true)).rejects.toThrow("reseller-owned");
  await expect(setupWordpressMcp(config, "labsite", false as any)).rejects.toThrow();
  await expect(wordpressWrite(config, "labsite", "content_create", {}, false as any)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("never sends credentials when TLS fails or redirects", async () => {
  target(); const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS"));
  await expect(wordpressWrite(config, "labsite", "content_create", {}, true)).rejects.toThrow("HTTPS");
  fetch.mockResolvedValue(new Response(null, { status: 302, headers: { Location: "http://lab.example.com/" } }));
  await expect(wordpressRead(config, "labsite", "get_site_info")).rejects.toThrow("HTTPS");
  expect(fetch.mock.calls.every(([, init]) => init?.method === "HEAD" && !init.headers)).toBe(true);
});
it("uses stable scoped credentials and authoritative confirmation over HTTPS", async () => {
  target(); let token = "";
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://lab.example.com/index.php?rest_route=%2Fwpmcp%2Fv1%2Fmcp");
    expect(init?.redirect).toBe("manual");
    if (init?.method === "HEAD") return new Response(null, { status: 401 });
    token = (init!.headers as any).Authorization.slice(7);
    expect(JSON.parse(String(init!.body)).params.arguments.confirm).toBe(true);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { success: true, token } } }));
  });
  const first = await wordpressWrite(config, "labsite", "content_create", { confirm: false }, true);
  const original = token; await wordpressWrite(config, "labsite", "content_update", { id: 5 }, true);
  expect(token).toBe(original); expect(token).not.toContain(config.WHM_API_TOKEN);
  expect(JSON.stringify(first)).not.toContain(token); expect(fetch).toHaveBeenCalledTimes(4);
});
it("routes a domain-only WordPress request through the verified WHM account mapping", async () => {
  target();
  vi.spyOn(SoftaculousClient.prototype, "installations").mockResolvedValue([{ id: "26_42", url: "https://lab.example.com/" }]);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { url: "https://lab.example.com/", plugin_version: "2.0.6", name: "Lab" } } }));
  });
  const result = await wordpressRead(config, { domain: "lab.example.com" }, "get_site_info");
  expect(result).toMatchObject({ url: "https://lab.example.com/", plugin_version: "2.0.6" });
  expect(String(fetch.mock.calls[1][0])).toContain("https://lab.example.com/");
  expect(WhmClient.prototype.call).toHaveBeenCalledWith("listaccts");
});
it("routes two domains to separate accounts and sends separate site tokens", async () => {
  const accounts = [
    { user: "sitealpha", owner: "reseller", domain: "alpha.example.com", email: "alpha@example.com", suspended: 0 },
    { user: "sitebeta", owner: "reseller", domain: "beta.example.com", email: "beta@example.com", suspended: 0 }
  ];
  vi.spyOn(WhmClient.prototype, "call").mockImplementation(async (name, params = {}) => ({
    data: { acct: name === "listaccts" ? accounts : accounts.filter(a => a.user === params.user) }
  }));
  vi.spyOn(SoftaculousClient.prototype, "installations").mockImplementation(function (this: any) {
    return Promise.resolve([{ id: this.username === "sitealpha" ? "26_41" : "26_42", url: `https://${this.username === "sitealpha" ? "alpha" : "beta"}.example.com/` }]);
  });
  const bearerTokens: string[] = [];
  const endpoints: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    endpoints.push(String(url));
    bearerTokens.push((init?.headers as any).Authorization.slice(7));
    const site = String(url).includes("alpha.example.com") ? "https://alpha.example.com/" : "https://beta.example.com/";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { url: site, plugin_version: "2.0.6" } } }));
  });
  await wordpressRead(config, { domain: "alpha.example.com" }, "get_site_info");
  await wordpressRead(config, { domain: "beta.example.com" }, "get_site_info");
  expect(endpoints).toEqual([
    "https://alpha.example.com/index.php?rest_route=%2Fwpmcp%2Fv1%2Fmcp",
    "https://beta.example.com/index.php?rest_route=%2Fwpmcp%2Fv1%2Fmcp"
  ]);
  expect(bearerTokens).toHaveLength(2);
  expect(bearerTokens[0]).not.toBe(bearerTokens[1]);
  expect(bearerTokens.every(token => token.startsWith("wpmcp_") && !token.includes(config.WHM_API_TOKEN))).toBe(true);
});
it("ships only a token hash and reports the HTTPS blocker honestly", async () => {
  target(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS"));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValueOnce({ plugins: {} }).mockResolvedValueOnce({ done: true });
  const result = await setupWordpressMcp(config, "labsite", true);
  expect(result.status).toBe("installed_https_required");
  const form = api.mock.calls[1][1] as FormData;
  expect(form.get("insid")).toBe("26_42"); expect(form.get("activate")).toBe("1");
  const zip = Buffer.from(await (form.get("custom_file") as Blob).arrayBuffer());
  expect(zip.toString()).toContain("has_cap('manage_options')");
  expect(zip.toString()).toContain("wpmcp_credential_recipient");
  expect(zip.toString()).toContain("verified@example.com");
  expect(zip.toString()).not.toContain(config.WHM_API_TOKEN);
  expect(JSON.stringify(result)).not.toMatch(/wpmcp_[a-f0-9]{64}/);
});
it("queues installation credentials only to the verified contact and never returns them", async () => {
  target();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => init?.method === "HEAD"
    ? new Response(null, { status: 200 })
    : new Response(JSON.stringify({ success: true, queued: true }), { status: 200 }));
  const result = await sendWordPressInstallCredentials(config, "labsite", { login: "pagesurgeadmin", password: "temporary-private-password" });
  expect(result).toEqual({ status: "queued" });
  const [url, request] = vi.mocked(fetch).mock.calls[1];
  expect(String(url)).toContain("rest_route=%2Fwpmcp%2Fv1%2Fcredentials");
  expect((request?.headers as any).Authorization).toMatch(/^Bearer wpmcp_/);
  expect(JSON.parse(String(request?.body))).toEqual({ login: "pagesurgeadmin", password: "temporary-private-password" });
  expect(JSON.stringify(result)).not.toContain("temporary-private-password");
});
it("does not claim email failure or success when the authenticated request outcome is uncertain", async () => {
  target();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => init?.method === "HEAD"
    ? new Response(null, { status: 200 })
    : Promise.reject(new Error("connection interrupted")));
  await expect(sendWordPressInstallCredentials(config, "labsite", { login: "pagesurgeadmin", password: "private-password" })).resolves.toEqual({ status: "unknown" });
});
it("reports a definite WordPress mail rejection without exposing its body", async () => {
  target();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => init?.method === "HEAD"
    ? new Response(null, { status: 200 })
    : new Response(JSON.stringify({ code: "email_not_queued", message: "private mail details" }), { status: 502 }));
  const result = await sendWordPressInstallCredentials(config, "labsite", { login: "pagesurgeadmin", password: "private-password" });
  expect(result).toEqual({ status: "not_queued" });
  expect(JSON.stringify(result)).not.toContain("private mail details");
});
it("preserves an existing plugin/token and rejects unknown inventory", async () => {
  target(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS"));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ plugins: { "wordpress-mcp-manager/wordpress-mcp-manager.php": {} } });
  expect((await setupWordpressMcp(config, "labsite", true)).status).toBe("existing_plugin_needs_connection");
  expect(api).toHaveBeenCalledTimes(1);
  api.mockResolvedValue({ error: ["denied"], plugins: {} });
  await expect(setupWordpressMcp(config, "labsite", true)).rejects.toThrow("inventory");
  expect(api).toHaveBeenCalledTimes(2);
});
it("reports only safe response-shape diagnostics for unsupported plugin inventory", async () => {
  target(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS"));
  vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ data: { plugins: ["private-value"] } });
  let message = "";
  await setupWordpressMcp(config, "labsite", true).catch((error: unknown) => { message = error instanceof Error ? error.message : String(error); });
  expect(message).toMatch(/reason=plugins_field_missing; fields=data; plugins_field=none; plugins_type=undefined; error_type=undefined/);
  expect(message).not.toContain("private-value");
});
it("accepts Softaculous plugins_list and detects an existing MCP plugin", async () => {
  target(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS"));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ plugins_list: ["akismet/akismet.php", "wordpress-mcp-manager/wordpress-mcp-manager.php"] });
  const result = await setupWordpressMcp(config, "labsite", true);
  expect(result.status).toBe("existing_plugin_needs_connection");
  expect(api).toHaveBeenCalledTimes(1);
});
it("installs through Softaculous when plugins_list confirms no MCP plugin", async () => {
  target(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS"));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValueOnce({ plugins_list: ["akismet/akismet.php", "loginizer/loginizer.php"] }).mockResolvedValueOnce({ done: true });
  const result = await setupWordpressMcp(config, "labsite", true);
  expect(result.status).toBe("installed_https_required");
  expect(api).toHaveBeenCalledTimes(2);
});
it("never retries uncertain writes", async () => {
  target(); const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 401 })).mockRejectedValueOnce(new Error("private-secret"));
  await expect(wordpressWrite(config, "labsite", "content_update", { id: 5 }, true)).rejects.toThrow("not confirmed");
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("redacts nested secrets and produces ZIP local and central records", () => {
  expect(sanitizeWordpressResult({ item: { password: "hidden", text: "private-bearer" } }, "private-bearer")).toEqual({ item: { password: "[redacted]", text: "[redacted]" } });
  const zip = pluginZip({ "wordpress-mcp-manager/test.php": "<?php echo 'test';" });
  expect(zip.readUInt32LE()).toBe(0x04034b50);
  expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
});
