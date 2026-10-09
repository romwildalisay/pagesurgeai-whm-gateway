import { randomBytes } from "node:crypto";
import { z } from "zod";
import { extractAccounts, extractPackages, WhmClient } from "./whm-client.js";

export const CREATE_SCOPE = "whm:create";
export const creationInput = {
  domain: z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  username: z.string().trim().regex(/^[a-z][a-z0-9]{0,15}$/).refine((value) => value !== "root" && !value.startsWith("mysql") && !value.startsWith("test"), "Reserved username"),
  package: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/),
  contact_email: z.string().trim().email().max(254),
  confirm: z.literal(true)
};
const schema = z.object(creationInput).strict();
export type CreationRequest = z.infer<typeof schema>;

export async function createHostingAccount(whm: WhmClient, input: CreationRequest) {
  const request = schema.parse(input);
  const inventory = await whm.call("listaccts");
  if (!Array.isArray(inventory?.data?.acct)) throw new Error("WHM inventory could not be verified. No account was created.");
  const conflicts = extractAccounts(inventory).filter((a) => a.user === request.username || String(a.domain).toLowerCase() === request.domain);
  if (conflicts.length) {
    if (conflicts.length === 1 && conflicts[0].user === request.username && String(conflicts[0].domain).toLowerCase() === request.domain && (conflicts[0].plan ?? conflicts[0].package) === request.package) {
      return { status: "already_exists", username: request.username, domain: request.domain, package: request.package };
    }
    throw new Error("Username or domain already exists with different settings. No account was created or changed.");
  }
  const packages = extractPackages(await whm.call("listpkgs"));
  if (!packages.some((p) => p.name === request.package)) throw new Error("Choose an exact package returned by hosting_list_packages. No account was created.");
  // The password is sent only to WHM in the request body. Neither this secret
  // nor createacct's raw response is returned to the model or logged.
  await whm.createAccount({ username: request.username, domain: request.domain, plan: request.package,
    contactemail: request.contact_email, password: `Aa9!${randomBytes(32).toString("base64url")}` });
  return { status: "created", username: request.username, domain: request.domain, package: request.package,
    contact_email: request.contact_email, wordpress_installed: false, credential_delivery: "Access cPanel through WHM or reset its password through WHM." };
}
