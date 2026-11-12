import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryParsed, readBack } from "../instrument.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: `:CALCulate:FSCan:SLISt...` (programming manual pp.96-104; docs/research/emi-function.md
// section 3.5). The manual documents NO command to read the signal table itself (no query returns
// its contents), and most of these actions have no read-back at all - only sort type/order are
// queryable. A command whose numeric suffix is written with a leading space in the manual's own
// listing (`:SLISt:REPLace:METer <n>`, `:SLISt:SET:METer <n>`, `:SLISt:DELete:SIGNal <n>`,
// `:SLISt:MARK:SIGNal <n>`, `:SLISt:MARK:CLEar:SIGNal <n>`, `:SLISt:ZOOM [<n>]`,
// `:ZOOM:OUT [<n>]`) is sent here as a header plus a space-separated argument, not a header suffix
// (unlike e.g. `METer<n>:DETector` elsewhere in the manual, which has no space); `:SLISt:APPend:METer`
// is listed with no argument at all and is sent with none. This reading has not been independently
// live-verified (EMI-12, #187, needs the owner present at the analyzer).

const SIGNAL = z.number().int().min(1).max(1000).describe("Signal number in the table, 1 to 1000 (the manual documents both 1000 and 1001 as the upper bound)");
const METER = z.number().int().min(1).max(3).describe("Meter number, 1 to 3");
const MARKER = z.number().int().min(1).max(6).describe("Marker number, 1 to 6");

const SORT_TYPES = { frequency: "FREQuency", amplitude1: "DAMPlitude1", amplitude2: "DAMPlitude2", amplitude3: "DAMPlitude3", delta1: "DLDelta1", delta2: "DLDelta2", delta3: "DLDelta3" } as const;
type SortTypeName = keyof typeof SORT_TYPES;
const SORT_ORDERS = { ascending: "ASCending", descending: "DESCending" } as const;
type SortOrderName = keyof typeof SORT_ORDERS;

function parseSortType(reply: string): SortTypeName {
  const text = reply.trim().toUpperCase();
  for (const [name, raw] of Object.entries(SORT_TYPES) as Array<[SortTypeName, string]>) {
    if (text === raw.toUpperCase() || text === raw.replace(/[a-z]/g, "").toUpperCase()) return name;
  }
  throw new Error(`Unexpected sort type ${JSON.stringify(reply)}`);
}

function parseSortOrder(reply: string): SortOrderName {
  const text = reply.trim().toUpperCase();
  for (const [name, raw] of Object.entries(SORT_ORDERS) as Array<[SortOrderName, string]>) {
    if (text === raw.toUpperCase() || text === raw.replace(/[a-z]/g, "").toUpperCase()) return name;
  }
  throw new Error(`Unexpected sort order ${JSON.stringify(reply)}`);
}

const SL = ":CALCulate:FSCan:SLISt";

const ACTIONS = {
  add_marker: { needs: "marker" as const, command: (a: { marker: number }) => `:CALCulate:FSCan:MARKer${a.marker}:SET:SLISt` },
  add_marker_measurement: { needs: "none" as const, command: () => ":CALCulate:FSCan:MAMarker:SET:SLISt" },
  replace_with_meter: { needs: "meter" as const, command: (a: { meter: number }) => `${SL}:REPLace:METer ${a.meter}` },
  append_meter: { needs: "none" as const, command: () => `${SL}:APPend:METer` },
  delete: { needs: "signal" as const, command: (a: { signal: number }) => `${SL}:DELete:SIGNal ${a.signal}` },
  mark: { needs: "signal" as const, command: (a: { signal: number }) => `${SL}:MARK:SIGNal ${a.signal}` },
  mark_all: { needs: "none" as const, command: () => `${SL}:MARK:ALL` },
  clear_mark: { needs: "signal" as const, command: (a: { signal: number }) => `${SL}:MARK:CLEar:SIGNal ${a.signal}` },
  clear_marks: { needs: "none" as const, command: () => `${SL}:MARK:CLEar:ALL` },
  set_meter: { needs: "meter" as const, command: (a: { meter: number }) => `${SL}:SET:METer ${a.meter}` },
  zoom_in: { needs: "optionalSignal" as const, command: (a: { signal?: number }) => `${SL}:ZOOM${a.signal !== undefined ? ` ${a.signal}` : ""}` },
  zoom_out: { needs: "optionalSignal" as const, command: (a: { signal?: number }) => `${SL}:ZOOM:OUT${a.signal !== undefined ? ` ${a.signal}` : ""}` },
} as const;
type ActionName = keyof typeof ACTIONS;

