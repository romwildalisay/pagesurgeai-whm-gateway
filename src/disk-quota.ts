import { z } from "zod";
import type { Config } from "./config.js";
import { WhmClient, verifyOwnedAccount } from "./whm-client.js";
import { accountTargetInput } from "./account-management.js";

export const DISK_SCOPE = "whm:disk";
export const diskQuotaInput = {
  ...accountTargetInput,
  limit_mb: z.union([z.number().int().min(1).max(1_000_000_000), z.literal("unlimited")]),
  allow_below_usage: z.boolean().default(false).describe("Use true only after explicit acceptance that a quota below current usage, or a reduction with unknown usage, may prevent file writes and email delivery."),
  confirm: z.literal(true)
};
const targetSchema = z.object(accountTargetInput).strict();

// WHM accountsummary reports MB, often with an M suffix. Unknown is never zero.
export function parseDiskMb(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?(?:M|MB)?$/i.test(text)) return null;
  const number = Number(text.replace(/MB?$/i, ""));
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null;
}

export async function getDiskQuota(config: Config, input: { username: string; domain: string }) {
  const target = targetSchema.parse(input);
  const account = await verifyOwnedAccount(config, target.username, true);
  if (String(account.domain).toLowerCase() !== target.domain) throw new Error("The primary domain does not match the verified account. No disk quota change was made.");
  const rawLimit = account.disklimit;
  const limit = typeof rawLimit === "string" && rawLimit.trim().toLowerCase() === "unlimited" ? "unlimited" as const : parseDiskMb(rawLimit);
  if (limit === null || limit === 0) throw new Error("The current disk quota could not be interpreted safely. No disk quota change was made.");
  return { ...target, limit_mb: limit, used_mb: parseDiskMb(account.diskused), units: "WHM MB; 1 GB in gateway prompts = 1024 MB.", changes_made: false };
}

function checkReduction(before: Awaited<ReturnType<typeof getDiskQuota>>, request: z.infer<z.ZodObject<typeof diskQuotaInput>>) {
  if (typeof request.limit_mb !== "number" || request.allow_below_usage) return;
  if ((before.used_mb !== null && request.limit_mb < before.used_mb) ||
      (before.used_mb === null && (before.limit_mb === "unlimited" || request.limit_mb < before.limit_mb))) {
    throw new Error("The requested disk quota is below current usage, or usage is unknown during a reduction. This may prevent file writes and email delivery. Obtain explicit acceptance before setting allow_below_usage=true; no disk quota change was made.");
  }
}

export async function setAccountDiskQuota(config: Config, input: z.input<z.ZodObject<typeof diskQuotaInput>>) {
  const request = z.object(diskQuotaInput).strict().parse(input);
  const target = { username: request.username, domain: request.domain };
  const before = await getDiskQuota(config, target);
  const unchanged = () => ({ status: "already_set", ...target, limit_mb: request.limit_mb, changes_made: false });
  if (before.limit_mb === request.limit_mb) return unchanged();
  checkReduction(before, request);
  // Recheck identity and usage immediately before writing; accounts may change.
  const latest = await getDiskQuota(config, target);
  if (latest.limit_mb === request.limit_mb) return unchanged();
  checkReduction(latest, request);
  await new WhmClient(config).setDiskQuota(request.username, request.limit_mb);
  try {
    const after = await getDiskQuota(config, target);
    if (after.limit_mb === request.limit_mb) return {
      status: "updated", ...target, previous_limit_mb: latest.limit_mb,
      limit_mb: after.limit_mb, used_mb: after.used_mb, package_changed: false,
      account_suspension_changed: false,
      package_warning: "A later hosting-package change may overwrite this account-specific quota."
    };
  } catch { /* WHM accepted the write; independent verification is inconclusive. */ }
  return { status: "change_not_verified", ...target, requested_limit_mb: request.limit_mb,
    next_step: "Inspect hosting_get_disk_quota before further action; do not retry automatically." };
}
