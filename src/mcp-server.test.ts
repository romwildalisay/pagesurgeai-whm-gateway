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
  GATEWAY_API_KEY: "b".repeat(32),
  PORT: 3000,
  WHM_TIMEOUT_MS: 15000
};

afterEach(() => vi.restoreAllMocks());

async function connectedClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config);
  const client = new Client({ name: "gateway-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("PageSurgeAI WHM Gateway v0.1", () => {
  it("advertises exactly four read-only tools", async () => {
    const { client, server } = await connectedClient();
    const response = await client.listTools();
    expect(response.tools.map((t) => t.name).sort()).toEqual([
      "hosting_get_account",
      "hosting_get_usage",
      "hosting_list_accounts",
      "hosting_list_packages"
    ]);
    for (const tool of response.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
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
});
