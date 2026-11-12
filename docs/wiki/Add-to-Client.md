# Add to Client

Copy-paste configuration for each MCP client. Everything here is generated from `scripts/client-snippets.mjs` (run `npm run clients:sync` after changing it), so the README, the site and this page agree. `192.168.1.100` is a placeholder: use your analyzer's address. `UTS_IP` is optional; see [Getting Started](Getting-Started) for the other install forms (release tarball, git tag, a clone).

<!-- clients:begin -->
### Claude Code

Source: https://code.claude.com/docs/en/plugins/marketplace-reference.md and https://code.claude.com/docs/en/mcp

Verification: Plugin, marketplace and `.mcp.json` formats checked against the Claude Code docs and validated with `claude plugin validate`. `claude plugin marketplace add` and `claude plugin install` were run against a local checkout in an isolated Claude Code config directory (install and listing succeeded). Not yet verified: adding the marketplace from GitHub, and starting the server inside a Claude Code session (the pinned npm version must be published first).

- Recommended: add this repository as a marketplace and install the plugin (two commands, inside Claude Code or with `claude plugin ...` in a shell). The plugin runs `npx -y uni-t-uts-mcp` pinned to this release (1.1.0) and asks for the analyzer address, port and transport (all optional; they are stored in your Claude Code settings).
- Or run the `claude mcp add` command once in a terminal. Add `--scope user` to make it available in every project (`local` is the default, `project` writes `.mcp.json`).
- UTS_IP is optional: without it, tell the assistant "connect to the analyzer at 192.168.1.100".

Plugin (recommended):

```sh
/plugin marketplace add Reid-n0rc/uni-t-uts-mcp
/plugin install uni-t-uts@uni-t-uts-mcp
```

Plugin from a shell:

```sh
claude plugin marketplace add Reid-n0rc/uni-t-uts-mcp
claude plugin install uni-t-uts@uni-t-uts-mcp
```

npx (macOS / Linux):

```sh
claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- npx -y uni-t-uts-mcp
```

npx (Windows):

```sh
claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- cmd /c npx -y uni-t-uts-mcp
```

Docker:

```sh
claude mcp add uni-t-uts -- docker run -i --rm -e UTS_IP=192.168.1.100 ghcr.io/reid-n0rc/uni-t-uts-mcp:1.1.0
```

.mcp.json (project scope):

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "npx",
      "args": [
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

### Claude Desktop

Source: https://modelcontextprotocol.io/docs/develop/connect-local-servers

Verification: The `claude_desktop_config.json` format and paths are from the MCP docs. Installing the `.mcpb` in Claude Desktop itself is NOT verified yet (issue #86 tracks the manual check).

One-click: [Download the .mcpb (GitHub releases)](https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/tag/v1.1.0)

- Easiest: download `uni-t-uts-mcp-1.1.0.mcpb` from the release and double-click it; the install dialog asks for the analyzer address. (Not verified in Claude Desktop yet.)
- Or edit the config file (Settings > Developer > Edit Config): macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json`. Restart Claude Desktop completely afterwards.
- UTS_IP is optional: without it, tell the assistant "connect to the analyzer at 192.168.1.100".

npx (macOS / Linux):

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "npx",
      "args": [
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

npx (Windows):

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

Docker:

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "UTS_IP=192.168.1.100",
        "ghcr.io/reid-n0rc/uni-t-uts-mcp:1.1.0"
      ]
    }
  }
}
```

### Cursor

Source: https://cursor.com/docs/context/mcp

Verification: File locations and the install-link format are from Cursor's docs (https://cursor.com/docs/mcp/install-links). Not clicked in Cursor by the maintainer.

One-click: [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=uni-t-uts&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInVuaS10LXV0cy1tY3AiXX0=)

- The install link opens Cursor's install dialog with the npx command (no analyzer address; tell the assistant where it is, or add `UTS_IP` under `env` afterwards). On Windows use the config file below.
- Or put the JSON in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).

npx (macOS / Linux):

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "npx",
      "args": [
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

npx (Windows):

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

Docker:

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "UTS_IP=192.168.1.100",
        "ghcr.io/reid-n0rc/uni-t-uts-mcp:1.1.0"
      ]
    }
  }
}
```

### VS Code

Source: https://code.visualstudio.com/docs/agents/reference/mcp-configuration

Verification: The `servers` format, file locations and `code --add-mcp` are from the VS Code docs (which note the `servers` format belongs to the Local harness, deprecated from February 2027). No one-click link: the `vscode:mcp/install` format is not in the official docs, so none is offered. Not run by the maintainer.

- Workspace: save the JSON as `.vscode/mcp.json`. For your user profile run `code --add-mcp` with the JSON below, or use the Command Palette: MCP: Add Server.
- UTS_IP is optional: without it, tell the assistant "connect to the analyzer at 192.168.1.100".

.vscode/mcp.json (macOS / Linux):

```json
{
  "servers": {
    "uni-t-uts": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

.vscode/mcp.json (Windows):

```json
{
  "servers": {
    "uni-t-uts": {
      "type": "stdio",
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

code --add-mcp (macOS / Linux):

```sh
code --add-mcp '{"name":"uni-t-uts","type":"stdio","command":"npx","args":["-y","uni-t-uts-mcp"],"env":{"UTS_IP":"192.168.1.100"}}'
```

### Windsurf

Source: https://docs.devin.ai/windsurf/plugins/cascade/mcp

Verification: The `mcpServers` format is from the Windsurf docs. Their path has moved: the current docs say `~/.config/devin/mcp_config.json` (macOS / Linux) or `%AppData%/devin/mcp_config.json` (Windows), older ones `~/.codeium/windsurf/mcp_config.json`. Use Cascade's Open MCP config file action to find the right one. No install link is documented. Not run by the maintainer.

- Open the file with Cascade's Open MCP config file action (or Settings > Tools > Windsurf Settings > Add Server) and add the entry.
- UTS_IP is optional: without it, tell the assistant "connect to the analyzer at 192.168.1.100".

npx (macOS / Linux):

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "npx",
      "args": [
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

npx (Windows):

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

Docker:

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "UTS_IP=192.168.1.100",
        "ghcr.io/reid-n0rc/uni-t-uts-mcp:1.1.0"
      ]
    }
  }
}
```

### Other stdio clients

Source: https://modelcontextprotocol.io/docs/develop/connect-local-servers

Verification: Plain MCP stdio: the client starts the command and talks over stdin/stdout. Key names differ per client; check its docs.

- Command `npx`, arguments `-y uni-t-uts-mcp`, environment variable `UTS_IP` (optional, `UTS_PORT` defaults to 5025).
- On Windows, where `npx` is a `.cmd` file, use `cmd` with arguments `/c npx -y uni-t-uts-mcp`.

npx (macOS / Linux):

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "npx",
      "args": [
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

npx (Windows):

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "uni-t-uts-mcp"
      ],
      "env": {
        "UTS_IP": "192.168.1.100"
      }
    }
  }
}
```

Docker:

```json
{
  "mcpServers": {
    "uni-t-uts": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "UTS_IP=192.168.1.100",
        "ghcr.io/reid-n0rc/uni-t-uts-mcp:1.1.0"
      ]
    }
  }
}
```
<!-- clients:end -->
