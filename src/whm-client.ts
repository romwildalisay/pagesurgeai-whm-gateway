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
    const url = new URL(`/json-api/${functionName}`, this.config.WHM_BASE_URL);
    url.searchParams.set("api.version", "1");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.WHM_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `whm ${this.config.WHM_USERNAME}:${this.config.WHM_API_TOKEN}`,
          Accept: "application/json",
          "User-Agent": "PageSurgeAI-WHM-Gateway/0.2.2"
        },
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        throw new WhmError(
          `WHM returned HTTP ${response.status}. The hosting request was rejected upstream. Check WHM_BASE_URL, WHM_USERNAME, WHM_API_TOKEN, token permissions, and any WHM firewall or IP restrictions in Render/WHM. Reconnecting Auth0 does not repair WHM credentials.`,
          response.status
        );
      }
      if (!response.ok) throw new WhmError(`WHM returned HTTP ${response.status}`, response.status);
      const body = await response.json() as any;
      const metadata = body?.metadata;
      if (metadata && (metadata.result === 0 || metadata.result === false)) {
        throw new WhmError(String(metadata.reason || "WHM rejected the request"));
      }
      return body;
    } catch (error) {
      if (error instanceof WhmError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new WhmError("WHM request timed out");
      throw new WhmError("Unable to reach WHM securely");
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
