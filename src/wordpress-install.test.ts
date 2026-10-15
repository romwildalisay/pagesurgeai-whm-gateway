import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
vi.mock("./wordpress-setup.js", () => ({ installWordpress: vi.fn() }));
vi.mock("./wordpress-mcp.js", () => ({ setupWordpressMcp: vi.fn() }));
import { installWordpress } from "./wordpress-setup.js";
import { setupWordpressMcp } from "./wordpress-mcp.js";
import { installWordpressWithMcp } from "./wordpress-install.js";
const config = {} as Config;
const input = { username: "labsite", domain: "example.com", site_title: "Lab", admin_email: "owner@example.com", confirm: true as const };
afterEach(() => vi.resetAllMocks());
function installed() { vi.mocked(installWordpress).mockResolvedValue({ status: "installed", email: { status: "requested" } } as any); }
it("sets up and verifies MCP only after confirmed new WordPress success", async () => {
  installed(); vi.mocked(setupWordpressMcp).mockResolvedValue({ status: "connected", installed: true } as any);
  expect(await installWordpressWithMcp(config, input)).toMatchObject({ status: "installed", mcp_setup: "connected", mcp_plugin_installed: true, email: { status: "requested" } });
  expect(setupWordpressMcp).toHaveBeenCalledWith(config, "labsite", true);
  expect(vi.mocked(installWordpress).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(setupWordpressMcp).mock.invocationCallOrder[0]);
});
it("leaves existing installations unchanged", async () => {
  const existing = { status: "already_exists", installations: [] } as any;
  vi.mocked(installWordpress).mockResolvedValue(existing);
  expect(await installWordpressWithMcp(config, input)).toBe(existing);
  expect(setupWordpressMcp).not.toHaveBeenCalled();
});
it("does not set up MCP when installation is unconfirmed", async () => {
  vi.mocked(installWordpress).mockRejectedValue(new Error("unconfirmed"));
  await expect(installWordpressWithMcp(config, input)).rejects.toThrow("unconfirmed");
  expect(setupWordpressMcp).not.toHaveBeenCalled();
});
it.each(["installed_https_required", "existing_plugin_needs_connection"])("preserves installed status for %s", async status => {
  installed(); vi.mocked(setupWordpressMcp).mockResolvedValue({ status, installed: true } as any);
  expect(await installWordpressWithMcp(config, input)).toMatchObject({ status: "installed", mcp_setup: "incomplete", mcp: { status } });
});
it("contains uncertain MCP errors without leaking secrets or repeating installation", async () => {
  installed(); vi.mocked(setupWordpressMcp).mockRejectedValue(new Error("secret-token"));
  const result = await installWordpressWithMcp(config, input);
  expect(result).toMatchObject({ status: "installed", mcp_setup: "incomplete", mcp_plugin_installed: "not_verified" });
  expect(JSON.stringify(result)).not.toContain("secret-token");
  expect(installWordpress).toHaveBeenCalledTimes(1);
});
