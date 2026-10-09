import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Config } from "./config.js";
import { hasErrors, SoftaculousClient, verifiedAccount } from "./wordpress-setup.js";

const SLUG = "wordpress-mcp-manager/wordpress-mcp-manager.php";
export const wordpressReads = ["get_site_info", "list_wordpress_capabilities", "content_list", "content_get", "media_list", "media_get", "terms_list", "comments_list", "menus_list", "menus_get", "settings_get", "users_list", "users_get", "themes_list", "plugins_list"] as const;
export const wordpressWrites = ["content_create", "content_update", "content_trash", "content_restore", "content_delete", "content_status", "media_upload_base64", "media_update", "media_delete", "terms_create", "terms_update", "terms_delete", "comments_update", "comments_delete", "menus_create", "menus_update", "menus_delete", "settings_update", "users_create", "users_update", "users_delete", "themes_install_base64", "themes_activate", "themes_delete", "plugins_install_base64", "plugins_activate", "plugins_deactivate", "plugins_delete", "maintenance_flush_rewrite", "maintenance_clear_object_cache"] as const;
export const wordpressAccountInput = { username: z.string().regex(/^[a-z][a-z0-9]{0,15}$/) };
export const wordpressParameters = z.record(z.string(), z.unknown()).default({});

async function target(config: Config, username: string) {
  z.object(wordpressAccountInput).strict().parse({ username });
  const account = await verifiedAccount(config, username);
  const domain = z.string().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/).parse(account.domain);
  const client = new SoftaculousClient(config);
  const installations = (await client.installations()).filter(i => new URL(i.url).hostname === domain);
  if (installations.length !== 1 || !/^26_[0-9]+$/.test(installations[0].id)) throw new Error("Exactly one verified WordPress installation is required on the test account's primary domain.");
  const installation = installations[0];
  const base = new URL(installation.url);
  base.protocol = "https:"; base.port = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  // Query-style REST routing also works before WordPress permalinks are enabled.
  const endpoint = new URL("index.php", base);
  endpoint.searchParams.set("rest_route", "/wpmcp/v1/mcp");
  // Domain separation keeps the WHM token private. The derived bearer survives
  // Render restarts without one credential/environment variable per account.
  const token = "wpmcp_" + createHmac("sha256", config.WHM_API_TOKEN).update(JSON.stringify(["pagesurgeai-wordpress-mcp-v1", config.WHM_BASE_URL, config.WHM_USERNAME, username, domain, installation.id])).digest("hex");
  return { client, installation, endpoint, token, domain, username };
}
type Target = Awaited<ReturnType<typeof target>>;

export function sanitizeWordpressResult(value: unknown, token: string): unknown {
  if (Array.isArray(value)) return value.map(v => sanitizeWordpressResult(v, token));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, /password|secret|token|authorization|cookie/i.test(key) ? "[redacted]" : sanitizeWordpressResult(v, token)]));
  return typeof value === "string" ? value.replaceAll(token, "[redacted]") : value;
}

async function tlsAvailable(t: Target, config: Config) {
  try {
    const response = await fetch(t.endpoint, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(config.WHM_TIMEOUT_MS) });
    return (response.status >= 200 && response.status < 300) || [401, 403, 404, 405].includes(response.status);
  } catch { return false; }
}

async function rpc(config: Config, t: Target, name: string, args: Record<string, unknown> = {}) {
  // Probe without credentials first. Never send bearer credentials to HTTP,
  // follow a redirect, disable TLS validation, or retry a write automatically.
  if (!await tlsAvailable(t, config)) throw new Error("WordPress HTTPS is unavailable or redirects. Install a valid SSL certificate before connecting; no Bearer token was transmitted and no WordPress prompt action was made.");
  let response: Response;
  try {
    response = await fetch(t.endpoint, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(config.WHM_TIMEOUT_MS) });
  } catch { throw new Error("WordPress MCP request was not confirmed. Inspect current state before retrying a write."); }
  if (!response.ok) throw new Error(`WordPress MCP returned HTTP ${response.status}. Check HTTPS, plugin activation, token configuration and Authorization header forwarding. Do not retry a write automatically.`);
  let body: any;
  try { body = await response.json(); } catch { throw new Error("WordPress MCP returned an unrecognized response. Inspect state before retrying."); }
  if (body?.id !== 1 || body?.jsonrpc !== "2.0" || body.error || !body.result || body.result.isError) throw new Error("WordPress MCP did not confirm the operation. Inspect the site before retrying.");
  const result = sanitizeWordpressResult(body.result.structuredContent ?? body.result, t.token) as Record<string, unknown>;
  if (name === "get_site_info") {
    let site: URL;
    try { site = new URL(String(result.url)); } catch { throw new Error("WordPress site identity was not verified."); }
    if (site.hostname !== t.domain || site.pathname !== new URL(t.installation.url).pathname || result.plugin_version !== "2.0.5") throw new Error("WordPress site identity or MCP plugin version did not match the configured installation.");
  }
  return result;
}

