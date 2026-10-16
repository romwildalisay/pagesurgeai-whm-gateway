# Update 0.9.4: WordPress MCP Manager 2.0.7

The gateway pins WordPress MCP Manager 2.0.7 for installation and site identity verification. The plugin adds a confirmed `users_password_reset_email` action that sends the WordPress native reset link. The action is available through the multi-site gateway and never accepts or emails a password.

Softaculous installation email behavior remains enabled: password inclusion is requested for new WordPress installs and goes to the verified WHM account contact. Inbox delivery is not verified.

The plugin bundle and documentation are updated together. Existing plugin installations and tokens are preserved; setup does not reinstall WordPress or rotate a configured site token.
