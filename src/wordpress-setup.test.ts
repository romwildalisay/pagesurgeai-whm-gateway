import { afterEach, expect, it, vi } from "vitest";
import { configureWordpressEmail, installWordpress, SoftaculousClient, wordpressStatus } from "./wordpress-setup.js";
import { WhmClient } from "./whm-client.js";
import type { Config } from "./config.js";

const config: Config = { WHM_BASE_URL: "https://whm.example.test:2087", WHM_USERNAME: "reseller", WHM_API_TOKEN: "a".repeat(32), PUBLIC_BASE_URL: "https://gateway.test", OAUTH_ISSUER: "https://auth.test", OAUTH_AUDIENCE: "https://gateway.test/mcp", OAUTH_SCOPE: "whm:read", PORT: 3000, WHM_TIMEOUT_MS: 15000, CPANEL_USERNAME: "labsite", CPANEL_AUTH_MODE: "password", CPANEL_PASSWORD: "cpanel-private-secret" };
const input = { username: "labsite", domain: "lab.example.com", site_title: "Lab", admin_email: "owner@example.com", confirm: true as const };
function account() { return vi.spyOn(WhmClient.prototype, "call").mockResolvedValue({ data: { acct: [{ user: "labsite", owner: "reseller", email: "account@example.com", domain: input.domain, suspended: 0 }] } }); }
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
  vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ installations: { "26": { "26_1": { softurl: "https://user:secret@lab.example.com/?secret=private", admin_pass: "private", dbpass: "private" } } } });
  const status = await wordpressStatus(config, input.username);
  expect(status.installations).toEqual([{ id: "26_1", url: "https://lab.example.com/" }]);
  expect(JSON.stringify(status)).not.toMatch(/private|secret/);
});

it.each([{}, { installations: { unfamiliar: 1 } }, { error: ["denied"], installations: [] }, { installations: { "26_1": { softurl: "invalid-url" } } }])("fails closed for missing or unverified inventory", async (body) => {
  account();
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue(body);
  await expect(installWordpress(config, input)).rejects.toThrow();
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith("installations");
});

it("does not reinstall WordPress already listed on this domain", async () => {
  account();
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ installations: { "26_1": { softurl: "https://lab.example.com/" } } });
  expect((await installWordpress(config, input)).status).toBe("already_exists");
  expect(api).toHaveBeenCalledTimes(1);
});

it("verifies HTTPS and posts only WordPress install fields without enabling overwrite", async () => {
  account();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValueOnce({ installations: {} }).mockResolvedValueOnce({ done: true }).mockResolvedValueOnce({ done: true, __settings: { admin_pass: "raw-secret" } });
  const result = await installWordpress(config, input);
  const fields = api.mock.calls[2][1]! as URLSearchParams;
  expect(fields.get("softproto")).toBe("3");
  expect(fields.get("softdirectory")).toBe("");
  expect(fields.has("overwrite_existing")).toBe(false);
  expect(fields.has("noemail")).toBe(false);
  expect(api.mock.calls[1][0]).toBe("email");
  expect(api.mock.calls[1][1]?.get("email")).toBe("account@example.com");
  expect(result).toMatchObject({ email: { recipient: "account@example.com", status: "requested", inbox_delivery: "not_verified" } });
  expect(fields.get("admin_pass")!.length).toBeGreaterThan(32);
  expect(JSON.stringify(result)).not.toContain(fields.get("admin_pass"));
  expect(JSON.stringify(result)).not.toContain("raw-secret");
  expect(result.status).toBe("installed");
});

it("blocks an installation when HTTPS is unavailable", async () => {
  account();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("TLS failed"));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ installations: {} });
  await expect(installWordpress(config, input)).rejects.toThrow("HTTPS could not be verified");
  expect(api).toHaveBeenCalledTimes(1);
});

