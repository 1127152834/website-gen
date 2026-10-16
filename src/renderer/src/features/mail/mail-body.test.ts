import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MailBody } from "./mail-body.ts";

test("mail body renders URLs as inert text without HTML, anchors, images or frames", () => {
  const html = renderToStaticMarkup(MailBody({
    text: "请勿点击 https://tracker.example/open?id=1\n<img src=\"https://tracker.example/pixel\">\n<a href=\"https://evil.example\">登录</a>",
  }));
  assert.match(html, /https:\/\/tracker\.example\/open\?id=1/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;a href/);
  assert.doesNotMatch(html, /<(?:a|img|iframe)\b/i);
  assert.doesNotMatch(html, /dangerouslySetInnerHTML/);
});
