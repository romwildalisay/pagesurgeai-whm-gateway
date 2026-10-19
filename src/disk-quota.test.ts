import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { WhmClient } from "./whm-client.js";
import { getDiskQuota, parseDiskMb, setAccountDiskQuota } from "./disk-quota.js";

const config: Config = { WHM_BASE_URL: "https://whm.example.test:2087", WHM_USERNAME: "reseller", WHM_API_TOKEN: "a".repeat(32), PUBLIC_BASE_URL: "https://gateway.example.test", OAUTH_ISSUER: "https://tenant.example.test", OAUTH_AUDIENCE: "gateway", OAUTH_SCOPE: "whm:read", PORT: 3000, WHM_TIMEOUT_MS: 1000 };
const target = { username: "sitea", domain: "example.com" };
const request = { ...target, limit_mb: 5120, confirm: true as const };
const account = (disklimit: unknown = "10240M", diskused: unknown = "1M", extra = {}) => ({ data: { acct: [{ user: "sitea", domain: "example.com", owner: "reseller", disklimit, diskused, ...extra }] } });
afterEach(() => vi.restoreAllMocks());

describe("Disk quota", () => {
  it.each([["1M", 1], ["5120MB", 5120], ["1.5M", 1.5], [0, 0], ["0M", 0], [null, null], ["unknown", null], ["1G", null], ["-1M", null], ["", null], ["1e3", null]])("parses %s without treating missing usage as zero", (value, expected) => {
    expect(parseDiskMb(value)).toBe(expected);
  });
  it("reads MB usage and explicit unlimited", async () => {
    const read = vi.spyOn(WhmClient.prototype, "call").mockResolvedValue(account("unlimited", "1.5M"));
    expect(await getDiskQuota(config, target)).toMatchObject({ limit_mb: "unlimited", used_mb: 1.5, changes_made: false });
    expect(read).toHaveBeenCalledExactlyOnceWith("accountsummary", { user: "sitea" });
  });
  it("sets 5 GB as 5120 MB, rechecks and independently verifies", async () => {
    const read = vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account()).mockResolvedValueOnce(account()).mockResolvedValueOnce(account("5120M"));
    const write = vi.spyOn(WhmClient.prototype, "setDiskQuota").mockResolvedValue({ accepted: true });
    expect(await setAccountDiskQuota(config, request)).toMatchObject({ status: "updated", previous_limit_mb: 10240, limit_mb: 5120, package_changed: false });
    expect(write).toHaveBeenCalledExactlyOnceWith("sitea", 5120);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("does not write when already set", async () => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValue(account("5120M"));
    const write = vi.spyOn(WhmClient.prototype, "setDiskQuota");
    expect(await setAccountDiskQuota(config, request)).toMatchObject({ status: "already_set", changes_made: false });
    expect(write).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 1_000_000_001, "0", "5120"])("rejects invalid limit %s before reading or writing", async limit_mb => {
    const read = vi.spyOn(WhmClient.prototype, "call");
    await expect(setAccountDiskQuota(config, { ...request, limit_mb } as any)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("requires confirm=true", async () => {
    const read = vi.spyOn(WhmClient.prototype, "call");
    await expect(setAccountDiskQuota(config, { ...request, confirm: false } as any)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([{ owner: "someoneelse" }, { user: "someoneelse" }, { domain: "other.example" }])("rejects mismatched account %j", async extra => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValue(account("10240M", "1M", extra));
    const write = vi.spyOn(WhmClient.prototype, "setDiskQuota");
    await expect(setAccountDiskQuota(config, request)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it.each(["6000M", null, "unknown"])("blocks unsafe reduction with usage %s", async used => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValue(account("10240M", used));
    const write = vi.spyOn(WhmClient.prototype, "setDiskQuota");
    await expect(setAccountDiskQuota(config, request)).rejects.toThrow("explicit acceptance");
    expect(write).not.toHaveBeenCalled();
  });
  it("rechecks usage before writing", async () => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account()).mockResolvedValueOnce(account("10240M", "6000M"));
    const write = vi.spyOn(WhmClient.prototype, "setDiskQuota");
    await expect(setAccountDiskQuota(config, request)).rejects.toThrow("explicit acceptance");
    expect(write).not.toHaveBeenCalled();
  });
  it.each([null, "unknown", "0M"])("blocks an uninterpretable current limit %s", async limit => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValue(account(limit));
    const write = vi.spyOn(WhmClient.prototype, "setDiskQuota");
    await expect(setAccountDiskQuota(config, request)).rejects.toThrow("interpreted safely");
    expect(write).not.toHaveBeenCalled();
  });
  it("permits an explicitly accepted below-usage reduction", async () => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account("10240M", "6000M")).mockResolvedValueOnce(account("10240M", "6000M")).mockResolvedValueOnce(account("5120M", "6000M"));
    vi.spyOn(WhmClient.prototype, "setDiskQuota").mockResolvedValue({ accepted: true });
    expect(await setAccountDiskQuota(config, { ...request, allow_below_usage: true })).toMatchObject({ status: "updated", used_mb: 6000 });
  });
  it("supports explicit unlimited with unknown usage", async () => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account("10240M", null)).mockResolvedValueOnce(account("10240M", null)).mockResolvedValueOnce(account("unlimited", null));
    const write = vi.spyOn(WhmClient.prototype, "setDiskQuota").mockResolvedValue({ accepted: true });
    expect(await setAccountDiskQuota(config, { ...request, limit_mb: "unlimited" })).toMatchObject({ status: "updated", limit_mb: "unlimited" });
    expect(write).toHaveBeenCalledExactlyOnceWith("sitea", "unlimited");
  });
  it.each(["mismatch", "unavailable"])("does not claim success after %s read-back", async mode => {
    const read = vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account()).mockResolvedValueOnce(account());
    if (mode === "mismatch") read.mockResolvedValueOnce(account());
    else read.mockRejectedValueOnce(new Error("read failed"));
    const write = vi.spyOn(WhmClient.prototype, "setDiskQuota").mockResolvedValue({ accepted: true });
    expect(await setAccountDiskQuota(config, request)).toMatchObject({ status: "change_not_verified" });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("uses a single authenticated HTTPS POST and drops raw output", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ metadata: { result: 1, reason: "private-upstream" } })));
    expect(await new WhmClient(config).setDiskQuota("sitea", "unlimited")).toEqual({ accepted: true });
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://whm.example.test:2087/json-api/editquota?api.version=1");
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toMatchObject({ Authorization: `whm reseller:${config.WHM_API_TOKEN}` });
    expect(String(options?.body)).toBe("user=sitea&quota=unlimited");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["network", "rejected", "malformed"])("does not retry or leak raw output after %s write", async mode => {
    const fetch = vi.spyOn(globalThis, "fetch");
    if (mode === "network") fetch.mockRejectedValue(new Error("private-upstream"));
    else fetch.mockResolvedValue(new Response(JSON.stringify({ metadata: { result: mode === "rejected" ? 0 : undefined, reason: "private-upstream" } })));
    let error: any;
    try { await new WhmClient(config).setDiskQuota("sitea", 5120); } catch (caught) { error = caught; }
    expect(error.message).toContain("not confirmed");
    expect(error.message).not.toContain("private-upstream");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
