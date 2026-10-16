import { createElement, type ReactNode } from "react";

export type Inline = string | { kind: "strong"; children: Inline[] } | { kind: "code"; text: string };
export type MarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

// 只识别白名单标记。HTML、链接和未闭合标记始终是 React 文本，不解释为 DOM。
export function parseInline(text: string): Inline[] {
  const stack: Inline[][] = [[]];
  const append = (value: Inline) => {
    const nodes = stack[stack.length - 1];
    const last = nodes[nodes.length - 1];
    if (typeof last === "string" && typeof value === "string") nodes[nodes.length - 1] = last + value;
    else nodes.push(value);
  };
  for (let index = 0; index < text.length;) {
    if (text[index] === "`") {
      let end = index + 1;
      while (text[end] === "`") end++;
      const marker = text.slice(index, end);
      const close = text.indexOf(marker, end);
      if (close >= 0) {
        append({ kind: "code", text: text.slice(end, close) });
        index = close + marker.length;
      } else { append(marker); index = end; }
    } else if (text.startsWith("**", index)) {
      const before = text[index - 1];
      const after = text[index + 2];
      const canOpen = after !== undefined && !/\s/.test(after);
      const canClose = before !== undefined && !/\s/.test(before);
      if (canClose && stack.length > 1) {
        const children = stack.pop()!;
        append({ kind: "strong", children });
      } else if (canOpen && stack.length < 33) stack.push([]);
      else append("**");
      index += 2;
    } else {
      let end = index + 1;
      while (end < text.length && text[end] !== "`" && !text.startsWith("**", end)) end++;
      append(text.slice(index, end));
      index = end;
    }
  }
  // 流式输出可以停在任意标记中间；还原未完成的加粗，不丢失文字。
  while (stack.length > 1) {
    const children = stack.pop()!;
    append("**");
    for (const child of children) append(child);
  }
  return stack[0];
}

function tableCells(line: string): string[] | null {
  const text = line.trim();
  const cells: string[] = [];
  let cell = "", ticks = 0, lastPipe = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "|") { cell += "|"; index++; }
    else if (char === "`") {
      let end = index + 1;
      while (text[end] === "`") end++;
      const count = end - index;
      if (ticks === count) ticks = 0;
      else if (ticks === 0) ticks = count;
      cell += text.slice(index, end);
      index = end - 1;
    } else if (char === "|" && ticks === 0) {
      cells.push(cell.trim()); cell = ""; lastPipe = index;
    } else cell += char;
  }
  if (lastPipe < 0) return null;
  cells.push(cell.trim());
  if (text.startsWith("|")) cells.shift();
  if (lastPipe === text.length - 1) cells.pop();
  return cells.length ? cells : null;
}

const listItem = (line: string) => /^ {0,3}(?:([-+*])|(\d+)[.)])\s+(.*)$/.exec(line);

export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const tableHeader = (index: number): string[] | null => {
    const header = tableCells(lines[index]);
    const separator = tableCells(lines[index + 1] ?? "");
    return header && separator && header.length === separator.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell)) ? header : null;
  };
  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) { index++; continue; }
    const header = tableHeader(index);
    if (header) {
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim()) {
        const cells = tableCells(lines[index]);
        if (!cells) break;
        while (cells.length < header.length) cells.push("");
        rows.push(cells); index++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const first = listItem(lines[index]);
    if (first) {
      const ordered = first[2] !== undefined;
      const start = ordered ? Number(first[2]) : 1;
      const items: string[] = [];
      while (index < lines.length) {
        const next = listItem(lines[index]);
        if (!next || (next[2] !== undefined) !== ordered) break;
        items.push(next[3]); index++;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }
    const paragraph = [lines[index++]];
    while (index < lines.length && lines[index].trim() && !listItem(lines[index]) && !tableHeader(index)) paragraph.push(lines[index++]);
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function inlineElements(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, key) => typeof node === "string" ? node : node.kind === "strong"
    ? createElement("strong", { key }, inlineElements(node.children))
    : createElement("code", { key, className: "rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]" }, node.text));
}

export function MarkdownText({ text }: { text: string }): ReactNode {
  const inline = (value: string) => inlineElements(parseInline(value));
  return createElement("div", { className: "space-y-2 min-w-0 max-w-full [overflow-wrap:anywhere]" }, parseMarkdown(text).map((block, key) => {
    if (block.kind === "paragraph") return createElement("p", { key, className: "whitespace-pre-wrap" }, inline(block.text));
    if (block.kind === "list") return createElement(block.ordered ? "ol" : "ul", {
      key, className: `space-y-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`, ...(block.ordered ? { start: block.start } : {}),
    }, block.items.map((item, index) => createElement("li", { key: index, className: "whitespace-pre-wrap" }, inline(item))));
    const cellClass = "border px-2 py-1 text-left align-top whitespace-pre-wrap";
    return createElement("div", { key, className: "min-w-0 max-w-full overflow-x-auto", tabIndex: 0, role: "region", "aria-label": "表格（可横向滚动）" },
      createElement("table", { className: "w-max min-w-full border-collapse text-xs" },
        createElement("thead", null, createElement("tr", null, block.header.map((cell, index) => createElement("th", { key: index, scope: "col", className: cellClass }, inline(cell))))),
        createElement("tbody", null, block.rows.map((row, index) => createElement("tr", { key: index }, row.map((cell, column) => createElement("td", { key: column, className: cellClass }, inline(cell))))))));
  }));
}
