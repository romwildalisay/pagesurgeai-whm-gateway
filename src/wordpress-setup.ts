import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import { extractAccounts, WhmClient } from "./whm-client.js";

export const WORDPRESS_SCOPE = "whm:wordpress";
export const wordpressInput = {
  username: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
  domain: z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  site_title: z.string().trim().min(1).max(120),
  admin_email: z.string().trim().email().max(254),
  confirm: z.literal(true)
};
const schema = z.object(wordpressInput).strict();
type InstallRequest = z.infer<typeof schema>;
type Installation = { id: string; url: string };

export class SoftaculousClient {
  constructor(private readonly config: Config) {}
  private session?: { token: string; cookie: string };
  private async whmSession(origin: string) {
    if (this.session) return this.session;
    if (!this.config.CPANEL_USERNAME) throw new Error("WordPress setup is not configured. Set CPANEL_USERNAME to the test account; no cPanel password is required for WHM session authentication.");
    try {
      const data = await new WhmClient(this.config).createCpanelSession(this.config.CPANEL_USERNAME);
      const url = new URL(data.url);
      let token = data.cp_security_token;
      if (url.origin !== origin || url.username || url.password) throw new Error("WHM session activation: login URL did not match the configured HTTPS cPanel origin.");
      if (!/^\/cpsess[0-9]+$/.test(token) || !url.pathname.startsWith(`${token}/login`)) throw new Error("WHM session activation: session token or login path format was not recognized.");
      let current = url;
      const cookies = new Map<string, string>();
      for (let hop = 0; hop < 5; hop++) {
        const response = await fetch(current, { method: "GET", redirect: "manual",
          headers: cookies.size ? { Cookie: [...cookies.values()].join("; ") } : {}, signal: AbortSignal.timeout(this.config.WHM_TIMEOUT_MS) });
        if (response.status !== 200 && ![302, 303, 307, 308].includes(response.status)) throw new Error(`WHM session activation: cPanel login returned HTTP ${response.status}.`);
        for (const value of response.headers.getSetCookie()) {
          const pair = value.split(";", 1)[0];
          if (/^[A-Za-z0-9_-]+=[^\r\n;]+$/.test(pair)) cookies.set(pair.slice(0, pair.indexOf("=")), pair);
        }
        const location = response.headers.get("location");
        if (response.status !== 200) {
          if (!location) throw new Error("WHM session activation: cPanel login redirect had no destination.");
          const target = new URL(location, current);
          const match = target.pathname.match(/^(\/cpsess[0-9]+)\//);
          if (target.origin !== origin || target.username || target.password || !match) throw new Error("WHM session activation: login redirected outside the expected cPanel session path.");
          token = match[1];
          current = target;
          continue;
        }
        // Cookies stay in this request's instance and are sent only to the
        // validated HTTPS cPanel origin, never to WHM or an external redirect.
        if (![...cookies.keys()].some(name => /session$/i.test(name))) throw new Error("WHM session activation: cPanel did not return a usable session cookie.");
        this.session = { token, cookie: [...cookies.values()].join("; ") };
        return this.session;
      }
      throw new Error("WHM session activation: cPanel login exceeded the safe redirect limit.");
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("WHM reseller session creation failed") || error.message.startsWith("WHM session activation:"))) throw error;
      throw new Error("WHM reseller session could not be activated securely. No Softaculous request was made; no hosting changes were made.");
    }
  }
  private credentials() {
    if (!this.config.CPANEL_USERNAME || !this.config.CPANEL_PASSWORD) throw new Error("WordPress setup is not configured. Set CPANEL_USERNAME and CPANEL_PASSWORD privately in Render; never send passwords in chat.");
    return { username: this.config.CPANEL_USERNAME, password: this.config.CPANEL_PASSWORD };
  }
  private async authenticationDiagnostic(origin: string): Promise<string> {
    const credentials = this.credentials();
    const url = new URL("/execute/Variables/get_user_information", origin);
    url.searchParams.set("name", "user");
    try {
      const response = await fetch(url, { method: "GET", redirect: "error",
        headers: { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`, Accept: "application/json" },
        signal: AbortSignal.timeout(5000) });
      if (response.status === 401 || response.status === 403) return `cPanel's read-only UAPI also returned HTTP ${response.status}. Check server-side API access/IP/security policies; a correct browser password alone does not prove API access from Render.`;
      if (!response.ok) return `The read-only UAPI check returned HTTP ${response.status}; authentication could not be verified.`;
      const body = await response.json();
      if (body?.result?.status === 1) return "The same credentials succeeded on cPanel's read-only UAPI. The rejection is specific to the Softaculous endpoint or its access policy, not evidence of an incorrect password.";
      return "The read-only UAPI response did not confirm successful authentication.";
    } catch { return "The read-only UAPI authentication check could not be completed securely."; }
  }
  async request(action: "installations" | "software" | "email" | "wordpress", params?: URLSearchParams | FormData): Promise<any> {
    const url = new URL(this.config.WHM_BASE_URL);
    url.port = "2083";
    url.pathname = "/frontend/jupiter/softaculous/index.live.php";
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    url.searchParams.set("api", "json"); url.searchParams.set("act", action);
    if (action === "software") url.searchParams.set("soft", "26");
    if (action === "wordpress" && params instanceof FormData) url.searchParams.set("upload", "1");
    const writing = action === "software" || params !== undefined;
    const passwordMode = this.config.CPANEL_AUTH_MODE === "password";
    let headers: Record<string, string>;
    if (passwordMode) {
      const credentials = this.credentials();
      headers = { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`, Accept: "application/json" };
    } else {
      const session = await this.whmSession(url.origin);
      url.pathname = `${session.token}${url.pathname}`;
      headers = { Cookie: session.cookie, Accept: "application/json" };
    }
    try {
      const response = await fetch(url, { method: writing ? "POST" : "GET", redirect: "error",
        headers,
        ...(writing ? { body: params } : {}), signal: AbortSignal.timeout(this.config.WHM_TIMEOUT_MS) });
      if (response.status === 401 || response.status === 403) {
        const diagnostic = writing ? "No installation was confirmed. Check inventory before retrying." : passwordMode ? await this.authenticationDiagnostic(url.origin) : "The WHM session was rejected by the Softaculous endpoint. No installation was started.";
        throw new Error(`cPanel rejected Softaculous authentication with HTTP ${response.status} at ${url.origin} for ${this.config.CPANEL_USERNAME}. ${diagnostic} Reconnecting Auth0 does not fix this upstream rejection.`);
      }
      if (!response.ok && action === "wordpress") throw new Error("WordPress Manager operation was not confirmed. Inspect installed plugins before retrying.");
      if (!response.ok && action === "email") throw new Error("Softaculous email settings could not be confirmed. No installation was started.");
      if (!response.ok) throw new Error(writing ? "WordPress installation could not be confirmed. Inspect Softaculous before retrying." : "Softaculous inventory is unavailable.");
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Softaculous response was not recognized. Inspect WordPress Manager before retrying.");
      return body;
    } catch (error) {
      if (action === "wordpress") throw new Error("WordPress Manager operation was not confirmed. Inspect installed plugins before retrying; do not assume the upload failed.");
      if (error instanceof Error && /^(cPanel rejected|WordPress installation could|Softaculous inventory|Softaculous response|Softaculous email)/.test(error.message)) throw error;
      if (action === "email") throw new Error("Softaculous email settings could not be confirmed. Inspect email settings before retrying; no installation was started.");
      throw new Error(writing ? "WordPress installation could not be confirmed; it may have completed. Inspect Softaculous before retrying." : "Cannot read Softaculous securely. Verify HTTPS on the cPanel server and test account credentials.");
    }
  }
  async installations(): Promise<Installation[]> {
    const body = await this.request("installations");
    if (hasErrors(body.error)) throw new Error("Softaculous reported an API error while reading inventory. No installation was started.");
    if (!body.installations || typeof body.installations !== "object") throw new Error(`Softaculous installation inventory could not be verified (installations: ${body.installations === null ? "null" : typeof body.installations}). No installation was started.`);
    const installations: Installation[] = [];
    // Support flat installation IDs and per-script groups. Fail closed if a
    // nonempty inventory has an unfamiliar structure; never infer it is empty.
    function inspect(value: any, key: string, wordpress: boolean, depth: number): number {
      if (!value || typeof value !== "object" || depth > 4) return 0;
      const isWordpress = wordpress || key === "26" || key.startsWith("26_") || String(value.sid ?? value.soft ?? "") === "26";
      if (typeof value.softurl === "string") {
        if (isWordpress) {
          let url: URL;
          try { url = new URL(value.softurl); } catch { throw new Error("Softaculous inventory contains an invalid site URL. No installation was started."); }
          if (!["https:", "http:"].includes(url.protocol)) throw new Error("Softaculous inventory contains an unsupported site URL. No installation was started.");
          installations.push({ id: String(value.insid ?? value.ins_id ?? key), url: `${url.origin}${url.pathname}` });
        }
        return 1;
      }
      return Object.entries(value).reduce((count, [childKey, child]) => count + inspect(child, childKey, isWordpress, depth + 1), 0);
    }
    const recognized = inspect(body.installations, "", false, 0);
    if (Object.keys(body.installations).length && !recognized) throw new Error("Softaculous inventory format was not recognized. Inspect WordPress Manager; no installation was started.");
    return installations;
  }
}

export function hasErrors(value: unknown) {
  return value != null && value !== false && value !== "" && (typeof value !== "object" || Object.keys(value).length > 0);
}

export async function verifiedAccount(config: Config, username: string) {
  if (username !== config.CPANEL_USERNAME) throw new Error("WordPress setup is restricted to the cPanel test account configured in Render.");
  const accounts = extractAccounts(await new WhmClient(config).call("accountsummary", { user: username }));
  const account = accounts.find((a) => a.user === username && a.owner === config.WHM_USERNAME);
  if (!account || Number(account.suspended)) throw new Error("An active reseller-owned test account could not be verified.");
  return account;
}

function installationForDomain(installations: Installation[], domain: string) {
  return installations.filter((installation) => {
    try { const url = new URL(installation.url); return url.hostname.toLowerCase() === domain; } catch { return false; }
  });
}

export async function wordpressStatus(config: Config, username: string) {
  const account = await verifiedAccount(config, username);
  const domain = String(account.domain).toLowerCase();
  const installations = installationForDomain(await new SoftaculousClient(config).installations(), domain);
  return { username, domain, installations, count: installations.length, source: "Softaculous inventory; unmanaged WordPress installations may not be listed" };
}

async function configureInstallationEmail(client: SoftaculousClient, contactEmail: unknown) {
  const email = z.string().trim().email().max(254).safeParse(contactEmail);
  if (!email.success) throw new Error("The hosting account has no valid contact email. Set its contact email in WHM before requesting credential delivery; no installation was started.");
  const body = await client.request("email", new URLSearchParams({ editemailsettings: "1", email: email.data, ins_email: "1" }));
  if (hasErrors(body.error) || ![true, 1, "1"].includes(body.done)) throw new Error("Softaculous installation-email settings were not confirmed. Check Softaculous email settings; no installation was started.");
  return email.data;
}

export async function configureWordpressEmail(config: Config, username: string) {
  const account = await verifiedAccount(config, username);
  const recipient = await configureInstallationEmail(new SoftaculousClient(config), account.email);
  return { status: "configured", username, recipient, provider: "Softaculous", existing_credentials_sent: false,
    password_inclusion: "Requires Softaculous Email settings > Email password in plain text", inbox_delivery: "not_verified" };
}

export async function installWordpress(config: Config, input: InstallRequest) {
  const request = schema.parse(input);
  const account = await verifiedAccount(config, request.username);
  if (String(account.domain).toLowerCase() !== request.domain) throw new Error("The requested domain does not match the configured test account's primary domain.");
  const client = new SoftaculousClient(config);
  const existing = installationForDomain(await client.installations(), request.domain);
  if (existing.length) return { status: "already_exists", username: request.username, domain: request.domain, installations: existing };
  // Explicitly authorized HTTP exception for this isolated test domain only.
  // Control-panel authentication and installer requests always retain HTTPS.
  const protocol = request.domain === "mature-yellow-fish.104-219-248-4.cpanel.site" ? "http" : "https";
  // Verify public reachability without cPanel credentials. Do not bypass certificate
  // validation or follow redirects to an unrelated site.
  try {
    const response = await fetch(`${protocol}://${request.domain}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10000) });
    if (response.status >= 300 && response.status < 400) {
      const target = new URL(response.headers.get("location") ?? "", `${protocol}://${request.domain}`);
      if (target.protocol !== `${protocol}:` || target.hostname !== request.domain) throw new Error("Unexpected redirect");
    }
  } catch { throw new Error(`The test domain's ${protocol.toUpperCase()} could not be verified. Fix DNS/connectivity${protocol === "https" ? "/SSL" : ""} before installation; no installation was started.`); }
  const recipient = await configureInstallationEmail(client, account.email);
  const password = `Aa9!${randomBytes(32).toString("base64url")}`;
  const params = new URLSearchParams({ softsubmit: "1", softdomain: request.domain, softdirectory: "", softproto: protocol === "http" ? "1" : "3",
    softdb: `wp${randomBytes(4).toString("hex")}`, admin_username: "pagesurgeadmin", admin_pass: password,
    admin_email: request.admin_email, language: "en", site_name: request.site_title, site_desc: "PageSurgeAI test site" });
  // Never set overwrite_existing. Softaculous must retain its existing-file
  // protection, including installations it has not imported into inventory.
  const body = await client.request("software", params);
  if (hasErrors(body.error)) throw new Error("Softaculous reported an installation error. Inspect WordPress Manager for its details and check inventory before retrying. Existing-file protection remains enabled.");
  if (![true, 1, "1"].includes(body.done) || body.setupcontinue) throw new Error("WordPress installation was not confirmed complete. Inspect WordPress Manager before retrying.");
  // Ignore raw API data, which may contain admin and database passwords.
  return { status: "installed", username: request.username, domain: request.domain, site_url: `${protocol}://${request.domain}/`,
    admin_url: `${protocol}://${request.domain}/wp-admin/`, admin_username: "pagesurgeadmin", mcp_plugin_installed: false,
    credential_delivery: "Installation email requested through Softaculous. Password inclusion depends on its Email password in plain text setting. Use WordPress Manager Login if needed. No password is returned in chat.",
    email: { recipient, status: "requested", inbox_delivery: "not_verified", password_inclusion: "depends_on_softaculous_email_setting" } };
}
