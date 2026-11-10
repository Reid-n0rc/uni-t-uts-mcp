# UTS3000B SCPI programming guide

Basis: *UTS3000B Spectrum Analyzer Programming Manual* (file no. 2023.02.14, sw 00.00.01, 184 pp), cited below as **[3K p.N]**. Where the 3000B manual is silent, the newer *UTS1000B/T series Programming Manual* (2024.09.14, V1.03.0009, 427 pp; its cover lists UTS3000B/T as applicable models), cited as **[1K p.N]**, is used and marked **(1K only)**. Nothing here has been run against hardware unless stated in [verified-hardware.md](verified-hardware.md). "Hardware status" for each group is `unverified` until tracked otherwise.

Page numbers are the PDF footer numbers ("N / 184", "N / 427"). Commands are written as in the manual (uppercase = required abbreviation, lowercase = optional long form, `[ ]` = optional node). Real values come back in scientific notation (e.g. `1.000000e+09`); on/off values come back `0`/`1`.

## 1. Connection and conventions

| Topic | Manual says | Ref |
|---|---|---|
| Interfaces | USB (USBTMC) and LAN, accessed through NI-VISA | 3K p.160-175 |
| LAN resource string | `TCPIP0::<ip>::inst0::INSTR` (VISA/VXI-11 style) | 3K p.168, p.171 |
| Raw TCP port | **Not stated anywhere** in either manual. (Project hardware test: raw SCPI on 5025 works, see verified-hardware.md.) | n/a |
| Terminator | Command string must end with newline `<NL>`; responses end with `\n` | 3K p.3, p.4 |
| Case | Case-insensitive; abbreviation = the uppercase letters | 3K p.4 |
| Command form | Leading `:` optional in examples; `:SENSe` node may be omitted (`:FREQuency:CENTer 1GHz`); `?` suffix = query | 3K p.3, p.59-70 examples |
| Units in args | Suffixes like `Hz`, `kHz`, `MHz`, `GHz`, `dB` used in examples (`1GHz`, `10MHz`); bare numbers use the default unit (Hz, s, dBm, dB) | 3K p.14, p.59 |
| Booleans | `{1\|ON}` / `{0\|OFF}`; query returns `0`/`1` | 3K p.3 |
| Integer params | Must not be decimals or exponent form | 3K p.4 |
| Strings | Quoted, single or double (`"..."`) | 3K p.4 |
| Single-value return | Real = scientific notation; others per type | 3K p.4 |
| Block return | `#` + one digit N (number of length digits) + N-digit byte count + data + `\n`; example `#3123...` = 123 bytes | 3K p.4 |
| Block return (newer manual) | `#9` + 9-digit byte count + data + `\n`, e.g. `#9000001000` (1000 bytes) **(1K only)** | 1K p.5 |
| Invalid data | ASCII fields `*`; reals return the max representable value **(1K only)** | 1K p.5 |
| Models in 3K manual | UTS1015B (1.5 GHz), UTS3036B (3.6 GHz), UTS3084B (8.4 GHz) | 3K p.59 |

### IEEE 488.2 common commands

| Command | Syntax | Notes | Ref |
|---|---|---|---|
| Identify | `*IDN?` | Manufacturer, model, serial, software version. Text says version is "separated by dot", but example uses commas. Model matches nameplate. | 3K p.5 |
| Reset | `*RST` | Factory defaults; clears errors and send/receive queues. | 3K p.5 |
| Operation complete | `*OPC` / `*OPC?` | `*OPC` sets standard-event bit when current operation finishes. `*OPC?` returns `1` when finished else `0` (manual text wrongly says 1 = unfinished). | 3K p.5 |
| Clear status | `*CLS` | **(1K only)** Clears event and status byte registers. | 1K p.6 |
| Event status enable | `*ESE <int>` / `*ESE?` | **(1K only)** | 1K p.6 |
| Event status register | `*ESR?` | **(1K only)** Integer, read-only. | 1K p.6 |
| Service request enable | `*SRE <int>` / `*SRE?` | **(1K only)** | 1K p.8 |
| Status byte | `*STB?` | **(1K only)** | 1K p.9 |
| Trigger | `*TRG` | **(1K only)** "Initiate an immediate scan". | 1K p.9 |
| Save/recall state | `*SAV <1-16>` / `*RCL <1-16>` | **(1K only)** Equivalent to `:MMEMory:STORe\|LOAD:STATe "STATE_n.state"`. | 1K p.7-8 |
| Error queue | `:SYSTem:ERRor?` | **Not documented in either manual.** | n/a |
| `:STATus` subsystem | none | **Not documented in either manual.** | n/a |
| `*WAI`, `*TST?` | none | Not documented. | n/a |

### Instrument / system (3K p.6-12)

| Command | Syntax | Notes |
|---|---|---|
| Select module | `:INSTrument[:SELect] {SA\|EMI\|AD}`; query returns `SA`/`EMI`/`AD` | SA = spectrum sweep; AD = analog demod. Everything in sections 2-6 below is the SA module. p.6 |
| Module default | `:INSTrument:DEFault` | Restores current module p.6 |
| Factory defaults | `:SYSTem:DEFault` | p.7 |
| Keyboard/touch lock | `:SYSTem:LOCK {{1\|ON}\|{0\|OFF}}` / `?` | p.6 |
| Power-on state | `:SYSTem:PON:TYPE {MODE\|LAST\|USER}` | p.9 |
| Image format | `:SYSTem:PICture:FORMat {BMP\|PNG}` | p.10 |
| LAN config | `:SYSTem:COMMunicate:LAN:IPV4:{ADAPter\|DHCP} {1\|0\|ON\|OFF}`, `...:IPV4:CONFIG "<ip>"`, `...:IPV4:MASK "<mask>"`, `...:IPV4:GATEway "<gw>"` (all with `?`) | p.10-11. Do not expose setters in MCP (can sever the link). |
| Other | `:SYSTem:DISPlay:LANGuage`, `:SYSTem:DISPlay:CFORmat`, `:SYSTem:DISPlay:BACKlight:INTensity`, `:SYSTem:VOLume`, `:SYSTem:OUTPut:HDMI`, `:SYSTem:CONFigure <file>` (binary config read/write) | p.7-9 |
| Front-panel keys | `:KEY:<key>`, `:KEY:<key>:LOCK`, `:KEY:<key>:LED?`, `:KEY:LOCK?` (38-char 0/1 string), `:KEY:LED?` (3-char: TG, Single, TLOCk) | p.12; key names in Appendix 1 p.178 |

## 2. Frequency, amplitude, bandwidth, sweep (3K p.37-39, p.59-69, p.91-94)

