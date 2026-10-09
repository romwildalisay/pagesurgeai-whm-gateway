import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

export type AuthCheck =
  | { ok: true; subject: string }
  | { ok: false; reason: "missing_token" | "invalid_token" | "insufficient_scope" };

export function createTokenVerifier(config: Config) {
  const jwks = createRemoteJWKSet(new URL(`${config.OAUTH_ISSUER}/.well-known/jwks.json`));

  return async function verifyAuthorization(value: string | undefined, requiredScopes: string[] = [config.OAUTH_SCOPE]): Promise<AuthCheck> {
    if (!value?.startsWith("Bearer ")) return { ok: false, reason: "missing_token" };

    try {
      const token = value.slice(7).trim();
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `${config.OAUTH_ISSUER}/`,
        audience: config.OAUTH_AUDIENCE,
        algorithms: ["RS256"]
      });
      const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
      if (!requiredScopes.every((scope) => scopes.includes(scope))) return { ok: false, reason: "insufficient_scope" };
      return { ok: true, subject: String(payload.sub ?? "") };
    } catch {
      return { ok: false, reason: "invalid_token" };
    }
  };
}
