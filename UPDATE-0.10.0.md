# Update 0.10.0: account disk storage quotas

Adds `hosting_get_disk_quota` and `hosting_set_disk_quota`. A prompt such as "Decrease thisisatestwebsite.com's disk storage to 5 GB, then verify it" resolves the exact account and applies a 5120 MB quota using WHM `editquota`.

Both tools verify reseller ownership and the exact primary domain. Writes require `confirm: true`, `whm:read whm:disk`, and WHM Quota Modification (`quota`). The setter rechecks current usage immediately before writing and independently reads the resulting quota. Below-usage reductions, and reductions with unknown usage, require explicit impact acceptance. Zero is rejected; unlimited must be explicit. Uncertain writes are never automatically retried.

## Activation on the existing connection

1. Deploy this gateway version using the existing Render service and deployment process.
2. Add `whm:disk` to the existing Auth0 API permissions and grant it to the authorized user/role. Preserve current permissions.
3. Have the hosting administrator verify Quota Modification (`quota`) and Account Summary privileges on the existing WHM identity/token. Reseller resource restrictions still apply; this update does not grant privileges.
4. Add `whm:disk` to the existing PageSurgeAI WHM Web connection's requested scopes, reauthorize, and refresh its tools. Preserve the App binding, callback, audience and secrets.
5. Publish the updated skill through the existing plugin release process. Refresh the plugin and verify the two tools are visible.
6. Read the account quota, request the specific adjustment, and confirm that read-back reports 5120 MB. A healthy process or passing mocked tests alone does not establish live WHM permission.

The change adjusts only the selected account's disk quota. Its package and bandwidth remain unchanged. Later package changes may overwrite the quota. No live hosting quota was changed during development.

Implementation reference: [WHM editquota](https://api.docs.cpanel.net/specifications/whm.openapi/bandwidth-and-disk-quotas/accounts-editquota).
