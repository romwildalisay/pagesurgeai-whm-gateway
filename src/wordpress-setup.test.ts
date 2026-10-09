import { afterEach, expect, it, vi } from "vitest";
import { installWordpress, SoftaculousClient, wordpressStatus } from "./wordpress-setup.js";
import { WhmClient } from "./whm-client.js";
import type { Config } from "./config.js";

const config: Config = { WHM_BASE_URL: "https://whm.example.test:2087", WHM_USERNAME: "reseller", WHM_API_TOKEN: "a".repeat(32), PUBLIC_BASE_URL: "https://gateway.test", OAUTH_ISSUER: "https://auth.test", OAUTH_AUDIENCE: "https://gateway.test/mcp", OAUTH_SCOPE: "whm:read", PORT: 3000, WHM_TIMEOUT_MS: 15000, CPANEL_USERNAME: "labsite", CPANEL_AUTH_MODE: "password", CPANEL_PASSWORD: "cpanel-private-secret" };
const input = { username: "labsite", domain: "lab.example.com", site_title: "Lab", admin_email: "owner@example.com", confirm: true as const };
function account() { return vi.spyOn(WhmClient.prototype, "call").mockResolvedValue({ data: { acct: [{ user: "labsite", owner: "reseller", domain: input.domain, suspended: 0 }] } }); }
afterEach(() => vi.restoreAllMocks());

it("requires explicit confirmation and restricts the account, domain, and owner before any installer write", async () => {
  const write = vi.spyOn(SoftaculousClient.prototype, "request");
  const whm = account();
  await expect(installWordpress(config, { ...input, confirm: false } as any)).rejects.toThrow();
  await expect(installWordpress(config, { ...input, username: "otheruser" })).rejects.toThrow("restricted");
  await expect(installWordpress(config, { ...input, domain: "other.example.com" })).rejects.toThrow("does not match");
  whm.mockResolvedValue({ data: { acct: [{ user: "labsite", owner: "other", domain: input.domain }] } });
  await expect(installWordpress(config, input)).rejects.toThrow("reseller-owned");
  expect(write).not.toHaveBeenCalled();
});

it("lists nested and flat WordPress entries without returning stored secrets or URL credentials", async () => {
  account();
  vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ iscripts: { "26": { "26_1": { softurl: "https://user:secret@lab.example.com/?secret=private", admin_pass: "private", dbpass: "private" } } } });
  const status = await wordpressStatus(config, input.username);
  expect(status.installations).toEqual([{ id: "26_1", url: "https://lab.example.com/" }]);
  expect(JSON.stringify(status)).not.toMatch(/private|secret/);
});

it.each([{}, { iscripts: { unfamiliar: 1 } }, { error: ["denied"], iscripts: [] }, { iscripts: { "26_1": { softurl: "invalid-url" } } }])("fails closed for missing or unverified inventory", async (body) => {
  account();
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue(body);
  await expect(installWordpress(config, input)).rejects.toThrow();
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith("installations");
});

it("does not reinstall WordPress already listed on this domain", async () => {
  account();
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ iscripts: { "26_1": { softurl: "https://lab.example.com/" } } });
  expect((await installWordpress(config, input)).status).toBe("already_exists");
  expect(api).toHaveBeenCalledTimes(1);
});

it("verifies HTTPS and posts only WordPress install fields without enabling overwrite", async () => {
  account();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValueOnce({ iscripts: {} }).mockResolvedValueOnce({ done: true, __settings: { admin_pass: "raw-secret" } });
  const result = await installWordpress(config, input);
  const fields = api.mock.calls[1][1]!;
  expect(fields.get("softproto")).toBe("3");
  expect(fields.get("softdirectory")).toBe("");
  expect(fields.has("overwrite_existing")).toBe(false);
  expect(fields.get("admin_pass")!.length).toBeGreaterThan(32);
  expect(JSON.stringify(result)).not.toContain(fields.get("admin_pass"));
  expect(JSON.stringify(result)).not.toContain("raw-secret");
  expect(result.status).toBe("installed");
});

it("blocks an installation when HTTPS is unavailable", async () => {
  account();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS failed"));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ iscripts: {} });
  await expect(installWordpress(config, input)).rejects.toThrow("HTTPS could not be verified");
  expect(api).toHaveBeenCalledTimes(1);
});

it("uses cPanel Basic authentication only in headers, with HTTPS and redirects disabled", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ iscripts: {} })));
  await new SoftaculousClient(config).installations();
  const [url, options] = fetch.mock.calls[0];
  expect(String(url)).toBe("https://whm.example.test:2083/frontend/jupiter/softaculous/index.live.php?api=json&act=installations");
  expect(String(url)).not.toContain(config.CPANEL_PASSWORD);
  expect(options?.redirect).toBe("error");
  expect((options?.headers as any).Authorization).toBe(`Basic ${Buffer.from("labsite:cpanel-private-secret").toString("base64")}`);
});

it("does not call cPanel without private configuration", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(new SoftaculousClient({ ...config, CPANEL_PASSWORD: undefined }).installations()).rejects.toThrow("not configured");
  expect(fetch).not.toHaveBeenCalled();
});

