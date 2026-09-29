import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  WHM_BASE_URL: z.string().url().refine((v) => v.startsWith("https://"), "WHM_BASE_URL must use HTTPS"),
  WHM_USERNAME: z.string().min(1),
  WHM_API_TOKEN: z.string().min(20),
  PUBLIC_BASE_URL: z.string().url().refine((v) => v.startsWith("https://"), "PUBLIC_BASE_URL must use HTTPS").transform((v) => v.replace(/\/$/, "")),
  OAUTH_ISSUER: z.string().url().refine((v) => v.startsWith("https://"), "OAUTH_ISSUER must use HTTPS").transform((v) => v.replace(/\/$/, "")),
  OAUTH_AUDIENCE: z.string().min(1),
  OAUTH_SCOPE: z.string().min(1).default("whm:read"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WHM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000)
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid gateway configuration: ${fields}`);
  }
  return result.data;
}
