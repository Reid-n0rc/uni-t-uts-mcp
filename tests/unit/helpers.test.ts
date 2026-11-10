import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createTestServer, callTool, getText } from "../helpers.js";

function registerPing(server: McpServer): void {
  server.tool(
    "ping",
    "Echo a message",
    { message: z.string() },
    { readOnlyHint: true },
    async ({ message }) => ({
      content: [{ type: "text" as const, text: `pong:${message}` }],
    })
  );
}

describe("test helpers", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("connects a client to a server with the given tool registrars", async () => {
    const ctx = await createTestServer(registerPing);
    cleanup = ctx.cleanup;
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
  });

  it("callTool + getText return the tool's text output", async () => {
    const ctx = await createTestServer(registerPing);
    cleanup = ctx.cleanup;
    const result = await callTool(ctx.client, "ping", { message: "hi" });
    expect(getText(result)).toBe("pong:hi");
  });

  it("getText throws when the result has no text content", () => {
    expect(() => getText({ content: [] })).toThrow();
  });
});
