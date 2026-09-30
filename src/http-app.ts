import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp-server.js";
import { createTokenVerifier, type AuthCheck } from "./auth.js";
import type { Config } from "./config.js";

export function createGatewayApp(config: Config, verifier?: (value: string | undefined) => Promise<AuthCheck>) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const verifyAuthorization = verifier ?? createTokenVerifier(config);
  const resourceMetadataUrl = `${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`;
  const authChallenge = `Bearer resource_metadata="${resourceMetadataUrl}", scope="${config.OAUTH_SCOPE}"`;

  app.get("/health", (_req, res) => res.json({ status: "ok", name: "pagesurgeai-whm-gateway", version: "0.2.2", mode: "read-only", auth: "oauth2", checks: { process: "ok", oauth_link: "not_checked", whm: "not_checked" } }));

  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => res.json({
    resource: `${config.PUBLIC_BASE_URL}/mcp`,
    authorization_servers: [`${config.OAUTH_ISSUER}/`],
    scopes_supported: [config.OAUTH_SCOPE],
    resource_documentation: `${config.PUBLIC_BASE_URL}/health`
  }));

  app.post("/mcp", async (req, res) => {
    if (req.body?.method === "tools/call") {
      const auth = await verifyAuthorization(req.header("authorization"));
      if (!auth.ok) {
        const oauthError = auth.reason === "insufficient_scope" ? "insufficient_scope" : "invalid_token";
        res.setHeader("WWW-Authenticate", `${authChallenge}, error="${oauthError}", error_description="Connect PageSurgeAI WHM Gateway to continue"`);
        return res.status(200).json({
          jsonrpc: "2.0",
          id: req.body?.id ?? null,
          result: {
            content: [{ type: "text", text: "Authentication required. Connect PageSurgeAI WHM Gateway and try again." }],
            isError: true,
            _meta: { "mcp/www_authenticate": [`${authChallenge}, error="${oauthError}", error_description="Connect PageSurgeAI WHM Gateway to continue"`] }
          }
        });
      }
    }
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

  return app;
}

