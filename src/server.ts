import { loadConfig } from "./config.js";
import { createGatewayApp } from "./http-app.js";

const config = loadConfig();
const app = createGatewayApp(config);
app.listen(config.PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "gateway_started", port: config.PORT, version: "0.2.2", mode: "read-only", auth: "oauth2", checks: { process: "ok", oauth_link: "not_checked", whm: "not_checked" } }));
});
