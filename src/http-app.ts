import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp-server.js";
import { createTokenVerifier, type AuthCheck } from "./auth.js";
import { CREATE_SCOPE } from "./account-creation.js";
import { WORDPRESS_SCOPE } from "./wordpress-setup.js";
import { DELETE_SCOPE } from "./destructive-actions.js";
import { BANDWIDTH_SCOPE, SSL_SCOPE } from "./account-management.js";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.js";

export function createGatewayApp(config: Config, verifier?: (value: string | undefined, requiredScopes?: string[]) => Promise<AuthCheck>) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const verifyAuthorization = verifier ?? createTokenVerifier(config);
  const resourceMetadataUrl = `${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp`;
  const authChallenge = `Bearer resource_metadata="${resourceMetadataUrl}", scope="${config.OAUTH_SCOPE}"`;

  const openssl = spawnSync("openssl", ["version"], { timeout: 2000, maxBuffer: 1024, shell: false });
  const sslValidatorReady = openssl.status === 0 && /^OpenSSL 3\./.test(openssl.stdout?.toString() ?? "");
  app.get("/health", (_req, res) => res.json({ status: "ok", name: "pagesurgeai-whm-gateway", version: "0.9.3", mode: "account-lifecycle-wordpress-multisite-bandwidth-ssl", auth: "oauth2", checks: { process: "ok", oauth_link: "not_checked", whm: "not_checked", wordpress: "not_checked", ssl_validator: sslValidatorReady ? "ready" : "unavailable" } }));

  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => res.json({
    resource: `${config.PUBLIC_BASE_URL}/mcp`,
    authorization_servers: [`${config.OAUTH_ISSUER}/`],
    scopes_supported: [config.OAUTH_SCOPE, CREATE_SCOPE, WORDPRESS_SCOPE, DELETE_SCOPE, BANDWIDTH_SCOPE, SSL_SCOPE],
    resource_documentation: `${config.PUBLIC_BASE_URL}/health`
  }));

  // Protect the connection handshake as well as tool calls so standard MCP
  // clients receive an HTTP auth challenge before starting the OAuth flow.
  app.all("/mcp", async (req, res, next) => {
    const messages = Array.isArray(req.body) ? req.body : [req.body];
    const creating = messages.some((message) => message?.method === "tools/call" && message?.params?.name === "hosting_create_account");
    const installing = messages.some((message) => message?.method === "tools/call" && ["hosting_install_wordpress", "hosting_configure_wordpress_email", "hosting_setup_wordpress_mcp", "hosting_wordpress_write", "hosting_delete_wordpress", "hosting_reinstall_wordpress"].includes(message?.params?.name));
    const deleting = messages.some(message => message?.method === "tools/call" && ["hosting_delete_account", "hosting_delete_wordpress", "hosting_reinstall_wordpress"].includes(message?.params?.name));
    const bandwidth = messages.some(message => message?.method === "tools/call" && message?.params?.name === "hosting_set_bandwidth");
    const ssl = messages.some(message => message?.method === "tools/call" && ["hosting_validate_ssl_zip", "hosting_install_ssl_zip"].includes(message?.params?.name));
    const scopes = [config.OAUTH_SCOPE, ...(creating ? [CREATE_SCOPE] : []), ...(installing ? [WORDPRESS_SCOPE] : []), ...(deleting ? [DELETE_SCOPE] : []), ...(bandwidth ? [BANDWIDTH_SCOPE] : []), ...(ssl ? [SSL_SCOPE] : [])];
    const auth = await verifyAuthorization(req.header("authorization"), scopes);
    if (!auth.ok) {
      const oauthError = auth.reason === "insufficient_scope" ? "insufficient_scope" : "invalid_token";
      res.setHeader("WWW-Authenticate", `${creating || installing || deleting || bandwidth || ssl ? `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopes.join(" ")}"` : authChallenge}, error="${oauthError}", error_description="Connect PageSurgeAI WHM Gateway to continue"`);
      return res.status(auth.reason === "insufficient_scope" ? 403 : 401).json({
        error: oauthError,
        error_description: "Connect PageSurgeAI WHM Gateway to continue"
      });
    }
    res.locals.canCreate = creating;
    res.locals.canInstall = installing;
    res.locals.canDelete = deleting;
    res.locals.canBandwidth = bandwidth;
    res.locals.canSsl = ssl;
    next();
  });

  app.post("/mcp", async (req, res) => {
    const server = createMcpServer(config, { canCreate: res.locals.canCreate === true, canInstall: res.locals.canInstall === true, canDelete: res.locals.canDelete === true, canBandwidth: res.locals.canBandwidth === true, canSsl: res.locals.canSsl === true });
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

