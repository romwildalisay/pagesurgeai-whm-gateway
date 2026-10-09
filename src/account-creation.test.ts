import { afterEach, expect, it, vi } from "vitest";
import { createHostingAccount } from "./account-creation.js";
import { WhmClient } from "./whm-client.js";
import type { Config } from "./config.js";

const input = { domain: "lab.example.com", username: "labsite", package: "owner_test", contact_email: "owner@example.com", confirm: true as const };
const config: Config = { WHM_BASE_URL: "https://whm.test:2087", WHM_USERNAME: "owner", WHM_API_TOKEN: "a".repeat(32), PUBLIC_BASE_URL: "https://gateway.test", OAUTH_ISSUER: "https://auth.test", OAUTH_AUDIENCE: "https://gateway.test/mcp", OAUTH_SCOPE: "whm:read", PORT: 3000, WHM_TIMEOUT_MS: 15000 };
afterEach(() => vi.restoreAllMocks());

it("creates only after inventory and package checks, without exposing generated credentials", async () => {
  const whm = new WhmClient(config);
  vi.spyOn(whm, "call").mockResolvedValueOnce({ data: { acct: [] } }).mockResolvedValueOnce({ data: { pkg: [{ name: input.package }] } });
  const create = vi.spyOn(whm, "createAccount").mockResolvedValue({ data: { password: "never-return-this" }, metadata: { result: 1 } });
  const result = await createHostingAccount(whm, input);
  expect(create).toHaveBeenCalledTimes(1);
  const password = create.mock.calls[0][0].password;
  expect(password.length).toBeGreaterThan(32);
  expect(JSON.stringify(result)).not.toContain(password);
  expect(JSON.stringify(result)).not.toContain("never-return-this");
  expect(result.status).toBe("created");
});

it("does not recreate an existing matching account", async () => {
  const whm = new WhmClient(config);
  vi.spyOn(whm, "call").mockResolvedValue({ data: { acct: [{ user: input.username, domain: input.domain, plan: input.package }] } });
  const create = vi.spyOn(whm, "createAccount");
  expect((await createHostingAccount(whm, input)).status).toBe("already_exists");
  expect(create).not.toHaveBeenCalled();
});

it.each(["conflict", "unknown-package", "unverified-inventory"])("blocks %s before any write", async (scenario) => {
  const whm = new WhmClient(config);
  vi.spyOn(whm, "call").mockResolvedValueOnce(scenario === "conflict" ? { data: { acct: [{ user: input.username, domain: "other.example.com" }] } } : scenario === "unverified-inventory" ? {} : { data: { acct: [] } }).mockResolvedValueOnce({ data: { pkg: [] } });
  const create = vi.spyOn(whm, "createAccount");
  await expect(createHostingAccount(whm, input)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it("rejects unconfirmed or invalid input before inventory", async () => {
  const whm = new WhmClient(config);
  const read = vi.spyOn(whm, "call");
  for (const change of [{ confirm: false }, { domain: "../root" }, { username: "root" }]) {
    await expect(createHostingAccount(whm, { ...input, ...change } as any)).rejects.toThrow();
  }
  expect(read).not.toHaveBeenCalled();
});

it("sends credentials in a POST body, never in the URL, and disables shell/reseller access", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ metadata: { result: 1 } })));
  await new WhmClient(config).createAccount({ username: input.username, domain: input.domain, plan: input.package, contactemail: input.contact_email, password: "test-secret" });
  const [url, options] = fetch.mock.calls[0];
  expect(String(url)).not.toContain("test-secret");
  expect(options?.method).toBe("POST");
  expect(options?.redirect).toBe("error");
  expect(String(options?.body)).toContain("hasshell=0");
  expect(String(options?.body)).toContain("reseller=0");
});

it("reports an ambiguous creation timeout without automatically retrying", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timeout", "AbortError"));
  await expect(new WhmClient(config).createAccount({ username: input.username, domain: input.domain, plan: input.package, contactemail: input.contact_email, password: "secret" })).rejects.toThrow("may have completed");
  expect(fetch).toHaveBeenCalledTimes(1);
});
