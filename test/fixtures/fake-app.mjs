// Stand-in local app (like BrowserOS neo): an stdio MCP server with two tools.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
const s = new McpServer({ name: "browser-stub", version: "1" });
s.registerTool("navigate", { description: "Open a URL", inputSchema: z.object({ url: z.string() }) }, async ({ url }) => ({ content: [{ type: "text", text: `opened ${url}` }] }));
s.registerTool("secret_tool", { description: "should be filtered" }, async () => ({ content: [{ type: "text", text: "x" }] }));
await s.connect(new StdioServerTransport());
