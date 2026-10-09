import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "./config.js";
import { createMcpServer } from "./mcp-server.js";
import { WhmClient } from "./whm-client.js";

const config: Config = {
  WHM_BASE_URL: "https://whm.example.test:2087",
  WHM_USERNAME: "reseller",
  WHM_API_TOKEN: "a".repeat(32),
  PUBLIC_BASE_URL: "https://pagesurgeai-whm-gateway.onrender.com",
  OAUTH_ISSUER: "https://auth.example.test",
  OAUTH_AUDIENCE: "https://pagesurgeai-whm-gateway.onrender.com/mcp",
  OAUTH_SCOPE: "whm:read",
  PORT: 3000,
  WHM_TIMEOUT_MS: 15000
};

afterEach(() => vi.restoreAllMocks());

async function connectedClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config);
  const client = new Client({ name: "gateway-test", version: "0.2.2" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("PageSurgeAI WHM Gateway v0.4.0", () => {
  it.each(["hosting_install_wordpress", "hosting_configure_wordpress_email"])("denies %s without verified WordPress access", async toolName => {
    const read = vi.spyOn(WhmClient.prototype, "call");
    const { client, server } = await connectedClient();
    const response = await client.callTool({ name: toolName, arguments: {
      username: "labsite", domain: "lab.example.com", site_title: "Lab", admin_email: "owner@example.com", confirm: true
    } });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("whm:wordpress");
    expect(read).not.toHaveBeenCalled();
    const tools = await client.listTools();
    expect(tools.tools.find((t) => t.name === "hosting_install_wordpress")?._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["whm:read", "whm:wordpress"] }]);
    await client.close(); await server.close();
  });
  it("denies creation at the MCP boundary without verified creation access", async () => {
    const write = vi.spyOn(WhmClient.prototype, "createAccount");
    const read = vi.spyOn(WhmClient.prototype, "call");
    const { client, server } = await connectedClient();
    const response = await client.callTool({ name: "hosting_create_account", arguments: {
      domain: "lab.example.com", username: "labsite", package: "owner_lab", contact_email: "owner@example.com", confirm: true
    } });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("whm:create");
    expect(write).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });
  it("advertises five read-only tools and three scoped write tools", async () => {
    const { client, server } = await connectedClient();
    const response = await client.listTools();
    expect(response.tools.map((t) => t.name).sort()).toEqual([
      "hosting_configure_wordpress_email",
      "hosting_create_account",
      "hosting_get_account",
      "hosting_get_usage",
      "hosting_get_wordpress_status",
      "hosting_install_wordpress",
      "hosting_list_accounts",
      "hosting_list_packages"
    ]);
    for (const tool of response.tools.filter((t) => !["hosting_create_account", "hosting_install_wordpress", "hosting_configure_wordpress_email"].includes(t.name))) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["whm:read"] }]);
    }
    const creation = response.tools.find((t) => t.name === "hosting_create_account")!;
    expect(creation.annotations?.readOnlyHint).toBe(false);
    expect(creation._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["whm:read", "whm:create"] }]);
    await client.close();
    await server.close();
  });

  it("calls only listaccts for account inventory and returns normalized data", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      metadata: { result: 1 },
      data: { acct: [{ user: "sitea", domain: "example.com", plan: "pagesurge", suspended: 0 }] }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const { client, server } = await connectedClient();
    const response = await client.callTool({ name: "hosting_list_accounts", arguments: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("/json-api/listaccts");
    expect(calledUrl).not.toMatch(/createacct|removeacct|suspendacct/);
    expect(response.structuredContent).toMatchObject({ count: 1, accounts: [{ user: "sitea", domain: "example.com" }] });
    await client.close();
    await server.close();
  });

  it("rejects an invalid cPanel username before calling WHM", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { client, server } = await connectedClient();
    const response = await client.callTool({ name: "hosting_get_account", arguments: { username: "../root" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("blocks non-read-only WHM functions at the client boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const whm = new WhmClient(config);
    await expect(whm.call("createacct", { username: "blocked" })).rejects.toThrow("not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("identifies WHM 403 as upstream rejection rather than an OAuth expiry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const { client, server } = await connectedClient();
    const response = await client.callTool({ name: "hosting_list_packages", arguments: {} });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("WHM returned HTTP 403");
    expect(JSON.stringify(response)).toContain("Reconnecting Auth0 does not repair WHM credentials");
    expect(JSON.stringify(response)).not.toContain(config.WHM_API_TOKEN);
    await client.close();
    await server.close();
  });
});
