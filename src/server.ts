import crypto from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp-server.js";

const config = loadConfig();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function authorized(value: string | undefined): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(config.GATEWAY_API_KEY);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

app.get("/health", (_req, res) => res.json({ status: "ok", name: "pagesurgeai-whm-gateway", version: "0.1.0", mode: "read-only" }));

app.post("/mcp", async (req, res) => {
  if (!authorized(req.header("authorization"))) return res.status(401).json({ error: "unauthorized" });
  const server = createMcpServer(config);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.all("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));

app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: "gateway_error", message: "The request could not be completed." });
});

app.listen(config.PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "gateway_started", port: config.PORT, version: "0.1.0", mode: "read-only" }));
});