it("reports write uncertainty without retrying or leaking the thrown error", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("private-secret"));
  await expect(new SoftaculousClient(config).request("software", new URLSearchParams())).rejects.toThrow("may have completed");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([{ done: false }, { done: true, setupcontinue: "more" }, { error: ["secret"] }])("does not claim success from an unsuccessful or partial installation response", async (body) => {
  account();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
  vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValueOnce({ iscripts: {} }).mockResolvedValueOnce(body);
  await expect(installWordpress(config, input)).rejects.toThrow();
});

it("distinguishes a Softaculous-specific rejection from working cPanel API authentication", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("denied", { status: 403 })).mockResolvedValueOnce(new Response(JSON.stringify({ result: { status: 1, data: { user: "labsite", private: "secret" } } })));
  await expect(new SoftaculousClient(config).installations()).rejects.toThrow("same credentials succeeded");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1][0])).toContain("/execute/Variables/get_user_information?name=user");
  expect(fetch.mock.calls[1][1]?.method).toBe("GET");
});

it("reports an upstream UAPI policy rejection without assuming the password is wrong", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("denied", { status: 401 })).mockResolvedValueOnce(new Response("denied", { status: 403 }));
  await expect(new SoftaculousClient(config).installations()).rejects.toThrow("UAPI also returned HTTP 403");
});

it("never performs authentication diagnostics or retries following a rejected write", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status: 403 }));
  await expect(new SoftaculousClient(config).request("software", new URLSearchParams())).rejects.toThrow("No installation was confirmed");
  expect(fetch).toHaveBeenCalledTimes(1);
});

const sessionConfig: Config = { ...config, CPANEL_AUTH_MODE: undefined, CPANEL_PASSWORD: undefined };
function sessionData(url = "https://whm.example.test:2083/cpsess123456/login/?session=private-login-secret") {
  return { url, cp_security_token: "/cpsess123456" };
}
it("uses the existing WHM token for a temporary test-account session without cPanel passwords", async () => {
  const session = vi.spyOn(WhmClient.prototype, "createCpanelSession").mockResolvedValue(sessionData());
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("", { status: 302, headers: { "set-cookie": "cpsession=private-cookie; Secure; HttpOnly; Path=/", location: "/cpsess123456/frontend/jupiter/index.html" } }))
    .mockImplementation(async () => new Response(JSON.stringify({ iscripts: {} })));
  const client = new SoftaculousClient(sessionConfig);
  await client.installations();
  await client.installations();
  expect(session).toHaveBeenCalledOnce();
  expect(session).toHaveBeenCalledWith("labsite");
  expect(String(fetch.mock.calls[1][0])).toBe("https://whm.example.test:2083/cpsess123456/frontend/jupiter/softaculous/index.live.php?api=json&act=installations");
  expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
  expect(fetch.mock.calls[1][1]?.headers).toEqual({ Cookie: "cpsession=private-cookie", Accept: "application/json" });
});
it.each(["https://attacker.test:2083/cpsess123456/login/?session=secret", "http://whm.example.test:2083/cpsess123456/login/?session=secret", "https://whm.example.test:2083/untrusted?session=secret"])("rejects unsafe session URLs before sending session secrets", async url => {
  vi.spyOn(WhmClient.prototype, "createCpanelSession").mockResolvedValue(sessionData(url));
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(new SoftaculousClient(sessionConfig).installations()).rejects.toThrow("activated securely");
  expect(fetch).not.toHaveBeenCalled();
});
it("does not follow a session login redirect to another host or expose secrets", async () => {
  vi.spyOn(WhmClient.prototype, "createCpanelSession").mockResolvedValue(sessionData());
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 302, headers: { "set-cookie": "cpsession=private-cookie", location: "https://attacker.test/?private-secret" } }));
  await expect(new SoftaculousClient(sessionConfig).installations()).rejects.toThrow("activated securely");
  expect(fetch).toHaveBeenCalledOnce();
});
it("does not make Softaculous calls when the existing WHM token cannot create a session", async () => {
  vi.spyOn(WhmClient.prototype, "createCpanelSession").mockRejectedValue(new Error("WHM reseller session creation failed. Existing token rejected."));
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(new SoftaculousClient(sessionConfig).installations()).rejects.toThrow("session creation failed");
  expect(fetch).not.toHaveBeenCalled();
});
it("WHM session creation stays restricted and sends only the WHM token to WHM", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ metadata: { result: 1 }, data: sessionData() })));
  const client = new WhmClient(sessionConfig);
  await expect(client.createCpanelSession("otheruser")).rejects.toThrow("restricted");
  expect(fetch).not.toHaveBeenCalled();
  await client.createCpanelSession("labsite");
  expect(String(fetch.mock.calls[0][0])).toContain("/json-api/create_user_session?");
  expect((fetch.mock.calls[0][1]?.headers as any).Authorization).toBe(`whm reseller:${config.WHM_API_TOKEN}`);
  expect(String(fetch.mock.calls[0][0])).toContain("user=labsite");
});