// ZIP_STORED with CRC32: a small self-contained archive, no subprocess or new
// dependency. It includes only this pinned, user-owned WordPress plugin.
export function pluginZip(files: Record<string, string>) {
  let offset = 0;
  const local: Buffer[] = [], central: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path), data = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt32LE(crc, 16); index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    central.push(index, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function bundle(t: Target) {
  const source = await readFile(new URL("../assets/wordpress-mcp-manager/wordpress-mcp-manager.php", import.meta.url), "utf8");
  const hash = createHash("sha256").update(t.token).digest("hex");
  // Only the hash is shipped over HTTPS cPanel. The admin password is untouched.
  // Never overwrite a previously configured token during activation.
  const bootstrap = `\n// PageSurgeAI gateway bootstrap: derived bearer hash only.\nregister_activation_hook(__FILE__, function () {\n    if (get_option('wpmcp_token_hash')) return;\n    $user = get_user_by('login', 'pagesurgeadmin');\n    if (!$user || !$user->has_cap('manage_options')) wp_die('PageSurgeAI administrator could not be verified.');\n    update_option('wpmcp_token_hash', '${hash}', false);\n    update_option('wpmcp_service_user', $user->ID, false);\n});\nadd_filter('rest_pre_dispatch', function ($result, $server, $request) {\n    if ($request->get_route() === '/wpmcp/v1/mcp' && !is_ssl()) return new WP_Error('https_required', 'HTTPS is required for MCP authentication.', array('status' => 403));\n    return $result;\n}, 10, 3);\n`;
  return pluginZip({ [SLUG]: source + bootstrap });
}

export async function setupWordpressMcp(config: Config, username: string, confirm: true) {
  z.literal(true).parse(confirm);
  const t = await target(config, username);
  if (await tlsAvailable(t, config)) {
    try { const site = await rpc(config, t, "get_site_info"); return { status: "connected", username, domain: t.domain, site }; } catch { /* Read only. Inspect plugin inventory before deciding whether to install. */ }
  }
  const inventory = await t.client.request("wordpress", new URLSearchParams({ insid: t.installation.id, type: "plugins", list: "1" }));
  if (hasErrors(inventory.error) || !inventory.plugins || typeof inventory.plugins !== "object") throw new Error("WordPress plugin inventory was not recognized. No plugin was installed; inspect Softaculous WordPress Manager.");
  // Detect the plugin anywhere in the returned plugin list, without depending
  // on undocumented active/status values or interpreting unknown data as empty.
  if (JSON.stringify(inventory.plugins).includes("wordpress-mcp-manager")) return { status: "existing_plugin_needs_connection", username, domain: t.domain, installed: true, token_configured: "not_verified", connection: "not_verified", next_step: "Verify HTTPS and the existing plugin token; the gateway will not overwrite or rotate an existing token." };
  const form = new FormData();
  form.set("insid", t.installation.id); form.set("type", "plugins"); form.set("activate", "1");
  form.set("custom_file", new Blob([new Uint8Array(await bundle(t))], { type: "application/zip" }), "wordpress-mcp-manager-2.0.5-gateway.zip");
  const response = await t.client.request("wordpress", form);
  if (hasErrors(response.error) || ![true, 1, "1"].includes(response.done)) throw new Error("WordPress MCP installation was not confirmed. Inspect installed plugins before retrying; no token is exposed.");
  if (!await tlsAvailable(t, config)) return { status: "installed_https_required", username, domain: t.domain, plugin_version: "2.0.5", installed: true, activation: "requested", token_configuration: "activation_hook_requested", connection: "blocked_by_https", next_step: "Install a valid SSL certificate, then run setup again to verify the connection. No Bearer token was sent to the public HTTP site." };
  const site = await rpc(config, t, "get_site_info");
  return { status: "connected", username, domain: t.domain, installed: true, token_configured: true, site };
}

export async function wordpressRead(config: Config, username: string, tool: typeof wordpressReads[number], parameters: Record<string, unknown> = {}) {
  z.enum(wordpressReads).parse(tool);
  return rpc(config, await target(config, username), tool, parameters);
}
export async function wordpressWrite(config: Config, username: string, tool: typeof wordpressWrites[number], parameters: Record<string, unknown>, confirm: true) {
  z.enum(wordpressWrites).parse(tool); z.literal(true).parse(confirm);
  // Confirmation is controlled by the gateway, not a nested parameter.
  return rpc(config, await target(config, username), tool, { ...parameters, confirm: true });
}
