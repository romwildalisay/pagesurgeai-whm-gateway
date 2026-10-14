import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { WhmClient } from "./whm-client.js";
import * as archive from "./ssl-archive.js";
import * as dns from "node:dns/promises";
import * as tls from "node:tls";
import { EventEmitter } from "node:events";
import { getBandwidth, setAccountBandwidth, validateAccountSslZip, installAccountSslZip, probePublicSsl } from "./account-management.js";

vi.mock("node:dns/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:dns/promises")>(), lookup: vi.fn() }));
vi.mock("node:tls", async importOriginal => ({ ...await importOriginal<typeof import("node:tls")>(), connect: vi.fn() }));

const config: Config = { WHM_BASE_URL: "https://whm.example.test:2087", WHM_USERNAME: "reseller", WHM_API_TOKEN: "a".repeat(32), PUBLIC_BASE_URL: "https://gateway.example.test", OAUTH_ISSUER: "https://tenant.example.test", OAUTH_AUDIENCE: "gateway", OAUTH_SCOPE: "whm:read", PORT: 3000, WHM_TIMEOUT_MS: 1000 };
const target = { username: "sitea", domain: "example.com" };
const account = { data: { acct: [{ user: "sitea", domain: "example.com", owner: "reseller" }] } };
const bandwidth = (limit: number, used = 1) => ({ data: { acct: [{ user: "sitea", maindomain: "example.com", limit: limit * 1024 * 1024, totalbytes: used * 1024 * 1024 }], month: 10, year: 2026 } });
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("Account bandwidth", () => {
  it("reads byte-based WHM limits as MB and filters exact account", async () => {
    const call = vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account).mockResolvedValueOnce(bandwidth(2048));
    expect(await getBandwidth(config, target)).toMatchObject({ limit_mb: 2048, used_mb: 1, month: 10 });
    expect(call.mock.calls[1]).toEqual(["showbw", { search: "^sitea$", searchtype: "user" }]);
  });
  it("sets one account and independently verifies read-back", async () => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account).mockResolvedValueOnce(bandwidth(1024)).mockResolvedValueOnce(account).mockResolvedValueOnce(account).mockResolvedValueOnce(bandwidth(2048));
    const write = vi.spyOn(WhmClient.prototype, "setBandwidth").mockResolvedValue({ data: { bwlimits: [{ domains: ["example.com"], bwlimit: 2048, unlimited: 0 }] } });
    expect(await setAccountBandwidth(config, { ...target, limit_mb: 2048, confirm: true })).toMatchObject({ status: "updated", limit_mb: 2048, previous_limit_mb: 1024, package_changed: false });
    expect(write).toHaveBeenCalledExactlyOnceWith("sitea", 2048);
  });
  it("does not write when already at the requested limit", async () => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account).mockResolvedValueOnce(bandwidth(2048));
    const write = vi.spyOn(WhmClient.prototype, "setBandwidth");
    expect(await setAccountBandwidth(config, { ...target, limit_mb: 2048, confirm: true })).toMatchObject({ status: "already_set", changes_made: false }); expect(write).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 1_000_000_001])("rejects invalid or accidentally unlimited quota %s", async limit => {
    const read = vi.spyOn(WhmClient.prototype, "call");
    await expect(setAccountBandwidth(config, { ...target, limit_mb: limit, confirm: true })).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it("requires explicit acceptance before reducing below usage", async () => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account).mockResolvedValueOnce(bandwidth(4096, 3000));
    const write = vi.spyOn(WhmClient.prototype, "setBandwidth");
    await expect(setAccountBandwidth(config, { ...target, limit_mb: 2048, confirm: true })).rejects.toThrow("below current usage"); expect(write).not.toHaveBeenCalled();
  });
  it.each(["owner", "domain"])("blocks mismatched %s before writes", async field => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValue({ data: { acct: [{ ...account.data.acct[0], [field]: "other" }] } });
    const write = vi.spyOn(WhmClient.prototype, "setBandwidth");
    await expect(setAccountBandwidth(config, { ...target, limit_mb: 2048, confirm: true })).rejects.toThrow(); expect(write).not.toHaveBeenCalled();
  });
  it("reports a partial result without retrying a failed read-back", async () => {
    const read = vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account).mockResolvedValueOnce(bandwidth(1024)).mockResolvedValueOnce(account).mockRejectedValueOnce(new Error("unavailable"));
    const write = vi.spyOn(WhmClient.prototype, "setBandwidth").mockResolvedValue({ data: { bwlimits: [{ domains: ["example.com"], bwlimit: 2048, unlimited: 0 }] } });
    expect(await setAccountBandwidth(config, { ...target, limit_mb: 2048, confirm: true })).toMatchObject({ status: "change_not_verified" }); expect(write).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(4);
  });
  it("uses authenticated POST and an explicit unlimited value", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ metadata: { result: 1 } })));
    await new WhmClient(config).setBandwidth("sitea", "unlimited");
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://whm.example.test:2087/json-api/limitbw?api.version=1");
    expect(options?.method).toBe("POST"); expect(options?.redirect).toBe("error"); expect(String(options?.body)).toBe("user=sitea&bwlimit=unlimited");
  });
  it("never retries an uncertain bandwidth write or leaks upstream responses", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sensitive-upstream"));
    await expect(new WhmClient(config).setBandwidth("sitea", 2048)).rejects.toThrow("not confirmed"); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Private SSL installation", () => {
  const parsed = { certificate: "CERTIFICATE-PRIVATE-RESPONSE", privateKey: "PRIVATE-KEY-SECRET", caBundle: "CA-BUNDLE", summary: { fingerprint_sha256: "SAFE-FINGERPRINT", valid_from: "2026", expires_at: "2027", domain_matches: true, key_matches: true, chain_verified: true, revocation_checked: false, intermediate_count: 1 } };
  const input = { ...target, zip_base64: "c2FmZQ==" };
  it("validates ownership without writes and returns no private material", async () => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account).mockResolvedValueOnce({ metadata: { result: 1 }, data: { user: "sitea" } });
    vi.spyOn(archive, "validateSslArchive").mockReturnValue(parsed);
    const write = vi.spyOn(WhmClient.prototype, "installSsl");
    const state = await validateAccountSslZip(config, input);
    expect(state).toMatchObject({ status: "validated", changes_made: false }); expect(JSON.stringify(state)).not.toContain("PRIVATE"); expect(write).not.toHaveBeenCalled();
  });
  it("rejects a domain owned by another account without installing", async () => {
    vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account).mockResolvedValueOnce({ metadata: { result: 1 }, data: { user: "other" } });
    vi.spyOn(archive, "validateSslArchive").mockReturnValue(parsed);
    const write = vi.spyOn(WhmClient.prototype, "installSsl");
    await expect(installAccountSslZip(config, { ...input, confirm: true })).rejects.toThrow("belonging"); expect(write).not.toHaveBeenCalled();
  });
  it("installs only after ownership checks and reports failed public DNS separately", async () => {
    const reads = vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce(account).mockResolvedValueOnce({ metadata: { result: 1 }, data: { user: "sitea" } });
    vi.spyOn(archive, "validateSslArchive").mockReturnValue(parsed);
    vi.mocked(dns.lookup).mockRejectedValue(new Error("DNS not ready"));
    const write = vi.spyOn(WhmClient.prototype, "installSsl").mockResolvedValue({ confirmed: true });
    const result = await installAccountSslZip(config, { ...input, confirm: true });
    expect(result).toMatchObject({ status: "installed", public_tls: { https_verified: false }, private_key_returned: false });
    expect(reads.mock.invocationCallOrder[1]).toBeLessThan(write.mock.invocationCallOrder[0]); expect(write).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain("PRIVATE-KEY-SECRET");
  });
  it("revalidates an invalid archive before any install", async () => {
    const write = vi.spyOn(WhmClient.prototype, "installSsl");
    await expect(installAccountSslZip(config, { ...input, confirm: true })).rejects.toThrow("Invalid SSL ZIP"); expect(write).not.toHaveBeenCalled();
  });
  it("transmits PEMs only in authenticated POST, dropping echoed secrets", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ metadata: { result: 1, output: "PRIVATE-KEY-SECRET" }, data: { status: 1, domain: "example.com", user: "sitea", key: "PRIVATE-KEY-SECRET" } })));
    const state = await new WhmClient(config).installSsl("sitea", "example.com", parsed.certificate, parsed.privateKey, parsed.caBundle);
    const [url, options] = fetch.mock.calls[0]; expect(String(url)).not.toContain("SECRET"); expect(String(url)).toContain("/installssl?api.version=1");
    expect(options?.method).toBe("POST"); expect(options?.redirect).toBe("error"); expect((options?.body as URLSearchParams).get("key")).toBe(parsed.privateKey); expect(state).toEqual({ confirmed: true });
  });
  it.each([0, 1])("fails closed for rejected or mismatched install response %s", async status => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ metadata: { result: 1 }, data: { status, domain: "other.com", user: "other", message: "PRIVATE-KEY-SECRET" } })));
    try { await new WhmClient(config).installSsl("sitea", "example.com", "cert", "PRIVATE-KEY-SECRET", "ca"); throw new Error("should fail"); } catch (error) { expect(String(error)).toContain("not confirmed"); expect(String(error)).not.toContain("SECRET"); }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Public TLS verification", () => {
  it("does not connect to private or mapped addresses", async () => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address:"127.0.0.1",family:4 },{ address:"::ffff:10.0.0.1",family:6 }] as any);
    const connect = vi.mocked(tls.connect);
    expect(await probePublicSsl("example.com")).toMatchObject({ https_verified:false }); expect(connect).not.toHaveBeenCalled();
  });
  it("pins a public IP, uses verified SNI and reports a proxy fingerprint separately", async () => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address:"1.1.1.1",family:4 }] as any);
    const socket = Object.assign(new EventEmitter(), { destroy:vi.fn(), getPeerCertificate:()=>({ fingerprint256:"PUBLIC-PROXY",valid_to:"2027" }) });
    const connect = vi.mocked(tls.connect).mockImplementation(() => { queueMicrotask(()=>socket.emit("secureConnect")); return socket as any; });
    expect(await probePublicSsl("example.com","INSTALLED-CERT")).toMatchObject({ https_verified:true,supplied_certificate_served:false });
    expect(connect).toHaveBeenCalledWith({ host:"1.1.1.1",port:443,servername:"example.com",rejectUnauthorized:true }); expect(socket.destroy).toHaveBeenCalled();
  });
});
