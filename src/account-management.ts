import { z } from "zod";
import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import { connect } from "node:tls";
import type { Config } from "./config.js";
import { WhmClient, verifyOwnedAccount } from "./whm-client.js";
import { creationInput } from "./account-creation.js";
import { MAX_SSL_ZIP_BASE64, validateSslArchive } from "./ssl-archive.js";

export const BANDWIDTH_SCOPE = "whm:bandwidth";
export const SSL_SCOPE = "whm:ssl";
export const accountTargetInput = { username: z.string().trim().regex(/^[a-z][a-z0-9]{0,15}$/), domain: creationInput.domain };
export const bandwidthInput = { ...accountTargetInput, limit_mb: z.union([z.number().int().min(1).max(1_000_000_000), z.literal("unlimited")]), allow_below_usage: z.boolean().default(false).describe("Use true only after the user explicitly accepts a limit below current usage or unknown usage during a reduction."), confirm: z.literal(true) };
export const sslArchiveInput = { ...accountTargetInput, zip_base64: z.string().min(1).max(MAX_SSL_ZIP_BASE64).describe("Base64 of the attached ZIP itself; do not unpack or print private keys in chat.") };
const targetSchema = z.object(accountTargetInput).strict();

async function primaryAccount(config: Config, input: { username: string; domain: string }) {
  const account = await verifyOwnedAccount(config, input.username, true);
  if (String(account.domain).toLowerCase() !== input.domain) throw new Error("The requested primary domain does not match the verified account. No bandwidth change was made.");
  return account;
}
async function sslAccount(config: Config, input: { username: string; domain: string }) {
  await verifyOwnedAccount(config, input.username, true);
  const owner = await new WhmClient(config).call("getdomainowner", { domain: input.domain });
  if (owner?.metadata?.result !== 1 || owner?.data?.user !== input.username) throw new Error("The SSL domain could not be verified as belonging to the selected account. No SSL change was made.");
}

export async function getBandwidth(config: Config, input: { username: string; domain: string }) {
  const request = targetSchema.parse(input);
  await primaryAccount(config, request);
  const body = await new WhmClient(config).call("showbw", { search: `^${request.username}$`, searchtype: "user" });
  const row = Array.isArray(body?.data?.acct) ? body.data.acct.find((a: any) => a.user === request.username && !Number(a.deleted) && String(a.maindomain).toLowerCase() === request.domain) : null;
  if (!row) throw new Error("Bandwidth inventory could not be verified for the exact account.");
  const numeric = (value: unknown) => (typeof value === "number" || typeof value === "string") && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const bytes = row.limit === "unlimited" ? 0 : numeric(row.limit), used = numeric(row.totalbytes);
  if (bytes === null) throw new Error("The current bandwidth limit could not be interpreted safely.");
  return { ...request, limit_mb: bytes === 0 ? "unlimited" as const : bytes / (1024 * 1024), used_bytes: used, used_mb: used === null ? null : used / (1024 * 1024), month: body.data.month ?? null, year: body.data.year ?? null, units: "Monthly account limit in WHM MB; 1 GB in gateway prompts = 1024 MB." };
}

export async function setAccountBandwidth(config: Config, input: z.input<z.ZodObject<typeof bandwidthInput>>) {
  const request = z.object(bandwidthInput).strict().parse(input);
  const target = { username: request.username, domain: request.domain };
  const before = await getBandwidth(config, target);
  if (before.limit_mb === request.limit_mb) return { status: "already_set", ...target, limit_mb: request.limit_mb, changes_made: false };
  if (typeof request.limit_mb === "number" && !request.allow_below_usage && ((before.used_mb !== null && request.limit_mb < before.used_mb) || (before.used_mb === null && (before.limit_mb === "unlimited" || request.limit_mb < before.limit_mb)))) throw new Error("The requested reduction is below current usage, or usage could not be verified. This may interrupt websites. Obtain explicit approval for that impact before setting allow_below_usage=true; no bandwidth change was made.");
  // Recheck account ownership and exact primary domain immediately before a write.
  await primaryAccount(config, target);
  const changed = await new WhmClient(config).setBandwidth(request.username, request.limit_mb);
  const rows = changed?.data?.bwlimits;
  const expected = request.limit_mb === "unlimited" ? 0 : request.limit_mb;
  const matched = Array.isArray(rows) && rows.some((row: any) => Array.isArray(row.domains) && row.domains.includes(request.domain) && Number(row.bwlimit) === expected && (request.limit_mb === "unlimited" ? Number(row.unlimited) === 1 : Number(row.unlimited) === 0));
  if (!matched) return { status: "change_not_verified", ...target, requested_limit_mb: request.limit_mb, next_step: "Inspect hosting_get_bandwidth; the request may have completed. Do not retry automatically." };
  try {
    const after = await getBandwidth(config, target);
    if (after.limit_mb === request.limit_mb) return { status: "updated", ...target, previous_limit_mb: before.limit_mb, limit_mb: after.limit_mb, used_mb: after.used_mb, package_changed: false, account_suspension_changed: false, package_warning: "A later hosting-package change may overwrite this account-specific limit." };
  } catch { /* API accepted the change, but independent read-back failed. */ }
  return { status: "change_not_verified", ...target, requested_limit_mb: request.limit_mb, next_step: "WHM accepted the change but read-back did not verify it. Inspect hosting_get_bandwidth before further action; do not retry automatically." };
}

