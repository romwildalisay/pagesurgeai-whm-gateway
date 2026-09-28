# Beginner deployment without Docker

This method uses GitHub for storing the non-secret source code and Render for running it. You do not install Docker, Node.js, PuTTY, or terminal tools on your computer.

## Before you start

You need:

- A GitHub account.
- A Render account connected to GitHub.
- The Namecheap WHM server hostname.
- Your reseller username.
- A restricted WHM API token.
- A new random gateway key of at least 32 characters.

Never upload `.env`, disclose either token in chat, or reuse the WHM token as the gateway key.

## Part 1: Upload the project to GitHub

1. Download and unzip `pagesurgeai-whm-gateway-v0.1.zip` on your computer.
2. Sign in to GitHub.
3. Select **New repository**.
4. Name it `pagesurgeai-whm-gateway`.
5. Select **Private**.
6. Create the repository without adding a README or template.
7. Select **Add file → Upload files**.
8. Upload the contents inside the unzipped project folder. The uploaded root must contain `package.json`, `package-lock.json`, `render.yaml`, `src`, and `README.md`.
9. Do not upload a `.env` file. The included `.gitignore` prevents this if one is created later.
10. Select **Commit changes**.

## Part 2: Create the managed service

1. Sign in to Render using GitHub.
2. Select **New → Web Service**.
3. Select the private `pagesurgeai-whm-gateway` repository.
4. Use these values:

   - Language: **Node**
   - Branch: **main**
   - Build command: `npm ci && npm run build`
   - Start command: `npm start`
   - Health check path: `/health`

5. Select a region reasonably close to the Namecheap server.
6. A free service can sleep after inactivity and may be too slow for dependable ChatGPT tool discovery. Use it only for an initial experiment; use an always-on plan for reliable operation.

## Part 3: Add the four private settings

In the service's **Environment** section, add:

| Key | What to enter |
| --- | --- |
| `WHM_BASE_URL` | `https://YOUR-WHM-SERVER-HOSTNAME:2087` |
| `WHM_USERNAME` | Your reseller username |
| `WHM_API_TOKEN` | Your restricted WHM API token |
| `GATEWAY_API_KEY` | A new random secret of at least 32 characters |

Optional:

| Key | Value |
| --- | --- |
| `WHM_TIMEOUT_MS` | `15000` |
| `NODE_VERSION` | `22` |

Do not manually add `PORT`; Render supplies it automatically.

Select **Save, rebuild, and deploy**.

## Part 4: Check the deployment

Wait until the dashboard says the deploy is live. Open:

```text
https://YOUR-RENDER-NAME.onrender.com/health
```

Expected result:

```json
{"status":"ok","name":"pagesurgeai-whm-gateway","version":"0.1.0","mode":"read-only"}
```

The MCP endpoint is then:

```text
https://YOUR-RENDER-NAME.onrender.com/mcp
```

Opening `/mcp` directly in a browser can return a method error. That is normal because an MCP client sends an authenticated POST request.

## Part 5: Hand off for ChatGPT connection

Provide only the public `/mcp` URL. Keep both secret values private. The ChatGPT connection uses `GATEWAY_API_KEY`; it never uses `WHM_API_TOKEN`.

Before using the connector, confirm that its tool scan displays exactly:

- `hosting_list_accounts`
- `hosting_get_account`
- `hosting_list_packages`
- `hosting_get_usage`

Stop if any write, shell, account-creation, suspension, or deletion tool appears.

## Common problems

| Symptom | Likely cause | Correction |
| --- | --- | --- |
| Build fails | Project files were uploaded inside an extra folder | Put `package.json` at the repository root |
| Health page fails | One or more required settings is missing | Check all four environment variables |
| WHM request fails | Wrong server hostname, token, username, or port blocked | Verify WHM access and port `2087` with Namecheap |
| ChatGPT gets unauthorized | Wrong gateway key | Use `GATEWAY_API_KEY`, not the WHM token |
| First request times out | Free service was sleeping | Retry once for testing or use an always-on plan |
| Certificate error | Incorrect WHM server hostname | Use the hostname covered by the WHM server certificate |