All are SA-module commands. Query form is the same string with `?`. Max frequency F_max: UTS3036B 3.6 GHz, UTS3084B 8.4 GHz (UTS3021B 2.1 GHz per 1K Appendix 3, p.427).

### Frequency (p.59-63)

| Function | Command | Parameter / range | Default unit |
|---|---|---|---|
| Start | `[:SENSe]:FREQuency:STARt <freq>` | 0 Hz to F_max - 100 Hz | Hz |
| Stop | `[:SENSe]:FREQuency:STOP <freq>` | 100 Hz to F_max | Hz |
| Center | `[:SENSe]:FREQuency:CENTer <freq>` | 50 Hz to F_max - 50 Hz | Hz |
| Span | `[:SENSe]:FREQuency:SPAN <freq>` | 100 Hz to F_max | Hz |
| Full span | `[:SENSe]:FREQuency:SPAN:FULL` | no query | |
| Zero span | `[:SENSe]:FREQuency:SPAN:ZERO` | no query | |
| Previous span | `[:SENSe]:FREQuency:SPAN:PREVious` | no query | |
| Zoom | `[:SENSe]:FREQuency:ZOOM:IN` / `:ZOOM:OUT` | descriptions contradictory, see section 9 | |
| Auto tune | `[:SENSe]:FREQuency:TUNE:IMMediate` | | |
| Freq offset | `[:SENSe]:FREQuency:OFFSet <freq>` | range unspecified | Hz |
| Center step | `[:SENSe]:FREQuency:CENTer:STEP[:INCRement] <freq>`, `...:STEP:AUTO {1\|0}` | | Hz |
| Input impedance | `:INPut:IMPedance {50\|75}` (**on the UTS3036B only the alias works**, query and setter; alias `[:SENSe]:CORRection:IMPedance[:INPut][:MAGNitude]`) | ohms | p.64 |

### Amplitude (p.37-39, p.63-64, p.94)

| Function | Command | Parameter / range |
|---|---|---|
| Reference level | `:DISPlay:WINDow:TRACe:Y[:SCALe]:RLEVel <real>` | dBm default; range not given (p.37) |
| Ref level offset | `...:RLEVel:OFFSet <real>` | dB (p.38) |
| Scale per division | `:DISPlay:WINDow:TRACe:Y[:SCALe]:PDIVision <real>` | 0.1 to 20 dB (p.37) |
| Y scale type | `:DISPlay:WINDow:TRACe:Y[:SCALe]:SPACing {LOGarithmic\|LINear}` | p.39 |
| Display line | `:DISPlay:WINDow:TRACe:Y:DLINe <ampl>`, `...:DLINe:STATe {1\|0}` | dBm (p.38) |
| Units | `:UNIT:POWer {DBM\|DBMV\|DBUV\|V\|W}` | p.94 |
| Attenuation | `[:SENSe]:POWer[:RF]:ATTenuation <ampl>` | integer dB, 0 to 51 (p.63) |
| Attenuation auto | `[:SENSe]:POWer[:RF]:ATTenuation:AUTO {1\|0}` | p.63 |
| Preamp | `[:SENSe]:POWer[:RF]:GAIN:STATe {1\|0}` | p.64 |
| Preamp band | `[:SENSe]:POWer[:RF]:GAIN:BAND {LOW\|FULL}` | **(1K only)** 1K p.114 |
| Ext. offset corrections | `[:SENSe]:CORRection:SELect <1-10>`, `:CORRection:CSET<n>[:STATe]`, `:CORRection:CSET<n>:DATA <freq,ampl,...>` (Hz, dB), `:CSET<n>:DELete`, `:CSET:ALL[:STATe]` (turns all off), `:CSET:ALL:DELete` | p.70-71 |

### Bandwidth (p.64-66)

| Function | Command | Parameter / range |
|---|---|---|
| RBW | `[:SENSe]:BANDwidth\|BWIDth[:RESolution] <freq>` | Hz; 1 Hz to max RBW (UTS3036B 3 MHz; UTS1015B 1 MHz), 1-3-10 steps |
| RBW auto | `...[:RESolution]:AUTO {1\|0}` | |
| VBW | `[:SENSe]:BANDwidth\|BWIDth:VIDeo <freq>` | Hz; 1 Hz to max VBW (same max as RBW), 1-3-10 |
| VBW auto | `...:VIDeo:AUTO {1\|0}` | |
| VBW/RBW ratio | `...:VIDeo:RATio <ratio>` | UTS3036B 3e-7 to 3e6 |
| Filter shape | `...:SHAPe {GAUSsian\|FLATtop}` | |

### Sweep (p.66-69, p.39, p.91-92)

| Function | Command | Parameter / range |
|---|---|---|
| Sweep time | `[:SENSe]:SWEep:TIME <time>` | seconds; zero span 1 us to 4 ks, non-zero 1 ms to 4 ks |
| Sweep time auto | `[:SENSe]:SWEep:TIME:AUTO {1\|0}`; rule `...:AUTO:RULes {NORMal\|ACCuracy}` | |
| Sweep type | `[:SENSe]:SWEep:TYPE {SWEep\|FFT}`, `...:TYPE:AUTO {1\|0}` | |
| Points | `[:SENSe]:SWEep:POINts <int>` | 11 to 40001 (UTS3036B; UTS1015B 10001) |
| Single/continuous | `:INITiate:CONTinuous {1\|ON\|0\|OFF}` / `?` | 1 = continuous, 0 = single (manual text mislabels both as 1|ON on p.39; 1K p.69 confirms 0 = single). |
| Start/restart sweep | `:INITiate:IMMediate`, `:INITiate:RESTart` | **Verified on the UTS3036B in SA mode (T4).** `:INITiate:STOP`, `:PAUSe` and `:RESume` are rejected with `-113` and have no effect; they are not offered as tools. |
| Trigger source | `:TRIGger[:SEQuence]:SOURce {IMMediate\|EXTernal\|VIDeo}` | p.91; UTS3036B rejects EXTernal (-224). Setting the video level selects VIDeo |
| Ext trigger slope | `:TRIGger[:SEQuence]:EXTernal:SLOPe {POSitive\|NEGative}` | p.91; query gets no reply on the UTS3036B |
| Ext trigger delay | `:TRIGger[:SEQuence]:EXTernal:DELay <time>` | 1 ns to 500 ms (manual writes "1000ps") p.92 |
| Video trigger level | `:TRIGger[:SEQuence]:VIDeo:LEVel <ampl>` | dBm p.92 |

### Detector (p.69)

| Command | Values |
|---|---|
| `[:SENSe]:DETector[:FUNCtion] {SAMPle\|POSitive\|NEGative\|NORMal\|AVERage}` | Current trace; manual says "for advanced measurement ... not suitable for spectrum sweep, TOI, harmonics" |
| `[:SENSe]:DETector:TRACe<n> {same}` | Per trace n (1-6 on UTS3036B) |
| `[:SENSe]:DETector:TRACe<n>:AUTO {1\|0}` | Documented for the 1K only (1K p.113), but **works on the UTS3036B** |

