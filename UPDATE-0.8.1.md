# Deploy v0.8.1

1. Extract this ZIP. Open the extracted folder.
2. Upload its contents over the files in the same GitHub repository connected to Render, then commit.
3. In Render, select Manual Deploy > Deploy latest commit.
4. Wait for Live, then open /health and confirm version 0.8.1.
5. Refresh tools on the existing ChatGPT gateway connection. No new OAuth permissions or environment variables are required.
6. On the next requested new WordPress installation, check the verified hosting-contact inbox and spam folder for URL, username and password. Do not reinstall an existing site just to test email.

The change requests email_password=1 for email settings and each WordPress install. The same install path is used by fresh reinstalls. Account creation alone does not install WordPress or send WordPress credentials. Existing installations return already_exists without resending or resetting passwords. Email delivery is not verified by the API. Provider policy or Softaculous versions can override behavior; a real authorized installation and inbox check remain required.

Reference: https://www.softaculous.com/docs/developers/whmcs-auto-install-module/ documents the email_password installation flag. Its end-user API documentation does not explicitly document that flag for email preferences, so server acceptance and delivery must be validated after deployment.
