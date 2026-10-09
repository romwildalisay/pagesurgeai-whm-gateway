import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { WhmClient } from "./whm-client.js";
import { SoftaculousClient } from "./wordpress-setup.js";
import { setupWordpressMcp, wordpressRead, wordpressWrite, sanitizeWordpressResult, pluginZip } from "./wordpress-mcp.js";
const config: Config = { WHM_BASE_URL: "https://whm.test:2087", WHM_USERNAME: "reseller", WHM_API_TOKEN: "a".repeat(32), PUBLIC_BASE_URL: "https://gateway.test", OAUTH_ISSUER: "https://auth.test", OAUTH_AUDIENCE: "gateway", OAUTH_SCOPE: "whm:read", PORT: 3000, WHM_TIMEOUT_MS: 1000, CPANEL_USERNAME: "labsite" };
function target() {
  vi.spyOn(WhmClient.prototype, "call").mockResolvedValue({ data: { acct: [{ user: "labsite", owner: "reseller", domain: "lab.example.com", suspended: 0 }] } });
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
it("ships only a token hash and reports the HTTPS blocker honestly", async () => {
  target(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS"));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValueOnce({ plugins: {} }).mockResolvedValueOnce({ done: true });
  const result = await setupWordpressMcp(config, "labsite", true);
  expect(result.status).toBe("installed_https_required");
  const form = api.mock.calls[1][1] as FormData;
  expect(form.get("insid")).toBe("26_42"); expect(form.get("activate")).toBe("1");
  const zip = Buffer.from(await (form.get("custom_file") as Blob).arrayBuffer());
  expect(zip.toString()).toContain("has_cap('manage_options')");
  expect(zip.toString()).not.toContain(config.WHM_API_TOKEN);
  expect(JSON.stringify(result)).not.toMatch(/wpmcp_[a-f0-9]{64}/);
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