## 3. Trace (3K p.89-91, p.31)

| Function | Command | Notes |
|---|---|---|
| Select trace | `:TRACe:SELect <n>` | 1-6 (UTS3036B/3084B), 1-4 (UTS1015B) |
| Trace mode (per trace) | `:TRACe<n>:TYPE {WRITe\|AVERage\|MAXHold\|MINHold}` | WRITe = clear/write (refresh) |
| Trace mode (current trace) | `:TRACe:TYPE {same}` | |
| Update on/off (live refresh) | `:TRACe<n>:UPDate:STATe {1\|0}` | View/hold |
| Display on/off | `:TRACe<n>:DISPlay[:STATe] {1\|0}` | |
| Average count | `[:SENSe]:AVERage:COUNt <1-999>` | Global; per-measurement counts also exist (below) |
| Average type | `[:SENSe]:AVERage:TYPE {VOLTage\|POWEr\|LOG}` | manual lists "VOLTage" three times as labels; values are VOLTage, POWEr, LOG |
| Trace math | `:CALCulate:MATH <trace>,<type>,<op1>,<op2>,<real>` | type `OFF\|PDIFference\|PSUM\|LDIFference\|LOFFset`; p.26 |
| Clear trace / restart hold or average | no explicit command | **Verified (T5):** re-sending `:TRACe<n>:TYPE <same type>` (also `WRITe` then back, `:TRACe<n>:UPDate:STATe` off then on, or re-sending `:AVERage:COUNt`) restarts the hold/average. `:INITiate:RESTart` and `:INITiate:IMMediate` do **not**. See ambiguity 8. |
| Query forms | `:TRACe:SELect?`, `:TRACe<n>:TYPE?`, `:TRACe:TYPE?` (current trace), `:TRACe<n>:UPDate:STATe?`, `:TRACe<n>:DISPlay:STATe?`, `:AVERage:COUNt?`, `:AVERage:TYPE?` all reply | `:CALCulate:MATH?` (and variants) gets **no reply** (stalls the instrument, posts `-113`): trace math is write-only |

### Trace data transfer

| Topic | 3000B manual | 1K manual |
|---|---|---|
| Read trace | **No trace-data query documented** | `:TRACe[:DATA]? {TRACE1..TRACE6}` (1K p.127) |
| Write trace | none | `:TRACe[:DATA] TRACEn,<v1>,<v2>,...` |
| Format select | none | `:FORMat[:TRACe][:DATA] {ASCll\|REAL32\|REAL64}` / `?` (1K p.68); default ASCII; query returns `ASC8`, `REAL32` or `REAL64` |
| ASCII | n/a | Comma-separated scientific-notation values, no block header; one value per sweep point; unit dBm default (follows `:UNIT:POWer`, unconfirmed) |
| Binary | n/a | IEEE 754 float, 32 or 64 bit, wrapped in the data block header (`#9`+9 digits per 1K p.5; 3K p.4 describes `#`+1 digit N). Byte order not stated. |
| Point count | `[:SENSe]:SWEep:POINts` 11..40001 | Number of values = sweep points |
| X axis | compute: `f_i = start + i*(stop-start)/(points-1)` | not stated; derive from `:FREQuency:STARt?`/`STOP?`/`:SWEep:POINts?`. **Verified (T6, `get_trace_data`):** in zero span start and stop are both the center frequency, so there is no frequency axis (the tool returns a time axis 0..sweep time) |
| Alternate | `:READ:CHPower2?` returns channel-power trace data **(1K only)** (1K p.~70) | |
| Save trace to file | `:MMEMory:STORe:TRACe TRACEn,"<name>.trace"`, `:MMEMory:LOAD:TRACe TRACEn,"<name>.trace"` (3K p.49-50); file lives on the instrument | |

## 4. Markers (3K p.13-26)

`<n>` = marker 1-10; marker trace 1-6. `:CALCulate:MARKer:SELect <1-10>` selects the current marker (p.13). A marker is on only after its mode is not OFF.

| Function | Command | Parameter / return | Ref |
|---|---|---|---|
| Mode (on/off/delta) | `:CALCulate:MARKer<n>:MODE {OFF\|POSition\|DELTa\|FIXed}` | POSition = normal | p.13 |
| Trace assignment | `:CALCulate:MARKer<n>:TRACe <int>` | | p.14 |
| X position | `:CALCulate:MARKer<n>:X <freq>\|<time>` | Hz or s (per X readout type). Query returns Hz (e.g. `1.000000e+09`) | p.14 |
| Y / readout | `:CALCulate:MARKer<n>:Y?` | dBm (or marker-function result: dBm, dBm/Hz). Setter `:Y <ampl>` exists; semantics unclear. | p.14 |
| Delta reference | `:CALCulate:MARKer<n>:REFerence <int>` | other marker number, not itself | p.15 |
| X readout type | `:CALCulate:MARKer<n>:X:READout {FREQuency\|PERiod\|TIME\|ITIMe}`, `...:READout:AUTO {1\|0}` | | p.15-16 |
| Marker lines | `:CALCulate:MARKer<n>:LINes[:STATe] {1\|0}` | | p.16 |
| Marker function | `:CALCulate:MARKer<n>:FUNCtion {OFF\|NOISe\|BPOWer\|BDENsity}`; band: `...:FUNCtion:BAND:SPAN`, `:BAND:LEFT`, `:BAND:RIGHt` (Hz) | result via `:Y?` | p.16-18 |
| N-dB bandwidth | `:CALCulate:MARKer<n>:BANDwidth[:STATe] {1\|0}`, `...:BANDwidth\|BWIDth:NDB <real>` (-0.01 to -140 dB), `...:BANDwidth\|BWIDth:RESult?` (Hz) | | p.18-19 |
| Freq counter | `:CALCulate:MARKer:FCOunt[:STATe] {1\|0}`, `:CALCulate:MARKer:FCOunt:GATetime <time>` (1 us to 500 ms) | counter result query not documented | p.19 |
| All markers off | `:CALCulate:MARKer:AOFF` | no query | p.20 |
| Marker-to-instrument | `:CALCulate:MARKer<n>[:SET]:CENTer`, `:STEP`, `:STARt`, `:STOP`, `:RLEVel` | no args, no return | p.20-21 |
| Marker table | `:CALCulate:MARKer:TABLe[:STATe] {1\|0}` | | p.21 |
| Peak search | `:CALCulate:MARKer<n>:MAXimum[:MAX]` | no return; moves marker to highest peak | p.22 |
| Next peak | `:CALCulate:MARKer<n>:MAXimum:NEXT` | next-highest | p.22 |
| Next left/right | `:CALCulate:MARKer<n>:MAXimum:LEFT` / `:RIGHt` | | p.22-23 |
| Min search | `:CALCulate:MARKer<n>:MINimum` | | p.23 |
| Peak-to-peak | `:CALCulate:MARKer<n>:PTPeak` | | p.23 |
| Continuous peak | `:CALCulate:MARKer<n>:CPSearch[:STATe] {1\|0}` | | p.24 |
| Peak table | `:CALCulate:MARKer:PEAK:TABLe[:STATe] {1\|0}` (also `:TRACe:MATH:PEAK:TABLe:STATe`) | table contents not readable by documented commands | p.24, p.91 |
| Peak threshold | `:CALCulate:MARKer:PEAK:THReshold <ampl>` (+30 to -200 dBm), `...:THReshold:STATe {1\|0}` (auto), `...:THReshold:LINE[:STATe] {1\|0}` | | p.24-25 |
| Peak excursion | `:CALCulate:MARKer:PEAK:EXCursion <ampl>` (0-100 dB), `...:EXCursion:STATe {1\|0}` (auto) | | p.25-26 |

