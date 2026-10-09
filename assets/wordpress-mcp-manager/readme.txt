=== WordPress MCP Manager ===
Contributors: pagesurgeai
Requires at least: 6.5
Requires PHP: 8.0
Stable tag: 2.0.5
License: GPLv2 or later

Securely manage WordPress through a self-contained Streamable HTTP MCP server.

== Changelog ==
= 2.0.5 =
* Loaded the WordPress administrative file and theme libraries required by REST-based installers.
* Fixed fatal undefined-function errors for temporary files and theme cache refreshes.

= 2.0.4 =
* Added a guarded file-by-file theme deployment fallback for hosts where ZIP extraction is unavailable.
* Added strict theme slug, relative path, extension, size, atomic-write and byte-count validation.

= 2.0.3 =
* Replaced the hosting-sensitive upgrader path with a constrained local ZIP installer.
* Added ZIP signature, single-root, traversal, absolute-path and symbolic-link protections.
* Added explicit overwrite protection and structured installer errors.

= 2.0.2 =
* Fixed MCP tools/call argument handling so content, media, theme, plugin, menu and settings actions receive their submitted fields.

== Capabilities ==
Posts and pages; media; categories, tags and custom taxonomies; comments; menus; selected site settings; users; themes; plugins; permalink rules; object cache; site diagnostics.

== Security ==
The plugin uses normal WordPress REST authentication. Create a dedicated administrator or editor account and an Application Password. Every action checks the corresponding native WordPress capability. Publishing and high-risk operations require confirm=true. Remote self-deactivation and self-deletion are blocked.

== Installation ==
1. Upload and activate the plugin ZIP in WordPress.
2. Go to Settings > WordPress MCP.
3. Generate a bearer token and copy it immediately.
4. Copy the MCP endpoint displayed on the same screen.
5. In ChatGPT developer-mode app creation, enter the endpoint and choose bearer-token authentication.
6. Scan tools, create the draft app, and test get_site_info before making changes.

== Operational limits ==
Base64 media uploads are limited to 20 MB. Theme and plugin ZIP uploads are limited to 30 MB. WordPress hosting policy may disable filesystem modifications even for administrators. Backups, database queries, arbitrary option writes, arbitrary PHP execution and filesystem browsing are intentionally excluded. The MCP transport is stateless JSON-over-HTTP and supports initialize, ping, tools/list, tools/call and notifications.
