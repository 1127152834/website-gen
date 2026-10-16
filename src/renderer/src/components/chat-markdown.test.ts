import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText, parseMarkdown, parseInline } from "./chat-markdown.ts";

test("Markdown paragraphs preserve plain text and line breaks", () => {
  assert.deepEqual(parseMarkdown("第一行\n第二行\n\n下一段"), [
    { kind: "paragraph", text: "第一行\n第二行" },
    { kind: "paragraph", text: "下一段" },
  ]);
  assert.equal(renderToStaticMarkup(createElement(MarkdownText, { text: "普通文字\n下一行" })),
    '<div class="space-y-2 min-w-0 max-w-full [overflow-wrap:anywhere]"><p class="whitespace-pre-wrap">普通文字\n下一行</p></div>');
});

test("Markdown parses bold, nested bold and inline code without formatting code contents", () => {
  assert.deepEqual(parseInline("前 **外层 **内层** 与 `**代码**`** 后"), [
    "前 ", { kind: "strong", children: ["外层 ", { kind: "strong", children: ["内层"] }, " 与 ", { kind: "code", text: "**代码**" }] }, " 后",
  ]);
  const html = renderToStaticMarkup(createElement(MarkdownText, { text: "**外层 **内层** 文本** `a < b`" }));
  assert.match(html, /<strong>外层 <strong>内层<\/strong> 文本<\/strong>/);
  assert.match(html, /<code[^>]*>a &lt; b<\/code>/);
});

test("Markdown parses unordered and ordered lists with their starting number", () => {
  assert.deepEqual(parseMarkdown("- 一\n- **二**\n\n3. 三\n4. 四"), [
    { kind: "list", ordered: false, start: 1, items: ["一", "**二**"] },
    { kind: "list", ordered: true, start: 3, items: ["三", "四"] },
  ]);
  const html = renderToStaticMarkup(createElement(MarkdownText, { text: "- 一\n- **二**\n\n3. 三" }));
  assert.match(html, /<ul[^>]*><li[^>]*>一<\/li><li[^>]*><strong>二<\/strong><\/li><\/ul>/);
  assert.match(html, /<ol[^>]*start="3"[^>]*><li[^>]*>三<\/li><\/ol>/);
});

test("Markdown pipe tables have a constrained horizontal scroll wrapper and inline formatting", () => {
  const text = "| 文档 | 表 |\n| :--- | ---: |\n| **客户** | `Contacts` |\n| A \\| B | `a|b` |";
  assert.deepEqual(parseMarkdown(text), [{ kind: "table", header: ["文档", "表"], rows: [["**客户**", "`Contacts`"], ["A | B", "`a|b`"]] }]);
  const html = renderToStaticMarkup(createElement(MarkdownText, { text }));
  assert.match(html, /<div class="min-w-0 max-w-full overflow-x-auto"[^>]*><table/);
  assert.match(html, /<thead><tr><th[^>]*>文档<\/th><th[^>]*>表<\/th><\/tr><\/thead>/);
  assert.match(html, /<td[^>]*><strong>客户<\/strong><\/td>/);
  assert.match(html, /<td[^>]*><code[^>]*>a\|b<\/code><\/td>/);
  assert.deepEqual(parseMarkdown("文档 | 表\n--- | ---\nA | B"), [{ kind: "table", header: ["文档", "表"], rows: [["A", "B"]] }]);
});

test("streamed partial Markdown stays readable at every prefix", () => {
  assert.deepEqual(parseMarkdown("| 文档 | 表 |\n| --- | --"), [{ kind: "paragraph", text: "| 文档 | 表 |\n| --- | --" }]);
  assert.deepEqual(parseMarkdown("| 文档 | 表 |\n| --- | --- |\n| 客户"), [
    { kind: "table", header: ["文档", "表"], rows: [["客户", ""]] },
  ]);
  assert.deepEqual(parseInline("未完成 **加粗 `代码"), ["未完成 **加粗 `代码"]);
  const text = "**标题**\n\n| 文档 | 表 |\n| --- | --- |\n| **客户** | `a|b` |\n\n- 结束";
  for (let end = 0; end <= text.length; end++) {
    assert.doesNotThrow(() => renderToStaticMarkup(createElement(MarkdownText, { text: text.slice(0, end) })));
  }
});

test("HTML, script text and links remain non-interactive escaped text", () => {
  const text = '<script>alert("x")</script> <img src=x onerror=alert(1)>\n[链接](javascript:alert(1)) https://example.com <a href="x">文字</a>';
  assert.deepEqual(parseMarkdown(text), [{ kind: "paragraph", text }]);
  const html = renderToStaticMarkup(createElement(MarkdownText, { text }));
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /\[链接\]\(javascript:alert\(1\)\) https:\/\/example.com/);
  assert.doesNotMatch(html, /<(?:script|img|a)\b|dangerouslySetInnerHTML/);
});

test("untrusted deeply nested bold is bounded and never overflows the renderer", () => {
  const text = "**外 ".repeat(1000) + "内" + " 末**".repeat(1000);
  assert.doesNotThrow(() => renderToStaticMarkup(createElement(MarkdownText, { text })));
});
