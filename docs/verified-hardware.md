# Verified hardware

What this project has actually been tested against. Anything not listed here is untested.

| Model | Firmware | Interface | Port | Verified |
|-------|----------|-----------|------|----------|
| UNI-T UTS3036B | V1.04.0040 | LAN, raw SCPI over TCP | 5025 | `*IDN?` returns `UNI-TREND,UTS3036B,<serial>,V1.04.0040` (2026-11-10) |

Notes:
- Terminators: `\n`, `\r\n`, `\r` and no terminator were all accepted; use `\n`. Replies end with a newline. Ports 5024 and 23 gave no response.
- Serial numbers are intentionally not recorded in this repo.
- Documentation basis: the UTS3000B programming manual (see [references.md](references.md)). Per-command hardware verification status will be tracked in [programming-guide.md](programming-guide.md).
- UTS1000B/T and other UTS models are expected to be similar but are not verified.

## Probe results (2026-11-10, issue #2, firmware V1.04.0040)

| Command | Result |
|---------|--------|
| `*IDN?` | `UNI-TREND,UTS3036B,<serial>,V1.04.0040` |
| `*OPC?`, `*ESR?`, `*STB?`, `*ESE?`, `*SRE?` | replied (`1`, `0`, `0`, `0`, `0` at idle) |
| `*CLS` | accepted, no reply |
| `:SYSTem:ERRor?` | `0,"No error"` (error queue exists) |
| `:SYSTem:ERRor:NEXT?`, `:STATus:OPERation:CONDition?`, `:STATus:QUEStionable:CONDition?`, `:SYSTem:VERSion?` | no reply (unsupported) |
| `:INITiate:CONTinuous?` / `:SWEep:POINts?` / `:SWEep:TIME?` / `:FORMat?` | `1` / `1001` / `2.647500e-03 ` / `ASC8` |
| unknown query | no reply; the next query still works |

Raw output (serial redacted): [tests/fixtures/p1-basics-probe.txt](../tests/fixtures/p1-basics-probe.txt). Reproduce with `UTS_IP=<host> node scripts/probe-basics.mjs`.

## Observed during F6 (2026-11-10, firmware V1.04.0040)

- A `;`-joined query line (`:INITiate:CONTinuous?;:FORMat?`) returned only one reply (`1`). Send queries one at a time; `scpi_query` enforces this.
- `scpi_query`/`scpi_command` behaved as designed against the instrument: `:SWEep:POINts?` -> `1001`; `*CLS` accepted; an unsupported query timed out cleanly.