function validate(a: { action: ActionName; signal?: number; meter?: number; marker?: number }): string | undefined {
  const spec = ACTIONS[a.action];
  if (spec.needs === "signal" && a.signal === undefined) return `action ${a.action} requires signal.`;
  if (spec.needs === "meter" && a.meter === undefined) return `action ${a.action} requires meter.`;
  if (spec.needs === "marker" && a.marker === undefined) return `action ${a.action} requires marker.`;
  return undefined;
}

export function registerEmiSignalListTools(server: McpServer): void {
  defineTool(
    server,
    "emi_signal_list",
    "Act on the EMI module's signal table (peak table): add the current marker's frequency or measurement to the list, " +
      "replace or append a row from a meter reading, delete or mark/unmark a signal, set which meter a marker couples to, or zoom the list view. " +
      "The manual documents NO command to read the table's contents and none of these actions has a read-back, " +
      "so the result only confirms the command was accepted (no instrument error); to see the actual list, use the screenshot tool over VXI-11.",
    {
      action: z.enum(Object.keys(ACTIONS) as [ActionName, ...ActionName[]]).describe("Which signal-list action to run"),
      signal: SIGNAL.optional().describe("Signal number (delete, mark, clear_mark; optional for zoom_in/zoom_out)"),
      meter: METER.optional().describe("Meter number (replace_with_meter, set_meter)"),
      marker: MARKER.optional().describe("Marker number (add_marker)"),
    },
    { readOnlyHint: false },
    async (a) => {
      try {
        const spec = ACTIONS[a.action];
        const command = (spec.command as (args: typeof a) => string)(a);
        await applyCommands([command]);
        return textResult(JSON.stringify({ action: a.action, accepted: true, note: "No read-back exists for this action; verify visually with the screenshot tool over VXI-11." }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_emi_signal_list_sort");
      }
    },
    { validate, requireModule: "emi" }
  );

  defineTool(
    server,
    "get_emi_signal_list_sort",
    "Read the EMI module signal list's sort type and order - the only part of the signal table the manual documents as queryable.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const sort_type = await queryParsed(`${SL}:SORT:TYPE?`, parseSortType);
        const sort_order = await queryParsed(`${SL}:SORT:ORDer?`, parseSortOrder);
        return textResult(JSON.stringify({ sort_type, sort_order }, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { requireModule: "emi" }
  );

  defineTool(
    server,
    "set_emi_signal_list_sort",
    "Set the EMI module signal list's sort type and/or order. Read back afterward; anything the instrument did not take is a `warnings` entry.",
    {
      sort_type: z.enum(Object.keys(SORT_TYPES) as [SortTypeName, ...SortTypeName[]]).optional().describe("frequency, or amplitude/delta for trace 1-3"),
      sort_order: z.enum(Object.keys(SORT_ORDERS) as [SortOrderName, ...SortOrderName[]]).optional(),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (a) => {
      try {
        const commands: string[] = [];
        if (a.sort_type !== undefined) commands.push(`${SL}:SORT:TYPE ${SORT_TYPES[a.sort_type]}`);
        if (a.sort_order !== undefined) commands.push(`${SL}:SORT:ORDer ${SORT_ORDERS[a.sort_order]}`);
        await applyCommands(commands);
        const { sort_type, sort_order } = await readBack(async () => ({
          sort_type: await queryParsed(`${SL}:SORT:TYPE?`, parseSortType),
          sort_order: await queryParsed(`${SL}:SORT:ORDer?`, parseSortOrder),
        }));
        const warnings: string[] = [];
        if (a.sort_type !== undefined && a.sort_type !== sort_type) warnings.push(`sort_type adjusted by the instrument: requested ${a.sort_type}, now ${sort_type}`);
        if (a.sort_order !== undefined && a.sort_order !== sort_order) warnings.push(`sort_order adjusted by the instrument: requested ${a.sort_order}, now ${sort_order}`);
        return textResult(JSON.stringify({ sort_type, sort_order, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_emi_signal_list_sort");
      }
    },
    {
      validate: (a) => (a.sort_type === undefined && a.sort_order === undefined ? "No parameters given; provide sort_type and/or sort_order." : undefined),
      requireModule: "emi",
    }
  );
}