Typical "find peak and read it" sequence (manual's own application example, p.179): set center/span/RBW, `:CALCulate:MARKer1:MAXimum`, then `:CALCulate:MARKer1:X?` and `:CALCulate:MARKer1:Y?`.

## 5. Limit lines (3K p.27-32)

| Function | Command | Notes |
|---|---|---|
| Select | `:CALCulate:LLINe:SELect <n>` | 1-6 (UTS3036B), 1-4 (UTS1015B) |
| Display | `:CALCulate:LLINe<n>:DISPlay {1\|0}` | |
| Test trace | `:CALCulate:LLINe<n>:TRACe <int>` | |
| Type | `:CALCulate:LLINe<n>:TYPE {UPPer\|LOWer}` | |
| Margin | `:CALCulate:LLINe<n>:MARGin <real>` (-40..40 dB), `...:MARGin:STATe {1\|0}` | |
| Data | `:CALCulate:LLINe<n>:DATA <freq,ampl,connect,...>` / `?` | Hz, dBm, connect 0/1 (first point's flag ignored; reads back 1) |
| Copy | `:CALCulate:LLINe<n>:COPY {LLINE1..LLINE6}` | |
| Build from trace | `:CALCulate:LLINe<n>:BUILd {TRACE1..TRACE6}` | |
| Offsets | `:CALCulate:LLINe<n>:OFFSet:X <Hz>`, `:OFFSet:Y <dB>`, `:OFFSet:UPDate` | |
| Delete | `:CALCulate:LLINe<n>:DELete`, `:CALCulate:LLINe:ALL:DELete` | |
| Files | `:MMEMory:LOAD:LIMit LLINEn,"<f>.limit"`, `:MMEMory:STORe:LIMit LLINEn,"<f>.limit"` | p.48-49 |

No pass/fail query for limit lines is documented.

## 6. Tracking generator (called "trace source" in the manual) (3K p.50, p.39, p.93)

| Function | Command |
|---|---|
| Output on/off | `:OUTPut[:EXTernal][:STATe] {1\|0}` (p.50) |
| Output level | `:SOURce[:EXTernal]:POWer[:LEVel][:IMMediate][:AMPLitude] <ampl>` dBm; range unspecified (p.93) |
| Level offset | `:SOURce:CORRection:OFFSet <real>` -200..200 dB (p.93) |
| Reference trace | `:SOURce:TRACe:REFerence:STATe {1\|0}` (p.93) |
| Normalization | `:CALCulate:NTData[:STATe] {1\|0}` (p.27); reference level `:DISPlay:WINDow:TRACe:Y[:SCALe]:NRLevel <dB>` (p.39) |

## 7. Measurement functions (3K p.32-36, p.40-58, p.72-88)

Enter a measurement with `:CONFigure:<meas>` (presets that measurement's parameters; p.32-34) or `:CONFigure:<meas>:NDEFault` (enter without preset; p.35-36). `:CONFigure:SANalyzer` returns to plain sweep. Meas names: `CHPower`, `TPOWer`, `OBWidth`, `TOI`, `ACPower`, `SPECtrogram`, `CNRatio`, `HARMonics`. (The `:CONFigure:TOI:NDEFault` entry prints its syntax as `:CONFigure:TOI:DEFault`; typo.)

**FETCh vs READ** (p.51): `:FETCh:...?` returns the latest result immediately; `:READ:...?` starts a measurement, waits for completion, then returns. Each `FETCh` query has an identical-named `READ` query. All returns are scientific-notation, comma-separated when multiple values.

| Measurement | Result queries (FETCh/READ) | Units | Ref (FETCh p. / READ p.) |
|---|---|---|---|
| Channel power | `:FETCh:CHPower?` (power, density); `:CHPower:CHPower?`; `:CHPower:DENSity?` | dBm, dBm/Hz | 40 / 51 |
| Time-domain power | `:FETCh:TPower?` | dBm | 40 / 52 |
| OBW | `:OBWidth?` (OBW, freq error, xdB BW, total power); `:OBWidth:OBWidth?`; `:OBWidth:FERRor?`; `:OBWidth:XDB?`; `:OBWidth:APOWr?` | Hz, Hz, Hz, dBm | 41-42 / 52-53 |
| TOI | `:TOI:LOW:TRD?`, `:TOI:UP:TRD?` (freq, ampl, dBc coefficient, TOI dBm); `:TOI:LOW:TONE?`, `:TOI:UP:TONE?` (freq, ampl); `:TOI:IPT?` (dBc, dBm) | Hz, dBm, dBc | 42-43 / 53-55 |
| ACPR | `:ACPower?` (main, lower, lower rel., upper, upper rel.); `:ACPower:MAIN?`; `:ACPower:LOWer?`; `:ACPower:UPPer?` | dBm, dBc | 44 / 55-56 |
| C/N | `:CNRatio?` (carrier, noise, C/N); `:CNRatio:CARRier?`; `:CNRatio:NOISe?`; `:CNRatio:CNRatio?` | dBm, dBm, dB | 45-46 / 56-57 |
| Harmonics | `:HARMonics:AMPLitude:ALL?` (fund. dBm then 2nd..10th in dBc); `:AMPLitude<n>?` (n=1-10); `:FREQuency:ALL?`; `:FREQuency<n>?`; `:DISTortion?` (THD %, dBc) | dBm/dBc, Hz, %, dBc | 46-47 / 57-58 |

Measurement parameters (all `[:SENSe]:<meas>:...`, p.72-88): `AVERage[:STATe] {1|0}`, `AVERage:COUNt <1-999>`, `AVERage:TCONtrol {EXPonential|REPeat}`, `AVERage:TYPE {VOLTage|POWEr|LOG}` for CHPower, TPOWer, OBWidth, TOI, ACPower, SPECtrogram, CNRatio, HARMonics. Others: `CHPower:BANDwidth:INTegration <Hz>`; `TPOWer:LLIMit|RLIMit <time 0-10 ms>`; `OBWidth:PERCent <0-1>`, `OBWidth:XDB <-100..-0.1 dB>`; `ACPower:BANDwidth|BWIDth:INTegration <Hz>`, `ACPower:CARRier:LIST:BANDwidth <Hz>`, `ACPower:OFFSet:LIST[:FREQuency] <Hz>`, `ACPower:OFFSet[:OUTer]:LIST:SIDE {BOTH|NEGative|POSitive}`; `CNRatio:BANDwidth:INTegration|NOISe <Hz>`, `CNRatio:OFFSet <Hz>`; `HARMonics:FREQuency:FUNDamental <Hz>`, `HARMonics:NUMBer <2-10>`, `HARMonics:SWEeptime <1 ms-100 s>`.

Newer manual adds numbered forms `:READ:CHPower<n>?`, `:READ:ACPower<n>?`, `:READ:CNRatio<n>?`, `:READ:HARMonics<n>?` where n=1 gives results and n=2 gives trace data **(1K only, 1K p.~70-72)**, and per-measurement `:DETector[:FUNCtion]` settings.

## 8. Screenshot, files

| Function | Command | Notes | Ref |
|---|---|---|---|
| Screenshot | `:DISPlay:ZBmp?` | Returns screen image, "compressed"; compression scheme, header and framing are **not documented** | 3K p.37 |
| Screenshot (newer) | `:DISPlay:DATA?` | **(1K only)** "Returns the screen image"; format follows `:SYSTem:PICture:FORMat {BMP\|PNG}` presumably | 1K p.53 |
| Image format | `:SYSTem:PICture:FORMat {BMP\|PNG}` | | 3K p.10 |
| Save/load state | `:MMEMory:STORe:STATe "<f>.state"`, `:MMEMory:LOAD:STATe "<f>.state"` | on-instrument files | 3K p.48-50 |
| Correction files | `:MMEMory:LOAD\|STORe:CORRection <1-10>,"<f>.corr"` | | 3K p.48-49 |
| No `HCOPy` subsystem | | | |

## 9. Sync / OPC after sweeps

- The 3000B manual documents only `*OPC` / `*OPC?` (p.5). It gives no statement of what "current operation" covers for a sweep, no `:STATus:OPERation` registers, and no `*WAI`. `*ESR?`/`*STB?` exist only in the 1K manual.
- Documented blocking behavior: `:READ:<meas>?` "starts a measurement and waits for the measurement to complete" (p.51). `:FETCh` does not wait.
- Single sweep: `:INITiate:CONTinuous OFF` (single mode). Start with `:INITiate:IMMediate` (documented under EMI, p.114) or `*TRG` (1K) or the Single key (`:KEY:Single`, key name in Appendix 1).
- **Verified (T4): `*OPC?` does NOT block.** While a single sweep runs the instrument ignores every line it receives (nothing is queued, so an `*OPC?` sent then is never answered), and it answers `1` at once otherwise. Working pattern: `:INITiate:CONTinuous OFF`, then `:INITiate:IMMediate` **without** `*OPC?` sync, send nothing for the sweep time (`:SENSe:SWEep:TIME?`; the sweep takes about that long), then poll `*OPC?` with short timeouts; the first reply means the sweep is done. Implemented as `waitForSweepComplete` in `src/acquisition.ts`. `:INITiate:CONTinuous` accepts `ON`/`OFF`/`1`/`0`. In continuous mode nothing can be awaited. SRQ-style polling (`*ESE 1`, `*SRE 32`, `*OPC`, then `*ESR?`/`*STB?`) was also tested and does not work: the unit never sets the operation-complete bits, and real SRQ interrupts are not available over raw TCP (see verified-hardware.md). Over VXI-11 the instrument queues commands during a sweep and a blocking `*OPC?` read does return when the sweep ends (verified on the instrument, see "VXI-11 transport" below).

## 10. Suggested MCP tool groups

| Tool group | Commands |
|---|---|
| connection | open/close TCP socket (port configurable; 5025 verified in this project); `*IDN?`, `*RST` (confirm-gated), `*OPC?`, `*CLS`/`*ESR?` (1K, probe first), `:INSTrument:SELect SA`, `:SYSTem:DEFault` (confirm-gated) |
| frequency | `FREQuency:CENTer/SPAN/STARt/STOP/SPAN:FULL/SPAN:ZERO/OFFSet/CENTer:STEP`; getters for each |
| amplitude | `DISPlay:WINDow:TRACe:Y:RLEVel/PDIVision/SPACing/RLEVel:OFFSet`, `UNIT:POWer`, `POWer:ATTenuation[:AUTO]`, `POWer:GAIN:STATe`, `INPut:IMPedance` |
| bandwidth_sweep | `BANDwidth[:RESolution][:AUTO]`, `BANDwidth:VIDeo[:AUTO]`, `BANDwidth:SHAPe`, `SWEep:TIME[:AUTO]`, `SWEep:POINts`, `SWEep:TYPE`, `DETector:TRACe<n>`, `INITiate:CONTinuous`, `INITiate:IMMediate`/`STOP`, `TRIGger:*`, `AVERage:COUNt/TYPE` |
| trace | `TRACe<n>:TYPE`, `TRACe<n>:UPDate:STATe`, `TRACe<n>:DISPlay`, `TRACe:SELect`, `CALCulate:MATH`; data fetch via `FORMat ASCii` + `TRACe:DATA? TRACEn` (1K command, probe first) and frequency axis computed client-side |
| marker | `MARKer<n>:MODE/TRACe/X/Y?/REFerence/FUNCtion/BAND:SPAN`, `MAXimum`, `MAXimum:NEXT/LEFT/RIGHt`, `MINimum`, `PTPeak`, `AOFF`, `[:SET]:CENTer/STARt/STOP/RLEVel`, `PEAK:THReshold/EXCursion`, `BANDwidth:NDB/RESult?`, `FCOunt` |
| measure | `CONFigure:<meas>`, `READ:<meas>...?`, `FETCh:<meas>...?`, the `[:SENSe]:<meas>:*` parameters, `CONFigure:SANalyzer` to exit |
| screenshot | `SYSTem:PICture:FORMat`, `DISPlay:ZBmp?` (3K) with fallback `DISPlay:DATA?` (1K); parse block header, save to disk, return path |
| limit/tracking-gen (optional) | `CALCulate:LLINe*`, `OUTPut`, `SOURce:POWer`, `CALCulate:NTData` |
| raw_scpi | pass-through with newline termination; auto-detect `?` to read a reply; handle both `#`-block header styles; optional timeout; denylist `:SYSTem:COMMunicate:LAN:*` setters and `:SYSTem:CONFigure` unless explicitly confirmed |

Safety notes: `*RST`, `:SYSTem:DEFault`, `:SYSTem:LOCK`, `:KEY:*:LOCK`, LAN setters, and `MMEMory:STORe` (overwrites on-instrument files) should require explicit confirmation or be omitted from typed tools.

## 11. Ambiguities and items to verify on hardware

1. **Raw TCP port and terminator**: **Verified on UTS3036B V1.04.0040 (P1):** raw TCP port 5025 works; `\n`, `\r\n`, `\r` and even no terminator all produced a reply. Replies end with a newline. Use `\n` for commands.
2. **Error queue**: **Verified (P1):** `:SYSTem:ERRor?` works and returned `0,"No error"`. `:SYSTem:ERRor:NEXT?`, `:STATus:OPERation:CONDition?`, `:STATus:QUEStionable:CONDition?` and `:SYSTem:VERSion?` gave no reply (unsupported). Unsupported queries produce **no reply and no error text**, so callers must use timeouts. Whether an unknown command is pushed to the error queue is not yet tested.
3. **`*CLS`, `*ESR?`, `*STB?`, `*TRG`**: **Verified (P1):** `*OPC?`, `*ESR?`, `*STB?`, `*ESE?`, `*SRE?` reply (`1`, `0`, `0`, `0`, `0` at idle) and `*CLS` is accepted. `*TRG`, `*SAV`, `*RCL` not probed.
4. **Trace data**: **Verified (P2, UTS3036B V1.04.0040):** `:TRACe:DATA? TRACE1` works. ASCII (default): 1001 comma-separated values like `-6.112838e+01` with no spaces, ending in `\r\n`; count equals `:SWEep:POINts?`; units follow `:UNIT:POWer?` (`DBM`). Fixtures: `tests/fixtures/p2/`. (Original note: absent from the 3K manual and present in 1K.) Confirm on hardware, including the ASCII separator, trailing newline, whether point count equals `:SWEep:POINts?`, the unit under non-dBm `:UNIT:POWer`, and whether trace n must be selected first.
5. **Binary block header**: **Verified (P2):** `:FORMat REAL32` / `REAL64` give `#4` + a 4-digit **byte** length (4004 / 8008), then big-endian IEEE 754 floats (1001 values), then `\r\n`. Byte order is **big-endian**. `:FORMat?` returns `ASC8` but the setter only accepts `ASCii` (sending `ASC8` is ignored). (Original note:) 3K p.4 says `#<N><len>`, 1K p.5 says `#9<9-digit len>`. Parse generically. `REAL32`/`REAL64` byte order and whether the block length counts bytes or values are unstated; the manual calls them "integer" but cites IEEE 754 floats. `:FORMat?` returns `ASC8` while the setter is `ASCll`; check the actual token.
6. **Single-sweep start**: **Resolved (T4):** `:INITiate:IMMediate` and `:RESTart` work in SA mode; `STOP`/`PAUSe`/`RESume` give `-113`. `:INITiate:CONTinuous` accepts ON/OFF/1/0 (0 = single).
7. **Sweep completion**: **Resolved (T4):** `*OPC?` does not block; the instrument ignores (drops) every command sent on the raw port during a single sweep. See section 9.
8. **Clear trace / reset averaging**: **Resolved (T5, UTS3036B V1.04.0040):** no dedicated command. Re-sending `:TRACe<n>:TYPE <current type>` restarts max/min hold and averaging (so do `WRITe` then back, update state off/on and re-sending `[:SENSe]:AVERage:COUNt`); `:INITiate:RESTart` and `:INITiate:IMMediate` do **not** restart a hold (in continuous mode with an average trace they also make the instrument ignore commands for about count x sweep time). `:AVERage:COUNt` is global, not per trace, and no "average count reached" query exists. The `restart_trace` tool does the re-send.
9. **Appendix example inconsistency**: p.179 example uses `:trace1:mode write` and `:key:default`, neither defined in the command list (list defines `:TRACe<n>:TYPE`). **Verified (T5):** `:trace1:mode write` gives `-113 "Undefined header"`; use `TYPE`. `:KEY:Default` was not sent (it is a preset and the project never sends presets).
10. **`:CALCulate:MARKer<n>:Y?` semantics**: returns the marker-function result when a function (NOISe/BPOWer/BDENsity) is on. For DELTa mode, whether `X?`/`Y?` return absolute or relative values is unstated. Marker auto-on when `MAXimum` is sent while MODE=OFF is unstated. Query of `:CALCulate:MARKer:FCOunt` result is not documented.
11. **`:SENSe:DETector[:FUNCtion]`** is described as "for advanced measurement" and not applicable to plain sweep; use `:DETector:TRACe<n>` for spectrum traces. Detector `AUTO` per trace is 1K only.
12. **Zoom commands**: `:FREQuency:ZOOM:IN` text says it "expands the sweep bandwidth", `ZOOM:OUT` says it "reduces" it; direction ambiguous. Avoid; set span explicitly.
13. **Limits and ranges not given** (resolved on the UTS3036B for amplitude: values clamp silently, and bare numbers and unit suffixes both work; see [verified-hardware.md](verified-hardware.md)): reference level range, `SOURce:POWer` range, frequency offset range, attenuation step (only "integer 0-51"), whether out-of-range values clamp or error, whether bare numbers are accepted vs. needing unit suffix (examples use both).
14. **Screenshot**: **Partly verified (P2) - the transfer is truncated over raw TCP (144,800 bytes) but complete over VXI-11 (issue #75): use VXI-11 for a screenshot, `:DISPlay:DATA?` gives a 1280 x 800 32 bit BMP (4,096,054 bytes), or a PNG after `:SYSTem:PICture:FORMat PNG`, and `:DISPlay:ZBmp?` the compressed stream (200 KB).** Over raw TCP: `:DISPlay:ZBmp?` replies `#9` + 9-digit length (198908, 202898 on different captures, so it is compressed), then a `0x03` byte, then a BMP-like stream; `:DISPlay:DATA?` replies `#7` + `4096054` followed directly by an uncompressed `BM` bitmap, and returned nothing after `:SYSTem:PICture:FORMat PNG` was set (which the instrument accepts but ZBmp still returned bitmap data). In every case the instrument stops after exactly 144,800 bytes (100 TCP segments of 1448 bytes), far short of the declared length, with the sweep running or paused, with nc or a slow reader. Needs investigation (see the screenshot issue). (Original note:) `:DISPlay:ZBmp?` payload is "compressed" with unspecified algorithm and framing; test it against `:DISPlay:DATA?` and `:SYSTem:PICture:FORMat`.
15. **`*IDN?`**: **Verified (P1):** comma-separated `UNI-TREND,UTS3036B,<serial>,V1.04.0040`; manufacturer string is `UNI-TREND`, not the manual's `UNI-T Technologies`.
16. **Typos in boolean descriptions** (several `1|ON` listed twice in place of `0|OFF`; `*OPC?` "1 = unfinished"; `:SYSTem:LOCK?` "0 = unlocked / 1 = unlocked"). Assume 1 = on/true/finished.
17. **Peak-table / marker-table contents** and **limit-line pass/fail** have no documented read-back.
18. **Parameter coupling**: setting `SPAN`, `STARt`, `STOP`, `CENTer` interact; setting RBW/VBW/sweep time with AUTO on may be overridden. Re-query after set.
19. **Query response for set-only commands** (`SPAN:FULL`, `MAXimum`, etc.) is "No return value"; use `*OPC?` or a follow-up query to know it completed.

## 12. UTS1000B/T differences (from the UTS1000B/T manual, 427 pp)

- That manual is a superset covering UTS5000A, UTS3000A/B/T/T+, UTS1000B/T (cover p.1) and is dated 2024-09; its Appendix 3 (p.427) lists per-model limits: UTS1015B/1032B/1015T/1032T = 1.5/3.2 GHz, max RBW 1 MHz, 10001 points, 4 traces, 4 limit lines; UTS3021B 2.1 GHz, UTS3036B 3.6 GHz, UTS3084B/T 8.4 GHz, max RBW 3 MHz, 40001 points, 6 traces, 6 limit lines; UTS3015T+/3032T+ same as 1000 class; UTS3036T+/3084T+ same as 3000 class.
- Adds: `*CLS *ESE *ESR? *SRE *STB? *TRG *SAV *RCL`; `:FORMat[:TRACe][:DATA]`; `:TRACe[:DATA]`; `:DISPlay:DATA?` (replacing `:DISPlay:ZBmp?`); `[:SENSe]:POWer[:RF]:GAIN:BAND {LOW|FULL}`; `:SYSTem:COMMunicate:{LAN:STATe?,MAC?,USB:STATe?,KEYBoard:STATe?,MOUSe:STATe?}`; numbered `READ:<meas><n>?` queries; per-measurement `DETector[:FUNCtion]`; IQ and real-time analysis modules.
- Fixes `:INITiate:CONTinuous` description (0|OFF = single sweep).
- Uses `#9`+9-digit block header (3K manual: single-digit length-of-length).
- Both manuals share the `:CALCulate:MARKer`, `:SENSe:FREQuency/BANDwidth/SWEep/DETector`, `:TRACe<n>:TYPE`, `:UNIT:POWer`, `:DISPlay:WINDow:TRACe:Y` families unchanged in syntax.
- Neither manual documents a LAN raw-socket port or an error queue.

## Verified query replies (P1, UTS3036B V1.04.0040)

`:INITiate:CONTinuous?` -> `1`; `:SWEep:POINts?` -> `1001`; `:SWEep:TIME?` -> `2.647500e-03 ` (note trailing space); `:FORMat?` -> `ASC8` (so `:FORMat` exists on the 3000B). Raw probe output: `tests/fixtures/p1-basics-probe.txt`.

## Instrument timing behavior (verified on UTS3036B V1.04.0040)

See `docs/verified-hardware.md` (command timing and error queue). Summary: sync every command with `*OPC?`, one query at a time, expect a ~2.15 s stall after an unsupported query, and use `*CLS` before setters so `:SYSTem:ERRor?` only shows errors from the current operation.

## Hand probing from any OS

Send one query per fresh connection and wait at least 2.5 s after a query that got no reply (see the timing notes above).

Unix-only (Linux/macOS; needs `nc` and `printf`):

```sh
(printf '*IDN?\n'; sleep 0.7) | nc -w 2 "$UTS_IP" 5025
```

Portable (any OS with Node 22+; works in bash, PowerShell and cmd; pass the host as the first argument):

```sh
node -e "const s=require('node:net').connect(5025,process.argv[1],()=>s.write(process.argv[2]+'\n'));s.on('data',d=>{process.stdout.write(d);s.end()});setTimeout(()=>s.destroy(),2500)" 192.168.1.100 "*IDN?"
```

On Windows cmd/PowerShell the SCPI command may need quoting so the shell does not treat `*` or `?` specially; the double quotes above are enough in both.

## VXI-11 wire layer (ONC RPC over TCP; `src/vxi11/`)

The UTS3036B also answers VXI-11 (see issue #64). The RPC layer under it is implemented in `src/vxi11/` with no dependencies and was checked against the real instrument with a prototype:

- The portmapper (program 100000 v2, procedure 3 `GETPORT`, TCP port 111) returns the dynamic TCP port of the VXI-11 core program 395183 v1 (`0` means not registered).
- Calls use ONC RPC v2 with AUTH_NONE. TCP messages are record-marked: a 4-byte big-endian header whose top bit (`0x80000000`) marks the last fragment and whose low 31 bits are the fragment length. In JavaScript the header must be built and read with `>>> 0`, because bitwise operators are signed 32-bit.
- Replies are matched by xid; `MSG_DENIED` and non-`SUCCESS` `accept_stat` values become typed errors (`RpcDeniedError`, `RpcAcceptError`).
- Limits applied to network input: records are capped at 4 MiB, opaque/string values at 16 MiB, record fragments at 4096, authentication bodies at 400 bytes. Violations close the connection with `RpcProtocolError`.
- `tests/fakeRpcServer.ts` is an in-process fake RPC server and portmapper for hardware-free tests.

### VXI-11 core channel client (`src/vxi11/client.ts`)

`Vxi11Client` speaks the VXI-11 core channel (program 395183 v1) on top of the RPC layer. It is used by the VXI-11 transport (next section).

- `Vxi11Client.connect(host, { device = "inst0", port?, portmapperPort?, connectTimeoutMs?, rpcMarginMs?, closeTimeoutMs? })` asks the portmapper for the core port unless `port` is given, opens the connection and calls `create_link` (procedure 10). It exposes `linkId`, `maxRecvSize` (1 MiB on the UTS3036B) and `abortPort` (reported as 111; unused, there is no abort channel).
- `write(data, { timeoutMs, end = true })` is `device_write` (11). Data longer than `maxRecvSize` is split; the END flag (8) is set only on the last chunk. If the instrument accepts fewer bytes than sent, the rest is sent again.
- `read({ timeoutMs, maxBytes })` is `device_read` (12), repeated until the reply reason has END (4) or CHR (2), or `maxBytes` is reached (reason REQCNT, 1); it returns `{ data, end }`. `timeoutMs` bounds the whole read, so a long timeout makes it a blocking read: on the UTS3036B a queued `*OPC?` is answered only when the running sweep ends (a 4.0 s sweep answered at about 4.09-4.13 s).
- `readStb()` (`device_readstb`, 13) and `clear()` (`device_clear`, 15). On the UTS3036B the serial poll answers in about 1 ms, but the status byte stays 0x00.
- `close()` calls `destroy_link` (23) best effort (bounded wait), then closes the connection; it never rejects and is idempotent.
- Errors: a non-zero VXI-11 error code becomes `Vxi11DeviceError` with `code` and `codeName` (1 SYNTAX_ERROR, 3 DEVICE_NOT_ACCESSIBLE, 4 INVALID_LINK_IDENTIFIER, 5 PARAMETER_ERROR, 6 CHANNEL_NOT_ESTABLISHED, 8 OPERATION_NOT_SUPPORTED, 9 OUT_OF_RESOURCES, 11 DEVICE_LOCKED_BY_ANOTHER_LINK, 12 NO_LOCK_HELD_BY_THIS_LINK, 15 IO_TIMEOUT, 17 IO_ERROR, 21 INVALID_ADDRESS, 23 ABORT); 15 is `Vxi11IoTimeoutError` and 11 is `Vxi11LockedError`. Connection problems are `Vxi11ConnectError`, a dropped connection or a lost RPC reply is `Vxi11TransportError`, a malformed or out-of-range reply is `Vxi11ProtocolError`, and calls on a closed client are `Vxi11ClosedError`.
- Every call has a deadline (the I/O timeout plus `rpcMarginMs`, default 5 s), so a promise never stays pending if the instrument stops answering or drops the connection. Reply fields are validated (reason bits, sizes against the request, status byte range, no trailing bytes) and reads are capped at 16 MiB. `write` and `read` each enforce one overall deadline across all their chunks (a server answering a byte at a time cannot stretch it; later calls are refused with `Vxi11IoTimeoutError` and never get a 0 ms I/O timeout) and cap the number of RPC calls (`maxCalls`, default 10000, exceeded means `Vxi11ProtocolError`).
- The interrupt channel (`create_intr_chan`, `device_enable_srq`) is not implemented: the instrument never connects back and the status byte never changes.
- `tests/fakeVxi11Instrument.ts` simulates all of this without hardware, including a sweep that queues commands (they are not dropped, unlike on the raw socket) and answers `*OPC?` only when it ends.

### VXI-11 transport (`src/transports/vxi11.ts`, `src/transports/select.ts`)

`Vxi11Transport` implements the `Transport` interface on `Vxi11Client`, so every tool works over it unchanged. Selection:

- `UTS_TRANSPORT=raw|vxi11|auto` (default `auto`; a `UTS_PORT` or `port` without any transport choice means `raw`) or the `transport` parameter of `connect`. `auto` asks the portmapper on TCP port 111 for the VXI-11 core program; if it is registered and the link opens (`create_link`, then `*IDN?`) VXI-11 is used, otherwise the raw transport is used and the reason is logged (and shown in the `Transport:` line of `connect`). `vxi11` never falls back: a failure is an error.
- `UTS_VXI11_DEVICE` is the logical device name (default `inst0`, the name the UTS3036B accepts; the VISA resource string is `TCPIP0::<ip>::inst0::INSTR`). It is validated (1 to 64 characters from letters, digits and `. _ , -`) before anything is sent. The raw TCP port (`UTS_PORT`) does not apply to VXI-11; the portmapper port is fixed at 111.
- Firewall: allow outbound TCP to port 111 and to the dynamic core-channel port the portmapper reports (it was 56569 in one test and changes between restarts). The interrupt channel is not used, so no inbound connection is needed.

Capability flags (`VXI11_CAPABILITIES`, explicit constants in `src/transports/vxi11.ts`, all confirmed on the UTS3036B for issue #75):

| Flag | VXI-11 | Meaning |
|------|--------|---------|
| `syncsCommands` | false | no `*OPC?` after each command: `device_write` returns when the instrument accepted the line, and bursts, set-then-query and setter-then-`:SYSTem:ERRor?` are all in order and correct without pacing |
| `dropsInputDuringSweep` | false | commands and queries sent during a single sweep are queued and answered when it ends |
| `holdOffAfterTimeout` | false | no quiet period after a timed-out query: nothing sent afterwards is lost (the instrument itself delays the next write while it is busy with the abandoned read) |

Messages are written as one `device_write` with END and no terminator; a reply is read with `device_read` until END.

**Timeouts on this instrument (measured; see verified-hardware.md).** A `device_read` with nothing to deliver is never answered with error 15: the instrument waits 5.4 times the `io_timeout`, drops the request without a reply and serves no other call on the link until then. An `io_timeout` of 0 returns error 15 at once even when a reply is waiting. The transport therefore sends one fifth of the requested timeout as `io_timeout` (`Vxi11ReadOptions.ioTimeoutFraction`), ends a timed-out query with the RPC deadline (timeout plus a 500 ms margin, `Vxi11RpcTimeoutError`, mapped to `TransportTimeout`) and keeps the link; a `device_write` that has to wait behind an abandoned read gets extra time. The output buffer has one slot (a newer reply replaces an unread one), so a stale reply cannot be mistaken for the next query's answer and no drain step is needed. A dropped connection is reported as `Connection to the spectrum analyzer was lost (VXI-11: ...)`.

**Sweep wait over VXI-11.** `src/acquisition.ts` chooses the method from the `dropsInputDuringSweep` flag, not from the transport name. Where input is queued (VXI-11), `startSweep` reads the sweep time and writes `:INITiate:IMMediate`; `waitForSweepComplete` then writes `*OPC?` once and does one `device_read` with timeout = remaining sweep time + 10 s (or the tool's `timeout_s`). The instrument answers `1` when the sweep ends, so there is no silent period and no polling (measured: 4.1 s for a 4 s sweep, 190 ms for 0.1 s). A timeout is a `SweepTimeoutError` that names the blocking `*OPC?` read over VXI-11; the sweep keeps running and later commands are queued behind it. The raw transport keeps the silent-then-poll method of section 9.

If the flags ever need to change for another firmware, change the constants in `VXI11_CAPABILITIES`; nothing else has to change.

Verified on the real UTS3036B (issue #75) as well as against the in-process fake VXI-11 instrument (`tests/fakeVxi11Instrument.ts`, whose `firmware: true` option reproduces the read behavior above).
