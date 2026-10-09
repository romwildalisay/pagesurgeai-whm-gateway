import type { Config } from "./config.js";

export class WhmError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "WhmError";
  }
}

export class WhmClient {
  constructor(private readonly config: Config) {}

  async call(functionName: string, params: Record<string, string | number> = {}): Promise<any> {
    const allowedReadFunctions = new Set(["listaccts", "accountsummary", "listpkgs"]);
    if (!allowedReadFunctions.has(functionName)) throw new WhmError("WHM function is not allowed in read-only mode");
    if (!/^[a-z][a-z0-9_]*$/i.test(functionName)) throw new WhmError("Invalid WHM function name");
    return this.request(functionName, params, false);
  }

  async createCpanelSession(username: string) {
    if (!this.config.CPANEL_USERNAME || username !== this.config.CPANEL_USERNAME) throw new WhmError("WHM session access is restricted to the configured test account.");
    try {
      const body = await this.request("create_user_session", { user: username, service: "cpaneld", preferred_domain: new URL(this.config.WHM_BASE_URL).hostname }, false);
      if (body?.metadata?.result !== 1 || !body?.data?.url || !body?.data?.cp_security_token) throw new Error("Invalid session response");
      return body.data as { url: string; cp_security_token: string };
    } catch {
      throw new WhmError("WHM reseller session creation failed. The existing WHM token or reseller may not permit this operation. No Softaculous request was made; no hosting changes were made.");
    }
  }

  async createAccount(params: { username: string; domain: string; plan: string; contactemail: string; password: string }) {
    return this.request("createacct", { ...params, hasshell: 0, reseller: 0, forcedns: 0, savepkg: 0, showpass: "n" }, true);
  }

  private async request(functionName: string, params: Record<string, string | number>, creating: boolean): Promise<any> {
    const url = new URL(`/json-api/${functionName}`, this.config.WHM_BASE_URL);
    url.searchParams.set("api.version", "1");
    if (!creating) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.WHM_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: creating ? "POST" : "GET",
        redirect: "error",
        ...(creating ? { body: new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])) } : {}),
        headers: {
          Authorization: `whm ${this.config.WHM_USERNAME}:${this.config.WHM_API_TOKEN}`,
          Accept: "application/json",
          "User-Agent": "PageSurgeAI-WHM-Gateway/0.4.7"
        },
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        throw new WhmError(
          `WHM returned HTTP ${response.status}. The hosting request was rejected upstream. Check WHM_BASE_URL, WHM_USERNAME, WHM_API_TOKEN, token permissions, and any WHM firewall or IP restrictions in Render/WHM. Reconnecting Auth0 does not repair WHM credentials.`,
          response.status
        );
      }
      if (!response.ok) throw new WhmError(creating ? `Account creation returned HTTP ${response.status}; check WHM inventory before retrying.` : `WHM returned HTTP ${response.status}`, response.status);
      const body = await response.json() as any;
      const metadata = body?.metadata;
      if (metadata && (metadata.result === 0 || metadata.result === false)) {
        throw new WhmError(creating ? "WHM rejected account creation. Check Create Accounts permission, package, account limits, and domain availability in WHM." : String(metadata.reason || "WHM rejected the request"));
      }
      if (creating && metadata?.result !== 1 && metadata?.result !== true) throw new WhmError("Account creation returned an unrecognized response. Check WHM inventory before retrying.");
      return body;
    } catch (error) {
      if (error instanceof WhmError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new WhmError(creating ? "Account creation timed out; it may have completed. Check WHM inventory before retrying." : "WHM request timed out");
      throw new WhmError(creating ? "Account creation could not be confirmed; it may have completed. Check WHM inventory before retrying." : "Unable to reach WHM securely");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function validateCpanelUser(user: string): string {
  const clean = user.trim();
  if (!/^[a-z][a-z0-9]{0,15}$/i.test(clean)) throw new WhmError("Invalid cPanel username");
  return clean;
}

export function extractAccounts(body: any): any[] {
  return Array.isArray(body?.data?.acct) ? body.data.acct : [];
}

export function extractPackages(body: any): any[] {
  const pkgs = body?.data?.pkg;
  if (Array.isArray(pkgs)) return pkgs;
  if (pkgs && typeof pkgs === "object") return Object.entries(pkgs).map(([name, value]) => ({ name, ...(value as object) }));
  return [];
}
