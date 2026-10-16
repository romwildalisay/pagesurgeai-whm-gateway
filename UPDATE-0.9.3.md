# Update 0.9.3: WordPress installation credential email fallback

New installs still request Softaculous installation mail. After MCP Manager 2.0.6 connects successfully, the gateway makes one authenticated request to WordPress to queue the generated username and password to the verified WHM contact.

The credential handoff is non-enumerable in the gateway process, is transmitted only over HTTPS, and is removed before any tool result is built. WordPress does not persist the password. The endpoint is protected by the site's private Bearer token, allows only the contact email embedded from verified WHM account data, and records a one-time sent marker.

The result distinguishes queued, not queued, already queued, and unknown outcomes. WordPress `wp_mail()` acceptance does not confirm inbox delivery. The current site is not reset or reinstalled; this fallback applies to new installations after the updated gateway is deployed.
