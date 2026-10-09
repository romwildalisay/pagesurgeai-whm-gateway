import { afterEach, expect, it, vi } from "vitest";
import { jwtVerify } from "jose";
import { createTokenVerifier } from "./auth.js";
import type { Config } from "./config.js";

vi.mock("jose", () => ({ createRemoteJWKSet: vi.fn(), jwtVerify: vi.fn() }));
const config = { OAUTH_ISSUER: "https://auth.test", OAUTH_AUDIENCE: "https://gateway.test/mcp", OAUTH_SCOPE: "whm:read" } as Config;
afterEach(() => vi.resetAllMocks());

it("keeps read-only tokens usable for reads but rejects creation", async () => {
  vi.mocked(jwtVerify).mockResolvedValue({ payload: { scope: "whm:read", sub: "user" } } as any);
  const verify = createTokenVerifier(config);
  expect(await verify("Bearer token")).toEqual({ ok: true, subject: "user" });
  expect(await verify("Bearer token", ["whm:read", "whm:create"])).toEqual({ ok: false, reason: "insufficient_scope" });
  expect(jwtVerify).toHaveBeenCalledWith("token", undefined, {
    issuer: "https://auth.test/", audience: "https://gateway.test/mcp", algorithms: ["RS256"]
  });
});

it("requires both read and creation permissions on a verified token", async () => {
  const verify = createTokenVerifier(config);
  for (const scope of ["whm:create", "whm:read whm:create-extra", undefined]) {
    vi.mocked(jwtVerify).mockResolvedValue({ payload: { scope } } as any);
    expect(await verify("Bearer token", ["whm:read", "whm:create"])).toEqual({ ok: false, reason: "insufficient_scope" });
  }
  vi.mocked(jwtVerify).mockResolvedValue({ payload: { scope: "whm:read whm:create", sub: "user" } } as any);
  expect(await verify("Bearer token", ["whm:read", "whm:create"])).toEqual({ ok: true, subject: "user" });
});

it("fails closed when token verification fails", async () => {
  vi.mocked(jwtVerify).mockRejectedValue(new Error("Invalid token"));
  expect(await createTokenVerifier(config)("Bearer token", ["whm:read", "whm:create"])).toEqual({ ok: false, reason: "invalid_token" });
});
