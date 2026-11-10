# References

Where to find documentation for the instruments and the project layout. Agents: read the relevant programming manual before writing or changing any SCPI command.

## UNI-T manuals

Authoritative source (current versions): https://instruments.uni-trend.com/download

| Document | Link | Notes |
|----------|------|-------|
| UTS1000B/T programming manual | [Transcat mirror](https://www.transcat.ca/media/pdf/uni-t-uts1000b-t-series-programming-manual.pdf) | ~427 pages. Third-party mirror, not yet verified; prefer the UNI-T copy. |
| UTS3000B programming manual | [gotronik mirror](https://gotronik.pl/images/UTS3000B-programming-manual.pdf) | ~184 pages. Third-party mirror, not yet verified; UNI-T lists a newer V1.2 (2026-01-06). |
| UTS1000B/T and UTS3000B product pages | [UTS1000B](https://instruments.uni-trend.com/products/spectrum-analyzers-signal-analyzers/UTS1000B), [UTS3000B](https://instruments.uni-trend.com/products/spectrum-analyzers-signal-analyzers/UTS3000B) | Datasheets and user manuals. |

Per the datasheets, both series provide USB and LAN interfaces and support SCPI. The LAN port and command differences between series are still to be confirmed from the manuals.

## Project layout reference

[siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp) (MIT): the structure this repo follows.

## MCP

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
