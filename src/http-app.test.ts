import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGatewayApp } from "./http-app.js";
import type { Config } from "./config.js";
import { WhmClient } from "./whm-client.js";

const config: Config = {
  WHM_BASE_URL: "https://whm.example.test:2087", WHM_USERNAME: "reseller",
  WHM_API_TOKEN: "a".repeat(32), PUBLIC_BASE_URL: "https://gateway.example.test",
  OAUTH_ISSUER: "https://tenant.example.test", OAUTH_AUDIENCE: "https://gateway.example.test/mcp",
  OAUTH_SCOPE: "whm:read", PORT: 3000, WHM_TIMEOUT_MS: 15000
};
const listeners: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(listeners.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
});
async function endpoint(verifier?: Parameters<typeof createGatewayApp>[1]) {
  const server = createGatewayApp(config, verifier).listen(0, "127.0.0.1");
  listeners.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("HTTP OAuth boundary", () => {
  it("requires a separate WordPress permission before installation", async () => {
    const fetchSpy = vi.spyOn(WhmClient.prototype, "call");
    const verify = vi.fn(async () => ({ ok: false as const, reason: "insufficient_scope" as const }));
    const base = await endpoint(verify);
    const response = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hosting_install_wordpress", arguments: {} }
    }) });
    expect(response.status).toBe(403);
    expect(verify).toHaveBeenCalledWith(undefined, ["whm:read", "whm:wordpress"]);
    expect(response.headers.get("www-authenticate")).toContain('scope="whm:read whm:wordpress"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("allows an authorized creation request through HTTP and returns only safe fields", async () => {
    const read = vi.spyOn(WhmClient.prototype, "call").mockResolvedValueOnce({ data: { acct: [] } }).mockResolvedValueOnce({ data: { pkg: [{ name: "owner_lab" }] } });
    const write = vi.spyOn(WhmClient.prototype, "createAccount").mockResolvedValue({ metadata: { result: 1, output: { raw: "sensitive-secret" } } });
    const verify = vi.fn(async () => ({ ok: true as const, subject: "authorized-user" }));
    const base = await endpoint(verify);
    const response = await fetch(base + "/mcp", { method: "POST", headers: {
      authorization: "Bearer authorized-token", "content-type": "application/json", accept: "application/json, text/event-stream"
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "hosting_create_account", arguments: { domain: "lab.example.com", username: "labsite", package: "owner_lab", contact_email: "owner@example.com", confirm: true }
    } }) });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"status":"created"');
    expect(body).not.toContain("sensitive-secret");
    expect(body).not.toContain(write.mock.calls[0][0].password);
    expect(verify).toHaveBeenCalledWith("Bearer authorized-token", ["whm:read", "whm:create"]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("requires both scopes before a creation call can reach WHM", async () => {
    const whm = vi.spyOn(WhmClient.prototype, "createAccount");
    const verify = vi.fn(async (_value: string | undefined, _scopes?: string[]) => ({ ok: false as const, reason: "insufficient_scope" as const }));
    const base = await endpoint(verify);
    const response = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hosting_create_account", arguments: {} } }) });
    expect(verify).toHaveBeenCalledWith(undefined, ["whm:read", "whm:create"]);
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('scope="whm:read whm:create"');
    expect(whm).not.toHaveBeenCalled();
  });
  it.each(["GET", "POST"])("challenges unauthenticated %s connection probes", async (method) => {
    const base = await endpoint(async () => ({ ok: false, reason: "missing_token" }));
    const response = await fetch(base + "/mcp", { method,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) } : {}) });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('/.well-known/oauth-protected-resource/mcp');
  });
  it("allows authenticated initialization without querying WHM", async () => {
    const whm = vi.spyOn(WhmClient.prototype, "call");
    const verify = vi.fn(async () => ({ ok: true as const, subject: "test-user" }));
    const base = await endpoint(verify);
    const response = await fetch(base + "/mcp", { method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('serverInfo');
    expect(verify).toHaveBeenCalledWith("Bearer test-token", ["whm:read"]);
    expect(whm).not.toHaveBeenCalled();
  });
  it("serves both metadata locations with Auth0's canonical issuer", async () => {
    const base = await endpoint();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resource: config.OAUTH_AUDIENCE,
        authorization_servers: ["https://tenant.example.test/"], scopes_supported: ["whm:read", "whm:create", "whm:wordpress"] });
    }
  });
  it("does not confuse process health with completed OAuth or WHM checks", async () => {
    const base = await endpoint();
    const body = await (await fetch(base + "/health")).json();
    expect(body.checks).toEqual({ process: "ok", oauth_link: "not_checked", whm: "not_checked", wordpress: "not_checked" });
    expect(JSON.stringify(body)).not.toContain(config.WHM_API_TOKEN);
  });
  it.each(["missing_token", "invalid_token", "insufficient_scope"] as const)(
    "blocks %s without calling WHM and returns the OAuth challenge", async (reason) => {
      const whm = vi.spyOn(WhmClient.prototype, "call");
      const base = await endpoint(async () => ({ ok: false, reason }));
      const response = await fetch(base + "/mcp", { method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "hosting_list_packages", arguments: {} } }) });
      const expected = reason === "insufficient_scope" ? "insufficient_scope" : "invalid_token";
      expect(response.headers.get("www-authenticate")).toContain(`error="${expected}"`);
      const body = await response.json();
      expect(response.status).toBe(reason === "insufficient_scope" ? 403 : 401);
      expect(body.error).toBe(expected);
      expect(whm).not.toHaveBeenCalled();
    }
  );
});
