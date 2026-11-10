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

## Trace and screenshot probe (2026-11-10, issue #3, firmware V1.04.0040)

| Topic | Result |
|-------|--------|
| Trace ASCII | `:TRACe:DATA? TRACE1` -> 1001 comma-separated values (`-6.112838e+01`), no spaces, CRLF terminated; count == `:SWEep:POINts?`; unit dBm (`:UNIT:POWer?` -> `DBM`) |
| Trace REAL32 / REAL64 | `#4` + 4-digit byte length (4004 / 8008), **big-endian** IEEE 754, then CRLF; 1001 values |
| `:FORMat` | query returns `ASC8`; setters `ASCii`, `REAL32`, `REAL64` work. `ASC8` as a setter is ignored. Restored to `ASC8` after probing |
| Frequency range at probe time | start 10 MHz, stop 3.6 GHz |
| Reply terminator | text replies and block trailers end in CRLF, not just LF |
| `:SYSTem:PICture:FORMat` | queries `BMP`; `PNG` accepted and restored to `BMP` |
| `:DISPlay:ZBmp?` | `#9` + 9-digit length (varies per capture), `0x03`, compressed BMP-like stream. **Only 144,800 bytes ever arrive** |
| `:DISPlay:DATA?` | `#7` + `4096054`, then an uncompressed `BM` bitmap. **Only 144,800 bytes arrive**; no reply after `PNG` was selected |
| Sweep state | continuous sweep paused to test the screenshot, then restored to continuous |

Samples (trace data only; screenshots are truncated so only their 48-byte headers are kept): [tests/fixtures/p2/](../tests/fixtures/p2/). Reproduce with `UTS_IP=<host> node scripts/probe-trace.mjs <output-dir>`.

## Command timing and error queue (2026-11-10, issue #45, firmware V1.04.0040)

- **Bursts:** several lines written in the same millisecond (e.g. `*CLS`, two setters, `:SYSTem:ERRor?`) can make the instrument queue spurious `-113 "Undefined header"` errors even though the settings are applied. The connection therefore follows every command with `*OPC?` and waits for the reply before writing again (`sendCommand(cmd, { sync: false })` opts out). 20 consecutive start/stop rounds produced no errors.
- **Stall after an unsupported query:** after a query the instrument does not recognize (no reply, `-113` queued) it stops responding for about 2.15 s and keeps only the last line received during that time. The connection holds the next job off until 2.5 s after the failed query was sent. Unsupported *commands* (no `?`) and a query sent within a few ms of the bad one are not affected.
- **`*CLS` clears the error queue**, which is global to the instrument and keeps stale errors from earlier unsupported queries. Tools that apply settings run `*CLS` first so only their own errors are reported.
- **One reply per burst of queries:** two queries written back-to-back (or joined with `;`) get one reply; send queries one at a time.
- **Late `-113` for unsupported queries (issue #47):** the error for an unsupported query lands in the error queue about 4 s after the query, even if `*CLS` ran in between (6 of 6 trials: `*CLS` after the hold-off read `0,"No error"`, and `-113 "Undefined header"` reappeared ~1.5 s later). Within 2 s of the bad query, an `:SYSTem:ERRor?` is itself lost to the stall. The connection records when a query last timed out (`msSinceQueryTimeout()`), and `applyCommands` ignores `-113` for 10 s after a timeout. Verified live: two bad `scpi_query` calls followed by `set_frequency` (center/span, start/stop, restore) reported no errors, twice.

## Amplitude (2026-11-10, issue #11, firmware V1.04.0040)

- **Queries** that reply: `:DISPlay:WINDow:TRACe:Y:RLEVel?`, `:PDIVision?`, `:SPACing?`, `:RLEVel:OFFSet?`, `:UNIT:POWer?`, `:POWer:ATTenuation?`, `:POWer:ATTenuation:AUTO?`, `:POWer:GAIN:STATe?`, `:SENSe:CORRection:IMPedance:INPut:MAGNitude?`. `:INPut:IMPedance?` gets no reply and `:INPut:IMPedance 50` is rejected as `-113`; the `:SENSe:CORRection:IMPedance:INPut:MAGNitude` alias works for both. Defaults seen: 0 dBm, 10 dB/div, LOGarithmic, offset 0, DBM, attenuation 10 (auto on), preamp off, 50 ohm.
- **Number format:** setters accept bare numbers and unit suffixes (`-10 dBm`, `5 dB`) alike; no error either way.
- **Out of range is clamped silently, no error:** reference level to -100..30 dBm; scale per division to 0.1..20; offset to +-327.6; attenuation to 0..51 and rounded to an integer (`7.6` -> `8`); impedance other than 75 reads back `50` (`60` -> `50`). An invalid enum (`:UNIT:POWer BOGUS`, `:SPACing BOGUS`) gives `-224 "Illegal parameter value"`.
- **Units:** `:UNIT:POWer` takes `DBM|DBMV|DBUV|V|W` (case-insensitive, the query returns upper case). The reference level reads back in the current unit (-10 dBm -> 36.9897 dBmV, 96.9897 dBuV, 0.0707 V, 1e-4 W; V assumes 50 ohm); the offset stays in dB. In linear scale the reference level is likewise read in the Y unit.
- **Attenuation:** setting a value turns auto off. `:POWer:ATTenuation:AUTO ON` (or `1`) turns it on, and the attenuation value then follows the reference level (0 dBm -> 10 dB, -30 dBm -> 0 dB; the value read immediately after turning auto on can still be the old one). Turning the preamp on with auto attenuation raised it from 10 to 30 dB.
- **Coupling:** the reference level readback includes the reference level offset (offset 2 dB reads 2 dBm for a 0 dBm level), and the maximum reference level depends on attenuation and preamp (20 dB manual attenuation with preamp on and a 2 dB offset: max -8 dBm). `set_amplitude` therefore sets preamp, attenuation and offset before the reference level.
- **Impedance 75:** set and read back as 75 (a correction; the reference level readback in dBm was unchanged); restored to 50.
- **Error queue backlog:** flooding the instrument with malformed lines left dozens of `-101 "Invalid character"` entries that outlast `*CLS`-less reads; `*CLS` then draining cleared them.
- All settings were restored afterwards (0 dBm, 10 dB/div, LOGarithmic, offset 0, DBM, auto attenuation, preamp off, 50 ohm); `:SYSTem:ERRor?` clean.

