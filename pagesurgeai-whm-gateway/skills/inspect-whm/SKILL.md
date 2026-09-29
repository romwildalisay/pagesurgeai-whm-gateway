---
name: inspect-whm
description: Inspect PageSurgeAI WHM reseller accounts, packages, and usage through read-only gateway tools. Use for inventory, account lookup, and resource-usage questions. Never claim that this version can modify hosting.
---

# Inspect WHM

Use the four read-only hosting tools for WHM inventory and usage questions.

- Call `hosting_list_accounts` to discover usernames and domains.
- Call `hosting_get_account` with an exact cPanel username for account details.
- Call `hosting_list_packages` to inspect available reseller packages.
- Call `hosting_get_usage` with an exact cPanel username for disk and bandwidth usage.

State clearly that v0.2.1 is read-only and requires an authenticated OAuth connection. Do not suggest that a successful lookup authorizes account creation, suspension, restoration, or deletion.