export async function validateAccountSslZip(config: Config, input: z.infer<z.ZodObject<typeof sslArchiveInput>>) {
  const request = z.object(sslArchiveInput).strict().parse(input);
  await sslAccount(config, request);
  const parsed = validateSslArchive(request.zip_base64, request.domain);
  return { status: "validated", username: request.username, domain: request.domain, ...parsed.summary, changes_made: false, impact: "Installing will replace the certificate on the domain's Apache SSL virtual host and may affect aliases sharing that host. Website files, DNS and WordPress settings are unchanged. No certificate is purchased or renewed automatically." };
}

const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(ip, prefix, "ipv4");
const blockedV6 = new BlockList();
blockedV6.addSubnet("::", 128, "ipv6"); blockedV6.addSubnet("::1", 128, "ipv6"); blockedV6.addSubnet("fc00::", 7, "ipv6"); blockedV6.addSubnet("fe80::", 10, "ipv6"); blockedV6.addSubnet("ff00::", 8, "ipv6"); blockedV6.addSubnet("2001:db8::", 32, "ipv6"); blockedV6.addSubnet("::", 96, "ipv6"); blockedV6.addSubnet("::ffff:0:0", 96, "ipv6");

export async function probePublicSsl(domain: string, expectedFingerprint?: string) {
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([lookup(domain, { all: true }), new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error("DNS timeout")), 5000); })]);
    clearTimeout(dnsTimer);
    // Pin the resolved public address to prevent DNS rebinding during TLS connection.
    const address = addresses.find(a => !(a.family === 4 ? blocked.check(a.address, "ipv4") : blockedV6.check(a.address, "ipv6")));
    if (!address) throw new Error("No public address");
    return await new Promise<Record<string, unknown>>(resolve => {
      const socket = connect({ host: address.address, port: 443, servername: domain, rejectUnauthorized: true });
      const timer = setTimeout(() => { socket.destroy(); resolve({ https_verified: false, reason: "Public TLS connection was not confirmed. Check DNS and SSL status; do not reinstall automatically." }); }, 8000);
      socket.once("secureConnect", () => {
        const cert = socket.getPeerCertificate(); clearTimeout(timer); socket.destroy();
        resolve({ https_verified: true, fingerprint_sha256: cert.fingerprint256, expires_at: cert.valid_to, ...(expectedFingerprint ? { supplied_certificate_served: cert.fingerprint256 === expectedFingerprint } : {}), note: "A CDN or proxy may serve a different certificate. This does not test WordPress or MCP authentication." });
      });
      socket.once("error", () => { clearTimeout(timer); socket.destroy(); resolve({ https_verified: false, reason: "Public TLS verification failed. Check DNS, certificate deployment and chain; do not retry installation automatically." }); });
    });
  } catch { return { https_verified: false, reason: "Public DNS/TLS could not be verified. No hosting change was made by this check." }; }
  finally { clearTimeout(dnsTimer); }
}

export async function getAccountSslStatus(config: Config, input: { username: string; domain: string }) {
  const request = targetSchema.parse(input);
  await sslAccount(config, request);
  return { ...request, ...await probePublicSsl(request.domain) };
}

export async function installAccountSslZip(config: Config, input: z.infer<z.ZodObject<typeof sslArchiveInput>> & { confirm: true }) {
  const request = z.object({ ...sslArchiveInput, confirm: z.literal(true) }).strict().parse(input);
  const parsed = validateSslArchive(request.zip_base64, request.domain);
  // Verify again on installation even if a prior validation tool succeeded.
  await sslAccount(config, request);
  await new WhmClient(config).installSsl(request.username, request.domain, parsed.certificate, parsed.privateKey, parsed.caBundle);
  return { status: "installed", username: request.username, domain: request.domain, ...parsed.summary, public_tls: await probePublicSsl(request.domain, parsed.summary.fingerprint_sha256), private_key_returned: false, wordpress_settings_changed: false };
}
