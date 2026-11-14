import { expect, test } from "bun:test";
import { mcpSnippets } from "./mcp-settings";

const url = "http://127.0.0.1:47823/mcp";

test("Claude Code command adds an HTTP server with the bearer header", () => {
	expect(mcpSnippets(url, "tok").claudeCode).toBe(
		`claude mcp add --transport http valoutils ${url} --header "Authorization: Bearer tok"`,
	);
});

test("Claude Desktop bridges through mcp-remote with the token in env", () => {
	const config = JSON.parse(mcpSnippets(url, "tok").claudeDesktop);
	const server = config.mcpServers.valoutils;
	expect(server.command).toBe("npx");
	expect(server.args).toEqual(["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}"]);
	expect(server.env).toEqual({ AUTH_HEADER: "Bearer tok" });
});

test("HTTP clients get the URL and header directly", () => {
	const config = JSON.parse(mcpSnippets(url, "tok").http);
	expect(config.mcpServers.valoutils).toEqual({ url, headers: { Authorization: "Bearer tok" } });
});
