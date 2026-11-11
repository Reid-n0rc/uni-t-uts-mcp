# Manual testing

If you have a UNI-T UTS analyzer, the [manual testing guide](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/manual-testing-guide.md) walks you through checking every tool group, once over raw SCPI and once over VXI-11. It lists the prerequisites, a safe setup (no real address or serial number in anything you share), a step-by-step checklist with the expected result and what to record for each step, how to put the analyzer back as you found it, a reporting template (model, firmware, results per group) and a short troubleshooting table.

Things to know before you start:

- The first ordinary SCPI query puts the analyzer in remote mode, which locks its touch screen and buttons until you press the physical **Esc** key on it. On firmware V1.04.0040, `:SYSTem:LOCK 0`, VXI-11 `device_local` and `:KEY:ESC` do not return it to local mode.
- Never send `:KEY:` commands or queries. Which other headers trigger remote mode is unknown.
- SRQ is not available on this firmware; the tools wait for sweeps with `*OPC?`.
- A test in the repository fails when a tool has no checklist step, so the guide always covers the full tool list.

See also [Troubleshooting](Troubleshooting) and [Instrument Behavior](Instrument-Behavior), and report results as an issue in the [repository](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues).