it("uses cPanel Basic authentication only in headers, with HTTPS and redirects disabled", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ installations: {} })));
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
  vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValueOnce({ installations: {} }).mockResolvedValueOnce({ done: true }).mockResolvedValueOnce(body);
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
    .mockImplementation(async () => new Response(JSON.stringify({ installations: {} })));
  const client = new SoftaculousClient(sessionConfig);
  await client.installations();
  await client.installations();
  expect(session).toHaveBeenCalledOnce();
  expect(session).toHaveBeenCalledWith("labsite");
  expect(String(fetch.mock.calls[2][0])).toBe("https://whm.example.test:2083/cpsess123456/frontend/jupiter/softaculous/index.live.php?api=json&act=installations");
  expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
  expect(fetch.mock.calls[2][1]?.headers).toEqual({ Cookie: "cpsession=private-cookie", Accept: "application/json" });
});
it.each(["https://attacker.test:2083/cpsess123456/login/?session=secret", "http://whm.example.test:2083/cpsess123456/login/?session=secret", "https://whm.example.test:2083/untrusted?session=secret"])("rejects unsafe session URLs before sending session secrets", async url => {
  vi.spyOn(WhmClient.prototype, "createCpanelSession").mockResolvedValue(sessionData(url));
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(new SoftaculousClient(sessionConfig).installations()).rejects.toThrow("WHM session activation:");
  expect(fetch).not.toHaveBeenCalled();
});
it("does not follow a session login redirect to another host or expose secrets", async () => {
  vi.spyOn(WhmClient.prototype, "createCpanelSession").mockResolvedValue(sessionData());
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 302, headers: { "set-cookie": "cpsession=private-cookie", location: "https://attacker.test/?private-secret" } }));
  await expect(new SoftaculousClient(sessionConfig).installations()).rejects.toThrow("WHM session activation:");
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

it("activates cPanel sessions through same-origin HTTP 307 redirects while retaining cookies", async () => {
  vi.spyOn(WhmClient.prototype, "createCpanelSession").mockResolvedValue(sessionData());
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("", { status: 307, headers: { location: "/cpsess123456/login/?next=1" } }))
    .mockResolvedValueOnce(new Response("", { status: 302, headers: { "set-cookie": "cpsession=private-cookie; Secure; HttpOnly", location: "/cpsess987654/frontend/jupiter/index.html" } }))
    .mockResolvedValueOnce(new Response("ok"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ installations: {} })));
  expect(await new SoftaculousClient(sessionConfig).installations()).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls[2][1]?.headers).toEqual({ Cookie: "cpsession=private-cookie" });
  expect(String(fetch.mock.calls[3][0])).toContain("/cpsess987654/frontend/jupiter/softaculous/index.live.php");
});

it("does not confuse Softaculous software catalog entries with installation inventory", async () => {
  vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ iscripts: { "26": { name: "WordPress" } } });
  await expect(new SoftaculousClient(config).installations()).rejects.toThrow("inventory could not be verified");
});

it("uses HTTP only for the explicitly authorized temporary test domain while keeping installer requests private", async () => {
  const domain = "mature-yellow-fish.104-219-248-4.cpanel.site";
  vi.spyOn(WhmClient.prototype, "call").mockResolvedValue({ data: { acct: [{ user: "labsite", owner: "reseller", email: "account@example.com", domain, suspended: 0 }] } });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValueOnce({ installations: {} }).mockResolvedValueOnce({ done: true }).mockResolvedValueOnce({ done: true });
  const result = await installWordpress(config, { ...input, domain });
  expect(String(fetch.mock.calls[0][0])).toBe(`http://${domain}/`);
  expect(fetch.mock.calls[0][1]?.headers).toBeUndefined();
  expect(api.mock.calls[2][1]?.get("softproto")).toBe("1");
  expect(result).toMatchObject({ status: "installed", site_url: `http://${domain}/`, admin_url: `http://${domain}/wp-admin/` });
});

it("configures email only to the verified hosting contact without resetting an existing site's password", async () => {
  account();
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValue({ done: true, secret: "private" });
  const result = await configureWordpressEmail(config, "labsite");
  expect(api).toHaveBeenCalledOnce();
  expect(api.mock.calls[0][0]).toBe("email");
  expect(api.mock.calls[0][1]?.get("email")).toBe("account@example.com");
  expect(result).toMatchObject({ status: "configured", existing_credentials_sent: false, recipient: "account@example.com" });
  expect(JSON.stringify(result)).not.toContain("private");
});
it("blocks credential email setup when the contact address is invalid", async () => {
  account().mockResolvedValue({ data: { acct: [{ user: "labsite", owner: "reseller", email: "bad\r\nBcc:third@example.com" }] } });
  const api = vi.spyOn(SoftaculousClient.prototype, "request");
  await expect(configureWordpressEmail(config, "labsite")).rejects.toThrow("valid contact email");
  expect(api).not.toHaveBeenCalled();
});
it("does not install when Softaculous rejects email configuration", async () => {
  account();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
  const api = vi.spyOn(SoftaculousClient.prototype, "request").mockResolvedValueOnce({ installations: {} }).mockResolvedValueOnce({ error: ["private"] });
  await expect(installWordpress(config, input)).rejects.toThrow("email settings were not confirmed");
  expect(api.mock.calls.map(c => c[0])).toEqual(["installations", "email"]);
});
