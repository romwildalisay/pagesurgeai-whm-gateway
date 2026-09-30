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
  it("serves both metadata locations with Auth0's canonical issuer", async () => {
    const base = await endpoint();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resource: config.OAUTH_AUDIENCE,
        authorization_servers: ["https://tenant.example.test/"], scopes_supported: ["whm:read"] });
    }
  });
  it("does not confuse process health with completed OAuth or WHM checks", async () => {
    const base = await endpoint();
    const body = await (await fetch(base + "/health")).json();
    expect(body.checks).toEqual({ process: "ok", oauth_link: "not_checked", whm: "not_checked" });
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
      expect(body.result.isError).toBe(true);
      expect(body.result._meta["mcp/www_authenticate"][0]).toContain('scope="whm:read"');
      expect(whm).not.toHaveBeenCalled();
    }
  );
});
