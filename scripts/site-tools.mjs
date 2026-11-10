// Generates the "tools" part of the GitHub Pages site from docs/tools-reference.md, so the page
// cannot drift from the documentation (a test already guarantees that file covers every tool).

const MAX_SUMMARY = 170;

/** Plain text for a summary: drop markdown links, bold and inline-code markers. */
function plain(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split into sentences at ". " (not after e.g./i.e./etc). */
function sentences(text) {
  const out = [];
  let from = 0;
  for (const m of text.matchAll(/\.(\s|$)/g)) {
    if (/\b(e\.g|i\.e|etc)$/i.test(text.slice(0, m.index))) continue;
    out.push(text.slice(from, m.index + 1).trim());
    from = m.index + m[0].length;
  }
  if (from < text.length) out.push(text.slice(from).trim());
  return out.filter(Boolean);
}

/** One readable line: first sentence (plus the next when the first is tiny, like "Read-only."), cut cleanly. */
function summarize(text) {
  const parts = sentences(plain(text));
  if (parts.length === 0) return "";
  let line = parts[0];
  if (line.length < 15 && parts[1]) line = `${line} ${parts[1]}`;
  if (line.length <= MAX_SUMMARY) return line;
  const window = line.slice(0, MAX_SUMMARY);
  const semi = window.lastIndexOf(";");
  if (semi >= 40) return `${window.slice(0, semi)}.`;
  const comma = window.lastIndexOf(", ");
  if (comma >= 60) return `${window.slice(0, comma)}…`;
  return `${window.replace(/\s+\S*$/, "")}…`;
}

/**
 * Read groups (`## Name`) and tools (`### \`a\` / \`b\``) from the tools reference. Each tool gets
 * the first sentence of the first paragraph under its heading; groups without tools are dropped.
 */
export function parseToolsReference(markdown) {
  const groups = [];
  let group = null;
  let section = null; // { tools, lines, done }

  const finish = () => {
    if (!section) return;
    const summary = section.lines.length > 0 ? summarize(section.lines.join(" ")) : "";
    for (const tool of section.tools) tool.summary = summary;
    section = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s+\S/.test(line) && !line.startsWith("###")) {
      finish();
      group = { name: line.replace(/^##\s+/, "").trim(), tools: [] };
      groups.push(group);
    } else if (line.startsWith("###")) {
      finish();
      const names = [...line.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]);
      if (group && names.length > 0) {
        const tools = names.map((name) => ({ name, summary: "" }));
        group.tools.push(...tools);
        section = { tools, lines: [], done: false };
      }
    } else if (section && !section.done) {
      const trimmed = line.trim();
      if (trimmed === "") {
        if (section.lines.length > 0) section.done = true;
      } else if (/^[|#>-]/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
        if (section.lines.length > 0) section.done = true;
      } else {
        section.lines.push(trimmed);
      }
    }
  }
  finish();
  return groups.filter((g) => g.tools.length > 0);
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";

/** One Windows-95 style window per tool group. `descriptions` (name -> text) override the docs summaries. */
export function renderToolGroups(groups, descriptions = {}) {
  const windows = groups.map((group) => {
    const id = `group-${slug(group.name)}`;
    // Tools that share one summary (a `get_x` / `set_x` heading) become a single row.
    const rows = [];
    for (const tool of group.tools) {
      const summary = descriptions[tool.name] ? summarize(descriptions[tool.name]) : tool.summary;
      const last = rows[rows.length - 1];
      if (last && last.summary === summary && summary !== "") last.names.push(tool.name);
      else rows.push({ names: [tool.name], summary });
    }
    const items = rows
      .map((row) => `<li>${row.names.map((n) => `<code>${esc(n)}</code>`).join(" ")}<span>${esc(row.summary)}</span></li>`)
      .join("\n        ");
    const file = slug(group.name).length <= 14 ? `\n        <span class="win-file" aria-hidden="true">${esc(slug(group.name))}.exe</span>` : "";
    return `    <section class="win tool-group reveal" aria-labelledby="${id}">
      <div class="win-bar">
        <h3 class="win-title" id="${id}">${esc(group.name)}</h3>${file}
        <span class="win-btns" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>
      <ul class="tool-list">
        ${items}
      </ul>
    </section>`;
  });
  return `<div class="tool-groups">\n${windows.join("\n")}\n  </div>`;
}

/** Fill the template's placeholders; fails loudly when the tools placeholder is missing. */
export function renderSite(template, groups, descriptions = {}) {
  if (!template.includes("<!--TOOLS-->")) {
    throw new Error("Template is missing the <!--TOOLS--> placeholder");
  }
  const toolCount = groups.reduce((n, g) => n + g.tools.length, 0);
  return template
    .split("{{TOOL_COUNT}}").join(String(toolCount))
    .split("{{GROUP_COUNT}}").join(String(groups.length))
    .split("<!--TOOLS-->").join(renderToolGroups(groups, descriptions));
}
