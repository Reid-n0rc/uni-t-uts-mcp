// Release smoke check (b, c): start an MCP server over stdio, send `initialize` and
// `tools/list`, and assert the server name and the tool count.
//
//   node scripts/smoke-mcp.mjs [--expect-tools N] [--timeout-ms MS] -- <command> [args...]
//
// Without --expect-tools the expected count is read from this repository's build
// (build/server.js), so it never needs updating when tools are added. Run `npm run build` first.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

const EXPECTED_NAME = "uni-t-uts-mcp";

/** Number of tools registered by this repo's built server. */
export async function countRegisteredTools() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { createServer } = await import(pathToFileURL(resolve(root, "build/server.js")).href);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "count", version: "0.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.length;
}

/** Spawn the server, run initialize + tools/list, verify. Resolves with {serverName, toolCount}. */
export function smokeTest({ command, args = [], expectedTools, expectedName = EXPECTED_NAME, timeoutMs = 60000 }) {
  return new Promise((resolvePromise, reject) => {
    // Windows .cmd shims (npm bins, npx) can only be started through a shell.
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const quote = (s) => (useShell && /[\s"]/.test(s) ? `"${s}"` : s);
    const child = spawn(quote(command), args.map(quote), { stdio: ["pipe", "pipe", "pipe"], shell: useShell });
    let buf = "";
    let stderr = "";
    let settled = false;
    let serverName;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolvePromise(result);
    };
    const timer = setTimeout(
      () => finish(new Error(`timed out after ${timeoutMs} ms waiting for the server\nstderr: ${stderr.trim()}`)),
      timeoutMs
    );
    const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

    child.on("error", (e) => finish(new Error(`could not start server: ${e.message}`)));
    child.on("exit", (code, sig) =>
      finish(new Error(`server exited early (code ${code}, signal ${sig})\nstderr: ${stderr.trim()}`))
    );
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          return finish(new Error(`server wrote non-JSON to stdout: ${line.slice(0, 200)}`));
        }
        if (m.id === 1) {
          if (m.error) return finish(new Error(`initialize failed: ${JSON.stringify(m.error)}`));
          serverName = m.result?.serverInfo?.name;
          if (serverName !== expectedName)
            return finish(new Error(`unexpected server name: got ${JSON.stringify(serverName)}, want ${JSON.stringify(expectedName)}`));
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list", params: {} });
        } else if (m.id === 2) {
          if (m.error) return finish(new Error(`tools/list failed: ${JSON.stringify(m.error)}`));
          const toolCount = m.result?.tools?.length ?? -1;
          if (toolCount !== expectedTools)
            return finish(new Error(`unexpected tool count: got ${toolCount}, want ${expectedTools}`));
          finish(null, { serverName, toolCount });
        }
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } },
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  if (sep < 0 || sep === argv.length - 1) {
    console.error("usage: smoke-mcp.mjs [--expect-tools N] [--timeout-ms MS] -- <command> [args...]");
    process.exit(2);
  }
  const opts = argv.slice(0, sep);
  const [command, ...args] = argv.slice(sep + 1);
  const opt = (name) => (opts.includes(name) ? opts[opts.indexOf(name) + 1] : undefined);
  const expectedTools = opt("--expect-tools") ? Number(opt("--expect-tools")) : await countRegisteredTools();
  const timeoutMs = opt("--timeout-ms") ? Number(opt("--timeout-ms")) : 60000;
  try {
    const r = await smokeTest({ command, args, expectedTools, timeoutMs });
    console.log(`OK: server "${r.serverName}" answered initialize and tools/list with ${r.toolCount} tools (expected ${expectedTools})`);
    process.exit(0);
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
