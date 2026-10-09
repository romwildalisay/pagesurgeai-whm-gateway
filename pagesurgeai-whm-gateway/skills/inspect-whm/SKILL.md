---
name: inspect-whm
description: Inspect PageSurgeAI WHM accounts, packages, and usage, or create a hosting account when explicitly requested. Use for hosting inventory, account lookup, usage, and account provisioning through the connected Web gateway.
---

# Manage WHM hosting

Use the existing PageSurgeAI WHM Web connection. Preserve its App binding and working OAuth settings.

For inspection, use the four read-only tools:

- Call `hosting_list_accounts` to discover usernames and domains.
- Call `hosting_get_account` with an exact cPanel username for details.
- Call `hosting_list_packages` to inspect available reseller packages.
- Call `hosting_get_usage` with an exact cPanel username for usage.

For account creation:

1. Require an explicit user request to create an account. Never infer this from an inventory request.
2. Obtain the domain, cPanel username, exact package name, and contact email. List packages to verify the choice; never invent a package.
3. Use `hosting_create_account` with those fields and `confirm: true` when the user has authorized that specific account. Honor authorization already provided; do not ask again unnecessarily.
4. Require both `whm:read` and `whm:create` in OAuth and Create Accounts permission on the backend WHM token. If the tool is absent, explain that the deployed gateway and the existing Web connection's discovered tools must be refreshed; do not claim creation succeeded.
5. Report `created` or `already_exists` exactly. For a timeout, network failure, or uncertain result, inspect inventory before any retry. Never blindly repeat a write.
6. Explain that account credentials are generated privately. Direct the user to WHM to access cPanel or reset its password. Never request or display secrets in chat.

Never use arbitrary WHM calls, shell commands, or unsupported account modification, suspension, restoration, deletion, or WordPress installation. Account creation does not install WordPress.

Distinguish OAuth challenges from upstream WHM errors. For missing creation scope, reauthorize the existing connection after granting that permission. For WHM HTTP 401/403, check backend credentials, token permissions, and access restrictions. A healthy process does not prove OAuth or WHM access works.

If the user deleted an Auth0 application, use [fresh connection recovery](references/fresh-connection.md). Never request a client secret, access token, password, or WHM API token in chat.
