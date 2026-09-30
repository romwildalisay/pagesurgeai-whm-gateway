---
name: inspect-whm
description: Inspect PageSurgeAI WHM reseller accounts, packages, and usage through read-only gateway tools. Use for inventory, account lookup, and resource-usage questions. Never claim that this version can modify hosting.
---

# Inspect WHM

Use only the four read-only hosting tools:

- Call `hosting_list_accounts` to discover usernames and domains.
- Call `hosting_get_account` with an exact cPanel username for account details.
- Call `hosting_list_packages` to inspect available reseller packages.
- Call `hosting_get_usage` with an exact cPanel username for disk and bandwidth usage.

Require an authenticated OAuth connection. Preserve the read-only boundary; never infer authorization to create, suspend, restore, or delete accounts.

Distinguish connection errors from upstream hosting errors. An OAuth challenge requires linking or reauthorization. `WHM returned HTTP 401` or `WHM returned HTTP 403` means the hosting request was rejected upstream; check WHM credentials, permissions, and access restrictions rather than claiming Auth0 expired. Treat a healthy process as separate from verified OAuth and WHM access.

If the user deleted an Auth0 application, the former Client ID is invalid. Rebuilding the package does not recreate that client. Use [fresh connection recovery](references/fresh-connection.md) when asked to reconnect. Never request a client secret, access token, password, or WHM API token in chat.

