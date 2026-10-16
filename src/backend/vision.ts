// 视觉用途模型调用：截图既可以来自 QA 的本地文件，也可以来自 CJ 的候选图片 URL。
// 图片会在进模型前做 MIME 和大小限制；调用方在测试里注入 fetch，不触网。
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ImageContent, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import { buildRuntime, roleChoice } from "./models.ts";
import { assertPublicBaseUrl } from "./net-guard.ts";
import { withModelRetry } from "./model-retry.ts";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export type VisionImage = { name: string; mimeType?: string } & (
  | { file: string; url?: never }
  | { url: string; file?: never }
);

export type VisionComplete = (prompt: string, images: VisionImage[]) => Promise<{ text: string; cost: number }>;

const mimeFromName = (name: string) => {
  const ext = extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
};

async function loadImage(image: VisionImage, fetchImpl: typeof fetch): Promise<ImageContent> {
  let bytes: Uint8Array;
  let mimeType = image.mimeType;
  if (typeof image.file === "string") {
    if ((await stat(image.file)).size > MAX_IMAGE_BYTES) throw new Error(`Image ${image.name} exceeds 12 MB`);
    bytes = await readFile(image.file);
    mimeType ??= mimeFromName(image.file);
  } else {
    const url = image.url;
    // 图片地址来自 CJ 资料等第三方数据：只走 https、不跟随重定向，真实请求前拒绝本机/内网地址（防 SSRF）
    if (new URL(url).protocol !== "https:") throw new Error(`候选图片 ${image.name} 不是 https 地址`);
    if (fetchImpl === globalThis.fetch) await assertPublicBaseUrl(url);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok) throw new Error(`候选图片 ${image.name} 返回 HTTP ${response.status}`);
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > MAX_IMAGE_BYTES) throw new Error(`候选图片 ${image.name} 超过 12 MB`);
    mimeType ??= response.headers.get("content-type")?.split(";")[0] || mimeFromName(url);
    if (!response.body) throw new Error(`Image ${image.name} has no response body`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error(`Image ${image.name} exceeds 12 MB`); }
      chunks.push(part.value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  }
  if (!mimeType.startsWith("image/")) throw new Error(`候选图片 ${image.name} 不是图片`);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`候选图片 ${image.name} 大小无效`);
  return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
}

export async function buildVisionUserContent(prompt: string, images: VisionImage[], fetchImpl: typeof fetch = fetch): Promise<(TextContent | ImageContent)[]> {
  if (images.length === 0) throw new Error("Vision review requires at least one image");
  return [
    { type: "text", text: `${prompt}\n\nImages in order:\n${images.map((x, i) => `${i + 1}. ${x.name}`).join("\n")}` },
    ...await Promise.all(images.map((x) => loadImage(x, fetchImpl))),
  ];
}

/** 使用 models.ts 的既有运行时，但发送 pi-ai 原生的图文 user message。 */
export async function completeVision(
  db: DatabaseSync,
  key: Buffer,
  prompt: string,
  images: VisionImage[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; cost: number }> {
  if (images.length === 0) throw new Error("视觉复核至少需要一张图片");
  const selected = roleChoice(db, "vision");
  if (!selected) throw new Error("用途「vision」还不能用：请先选择模型");
  const runtime = buildRuntime(db, key);
  const { model, thinking } = runtime.resolve("vision");
  if (!model.input.includes("image")) throw new Error(`Vision model ${model.id} does not accept images`);
  const content = await buildVisionUserContent(prompt, images, fetchImpl);
  // 网络中断、超时、限流、5xx 自动重试
  const msg = await withModelRetry(async () => {
    const m = await runtime.models.completeSimple(
      model,
      { messages: [{ role: "user", content, timestamp: Date.now() }] },
      { reasoning: thinking === "off" ? undefined : (thinking as Exclude<ModelThinkingLevel, "off">), maxTokens: 16_000, signal: AbortSignal.timeout(5 * 60_000) },
    );
    if (m.stopReason === "error" || m.stopReason === "aborted") throw new Error(`视觉模型调用失败：${m.errorMessage ?? m.stopReason}`);
    return m;
  });
  return { text: msg.content.filter((c) => c.type === "text").map((c) => c.text).join(""), cost: msg.usage.cost.total };
}
