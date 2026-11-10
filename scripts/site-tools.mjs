// Generates the "tools" part of the GitHub Pages site from docs/tools-reference.md, so the page
// cannot drift from the documentation (a test already guarantees that file covers every tool).

const MAX_SUMMARY = 200;

/** Plain text for a summary: drop markdown links, bold and inline-code markers. */
function plain(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text) {
  let end = text.length;
  for (const m of text.matchAll(/\.(\s|$)/g)) {
    const before = text.slice(0, m.index);
    if (/\b(e\.g|i\.e|etc)$/i.test(before)) continue;
    end = m.index + 1;
    break;
  }
  let sentence = text.slice(0, end).trim();
  if (sentence.length > MAX_SUMMARY) {
    sentence = sentence.slice(0, MAX_SUMMARY - 3).replace(/\s+\S*$/, "") + "…";
  }
  return sentence;
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
    const summary = section.lines.length > 0 ? firstSentence(plain(section.lines.join(" "))) : "";
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

/** One Windows-95 style window per tool group. */
export function renderToolGroups(groups) {
  const windows = groups.map((group) => {
    const id = `group-${slug(group.name)}`;
    const items = group.tools
      .map((tool) => `<li><code>${esc(tool.name)}</code><span>${esc(tool.summary)}</span></li>`)
      .join("\n        ");
    return `    <section class="win tool-group reveal" aria-labelledby="${id}">
      <div class="win-bar">
        <h3 class="win-title" id="${id}">${esc(group.name)}</h3>
        <span class="win-file" aria-hidden="true">${esc(slug(group.name))}.exe</span>
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
export function renderSite(template, groups) {
  if (!template.includes("<!--TOOLS-->")) {
    throw new Error("Template is missing the <!--TOOLS--> placeholder");
  }
  const toolCount = groups.reduce((n, g) => n + g.tools.length, 0);
  return template
    .split("{{TOOL_COUNT}}").join(String(toolCount))
    .split("{{GROUP_COUNT}}").join(String(groups.length))
    .split("<!--TOOLS-->").join(renderToolGroups(groups));
}
