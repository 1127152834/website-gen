import type { Browser, LaunchOptions } from "playwright-core";
import type { AiStyleProposal } from "./style.ts";
import { contrastRatio } from "./style.ts";
import { browserLaunchOptions } from "./qa-browser.ts";

const MAX_SVG_BYTES = 64 * 1024;
const ALLOWED_ELEMENTS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient", "stop"]);
const ALLOWED_ATTRIBUTES = new Set([
  "xmlns", "xmlns:xlink", "width", "height", "viewbox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "id", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points",
  "offset", "stop-color", "gradientunits", "font-family", "font-size", "font-weight",
  "text-anchor", "dominant-baseline", "role", "aria-label", "aria-hidden", "preserveaspectratio",
  "href", "xlink:href",
]);

export type BrandAssetKind = "logo" | "icon";

export interface BrandingRecord {
  generator: "website-gen";
  version: 1;
  logoSvg: string;
  iconSvg: string;
  logoMediaId?: number;
  iconMediaId?: number;
  installed?: true;
  fallbackUsed: boolean;
}

export type BrandRenderer = (svg: string, kind: BrandAssetKind) => Promise<Buffer>;
export type BrandUploader = (kind: BrandAssetKind, png: Buffer, filename: string) => Promise<number>;

export interface EnsureBrandingInput {
  brand: string;
  style: AiStyleProposal;
  existing?: BrandingRecord;
  ai: (role: "agent", prompt: string) => Promise<{ text: string; cost: number }>;
  render?: BrandRenderer;
  upload: BrandUploader;
  install: (ids: { logoMediaId: number; iconMediaId: number }) => Promise<void>;
  /** 每个远端副作用后立即写回 spec_json，供中断后续跑。 */
  save: (record: BrandingRecord) => void | Promise<void>;
}

interface ValidateSvgInput {
  brand: string;
  style: AiStyleProposal;
  kind: BrandAssetKind;
  headerBackground?: string;
}

interface Frame { name: string; fill?: string; stroke?: string; fontFamily?: string; fontSize?: string; x?: string; y?: string; textAnchor?: string; dominantBaseline?: string; inDefs: boolean; hidden: boolean }
interface Bounds { left: number; top: number; right: number; bottom: number }

const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const decodeXml = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
  let rest = source;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!ALLOWED_ATTRIBUTES.has(name) || name.startsWith("on")) throw new Error(`SVG attribute is not allowed: ${name}`);
    if (attributes.has(name)) throw new Error(`SVG attribute is repeated: ${name}`);
    const value = match[2].slice(1, -1);
    if (/[\u0000-\u001f]/.test(value)) throw new Error(`SVG attribute contains control characters: ${name}`);
    if (value.includes("\\")) throw new Error(`SVG attribute contains a CSS escape: ${name}`);
    if (value.includes("&") && name !== "font-family") throw new Error(`SVG entities are not allowed in attribute: ${name}`);
    if (name === "font-family" && /&(?!(?:amp|quot|apos|lt|gt);)/i.test(value)) throw new Error("SVG font-family contains an unsafe entity");
    if ((name === "href" || name === "xlink:href") && !/^#[A-Za-z_][\w:.-]*$/.test(value)) throw new Error("SVG href must be a local #id reference");
    if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z_][\w:.-]*\)$/.test(value)) throw new Error("SVG external references are not allowed");
    attributes.set(name, value);
    rest = rest.replace(match[0], " ");
  }
  if (rest.replace(/\/$/, "").trim()) throw new Error("SVG has an unquoted or malformed attribute");
  return attributes;
}

function numericDimension(value: string | undefined): number {
  if (!value || !/^-?\d+(?:\.\d+)?$/.test(value)) return Number.NaN;
  return Number(value);
}

function normalizedText(value: string): string {
  if (/&(?!(?:amp|quot|apos|lt|gt);)/i.test(value)) throw new Error("SVG text contains an unsafe entity");
  return decodeXml(value).replaceAll("&apos;", "'").replace(/\s+/g, " ").trim();
}

function geometryBounds(name: string, attributes: Map<string, string>): Bounds | null {
  const n = (key: string, fallback?: number) => attributes.has(key) ? numericDimension(attributes.get(key)) : fallback ?? Number.NaN;
  let bounds: Bounds | null = null;
  if (name === "rect") {
    const x = n("x", 0), y = n("y", 0), width = n("width"), height = n("height");
    if (width > 0 && height > 0) bounds = { left: x, top: y, right: x + width, bottom: y + height };
  } else if (name === "circle") {
    const cx = n("cx"), cy = n("cy"), r = n("r");
    if (r > 0) bounds = { left: cx - r, top: cy - r, right: cx + r, bottom: cy + r };
  } else if (name === "ellipse") {
    const cx = n("cx"), cy = n("cy"), rx = n("rx"), ry = n("ry");
    if (rx > 0 && ry > 0) bounds = { left: cx - rx, top: cy - ry, right: cx + rx, bottom: cy + ry };
  } else if (name === "line") {
    const x1 = n("x1"), y1 = n("y1"), x2 = n("x2"), y2 = n("y2");
    bounds = { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
  } else if (name === "polyline" || name === "polygon") {
    const values = (attributes.get("points") ?? "").trim().split(/[\s,]+/).map(Number);
    if (values.length >= 4 && values.length % 2 === 0 && values.every(Number.isFinite)) {
      const xs = values.filter((_, index) => index % 2 === 0), ys = values.filter((_, index) => index % 2 === 1);
      bounds = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
    }
  }
  if (!bounds || Object.values(bounds).some((value) => !Number.isFinite(value))) return null;
  const stroke = attributes.has("stroke-width") ? numericDimension(attributes.get("stroke-width")) : 0;
  if (!Number.isFinite(stroke) || stroke < 0 || stroke > 20) return null;
  return { left: bounds.left - stroke / 2, top: bounds.top - stroke / 2, right: bounds.right + stroke / 2, bottom: bounds.bottom + stroke / 2 };
}

/**
 * SVG 只作为短暂的渲染输入，不信任模型返回值：元素、属性、引用和文字对比度全部在服务端收口。
 */
export function sanitizeBrandSvg(svg: string, input: ValidateSvgInput): string {
  if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) throw new Error("SVG exceeds the 64 KiB size limit");
  const clean = svg.trim();
  if (!clean || /<!|<\?|<!--|\bscript\b/i.test(clean)) throw new Error("SVG declarations, comments and scripts are not allowed");
  const tagPattern = /<\s*(\/?)\s*([A-Za-z][\w:-]*)([^<>]*)>/g;
  const frames: Frame[] = [];
  let cursor = 0;
  let rootCount = 0;
  let textContent = "";
  let textElements = 0;
  let seenVisibleText = false;
  let iconBackground: string | undefined;
  const expectedSize = input.kind === "logo" ? { width: 600, height: 160 } : { width: 512, height: 512 };
  const palette = new Set(Object.values(input.style.palette).map((color) => color.toLowerCase()));
  const ids = new Set<string>();
  const references = new Set<string>();
  const geometry = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
  const logoMarks: Bounds[] = [];
  for (const match of clean.matchAll(tagPattern)) {
    const between = clean.slice(cursor, match.index);
    if (frames.some((frame) => frame.name === "text" || frame.name === "tspan")) textContent += between;
    else if (between.trim()) throw new Error("SVG has text outside a text element");
    cursor = (match.index ?? 0) + match[0].length;
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (!ALLOWED_ELEMENTS.has(name)) throw new Error(`SVG element is not allowed: ${name}`);
    if (closing) {
      if (match[3].trim() || frames.at(-1)?.name !== name) throw new Error(`SVG closing tag is malformed: ${name}`);
      frames.pop();
      continue;
    }
    const selfClosing = /\/\s*$/.test(match[3]);
    const attributes = parseAttributes(match[3]);
    const parentName = frames.at(-1)?.name;
    if (name === "svg" && parentName) throw new Error("Nested svg canvases are not allowed");
    if (name === "g" && parentName !== "svg" && parentName !== "g") throw new Error("SVG g has an invalid parent");
    if (name === "defs" && parentName !== "svg" && parentName !== "g") throw new Error("SVG defs has an invalid parent");
    if (name === "lineargradient" && parentName !== "defs") throw new Error("SVG gradients must be direct children of defs");
    if (name === "stop" && parentName !== "lineargradient") throw new Error("SVG stops must be inside a gradient");
    if (name === "text" && parentName !== "svg" && parentName !== "g") throw new Error("SVG text must be a child of svg or g");
    if (name === "tspan" && parentName !== "text" && parentName !== "tspan") throw new Error("SVG tspan must be inside text");
    // 子文字只继承已验证的布局，不能用局部定位或字号绕过父文字的边界检查。
    if (name === "tspan" && ["x", "y", "font-size", "text-anchor", "dominant-baseline"].some((attribute) => attributes.has(attribute))) throw new Error("SVG tspan cannot override text positioning or font size");
    if (geometry.has(name) && parentName !== "svg" && parentName !== "g") throw new Error("SVG geometry must be a child of svg or g");
    if ((geometry.has(name) || name === "stop") && !selfClosing) throw new Error(`SVG ${name} must be a leaf element`);
    for (const paintName of ["fill", "stroke", "stop-color"] as const) {
      const paint = attributes.get(paintName);
      if (!paint) continue;
      if (/^#[0-9a-f]{6}$/i.test(paint)) {
        if (!palette.has(paint.toLowerCase())) throw new Error(`SVG ${paintName} color is not in the chosen palette`);
      } else if (paint !== "none") {
        const local = /^url\(#([A-Za-z_][\w:.-]*)\)$/.exec(paint);
        if (!local) throw new Error(`SVG ${paintName} has an unsafe paint value`);
        references.add(local[1]);
      }
    }
    const id = attributes.get("id");
    if (id) {
      if (!/^[A-Za-z_][\w:.-]*$/.test(id) || ids.has(id)) throw new Error("SVG id must be unique and safe");
      ids.add(id);
    }
    for (const refName of ["href", "xlink:href"] as const) {
      const ref = attributes.get(refName);
      if (ref) references.add(ref.slice(1));
    }
    if (frames.length === 0) {
      rootCount++;
      if (name !== "svg" || rootCount !== 1) throw new Error("SVG must have exactly one svg root");
      if (attributes.get("xmlns") !== "http://www.w3.org/2000/svg") throw new Error("SVG root must declare the SVG namespace");
      if (attributes.has("xmlns:xlink") && attributes.get("xmlns:xlink") !== "http://www.w3.org/1999/xlink") throw new Error("SVG xlink namespace is invalid");
      const width = numericDimension(attributes.get("width"));
      const height = numericDimension(attributes.get("height"));
      if (width !== expectedSize.width || height !== expectedSize.height) throw new Error(`SVG ${input.kind} dimensions must be exactly ${expectedSize.width}x${expectedSize.height}`);
      const viewBox = (attributes.get("viewbox") ?? "").trim().split(/[\s,]+/).map(Number);
      if (viewBox.length !== 4 || viewBox.some((part) => !Number.isFinite(part)) || viewBox[0] !== 0 || viewBox[1] !== 0 || viewBox[2] !== expectedSize.width || viewBox[3] !== expectedSize.height || viewBox[2] <= 0 || viewBox[3] <= 0) {
        throw new Error(`SVG ${input.kind} viewBox must be exactly 0 0 ${expectedSize.width} ${expectedSize.height}`);
      }
    }
    const parent = frames.at(-1);
    const frame: Frame = {
      name,
      fill: attributes.get("fill") ?? parent?.fill,
      stroke: attributes.get("stroke") ?? parent?.stroke,
      fontFamily: attributes.get("font-family") ?? parent?.fontFamily,
      fontSize: attributes.get("font-size") ?? parent?.fontSize,
      x: attributes.get("x") ?? parent?.x,
      y: attributes.get("y") ?? parent?.y,
      textAnchor: attributes.get("text-anchor") ?? parent?.textAnchor,
      dominantBaseline: attributes.get("dominant-baseline") ?? parent?.dominantBaseline,
      inDefs: name === "defs" || (parent?.inDefs ?? false),
      hidden: attributes.get("aria-hidden") === "true" || (parent?.hidden ?? false),
    };
    if (geometry.has(name) && !frame.inDefs) {
      if (!frame.fill && !frame.stroke) throw new Error("SVG geometry must use an explicit chosen-palette paint or none");
      const visiblePaint = [frame.fill, frame.stroke].some((paint) => paint && paint !== "none");
      if (seenVisibleText && visiblePaint) throw new Error("SVG cannot contain a painted shape after visible text because it may cover the brand");
      if (input.kind === "logo" && visiblePaint) {
        if (name === "path") throw new Error("SVG logo paths are unbounded; use a bounded geometric mark");
        const bounds = geometryBounds(name, attributes);
        if (!bounds || bounds.left < 0 || bounds.top < 0 || bounds.right > 120 || bounds.bottom > 160) throw new Error("SVG logo marks must be bounded inside the leftmost 120 px");
        logoMarks.push(bounds);
      }
      if (input.kind === "icon" && visiblePaint) {
        const isSolidCanvas = name === "rect" && attributes.get("x") === "0" && attributes.get("y") === "0"
          && numericDimension(attributes.get("width")) === 512 && numericDimension(attributes.get("height")) === 512
          && frame.fill && /^#[0-9a-f]{6}$/i.test(frame.fill) && (!frame.stroke || frame.stroke === "none");
        if (!isSolidCanvas || iconBackground) throw new Error("SVG icon may use only one solid full-canvas background rect before its text");
        iconBackground = frame.fill;
      }
    }
    if (name === "text" || name === "tspan") {
      textElements++;
      if (frame.inDefs) throw new Error("SVG brand text cannot be inside defs");
      if (frame.hidden) throw new Error("SVG brand text cannot be hidden");
      if (!frame.fill || !/^#[0-9a-f]{6}$/i.test(frame.fill)) throw new Error("SVG text must use a solid #RRGGBB fill");
      const background = input.kind === "icon" ? (iconBackground ?? input.style.palette.base) : (input.headerBackground ?? input.style.palette.base);
      if (contrastRatio(frame.fill, background) < 4.5) throw new Error("SVG text contrast against its actual background must be at least 4.5:1");
      if (decodeXml(frame.fontFamily ?? "") !== input.style.fonts.heading) throw new Error("SVG text must use the chosen heading font family");
      const fontSize = numericDimension(frame.fontSize);
      if (!Number.isFinite(fontSize) || fontSize <= 0 || fontSize > expectedSize.height) throw new Error("SVG text font-size must be visible and fit the canvas");
      const x = numericDimension(frame.x), y = numericDimension(frame.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > expectedSize.width || y < 0 || y > expectedSize.height) throw new Error("SVG text anchor must be inside the canvas");
      if (name === "text") {
        if (frame.dominantBaseline && !["auto", "alphabetic", "middle", "central"].includes(frame.dominantBaseline)) throw new Error("SVG dominant-baseline value is not allowed");
        const estimatedWidth = Array.from(input.kind === "logo" ? input.brand.trim() : monogram(input.brand)).length * fontSize;
        const left = frame.textAnchor === "middle" ? x - estimatedWidth / 2 : frame.textAnchor === "end" ? x - estimatedWidth : x;
        if (left < 0 || left + estimatedWidth > expectedSize.width) throw new Error("SVG brand text must fit inside the canvas");
        const centered = frame.dominantBaseline === "middle" || frame.dominantBaseline === "central";
        const textBounds = { left, right: left + estimatedWidth, top: centered ? y - fontSize / 2 : y - fontSize, bottom: centered ? y + fontSize / 2 : y + fontSize * 0.2 };
        if (textBounds.top < 0 || textBounds.bottom > expectedSize.height) throw new Error("SVG brand text baseline would clip outside the canvas");
        if (input.kind === "logo" && logoMarks.some((mark) => mark.left < textBounds.right && mark.right > textBounds.left && mark.top < textBounds.bottom && mark.bottom > textBounds.top)) {
          throw new Error("SVG logo mark cannot overlap the wordmark text");
        }
      }
      seenVisibleText = true;
    }
    if (!selfClosing) frames.push(frame);
  }
  if (clean.slice(cursor).trim() || frames.length || rootCount !== 1) throw new Error("SVG markup is incomplete or malformed");
  for (const reference of references) if (!ids.has(reference)) throw new Error(`SVG local reference does not exist: ${reference}`);
  if (textElements === 0) throw new Error("SVG must contain brand text");
  const expected = input.kind === "logo" ? input.brand.trim() : monogram(input.brand);
  if (normalizedText(textContent) !== normalizedText(escapeXml(expected))) throw new Error(`SVG ${input.kind} text must exactly match ${expected}`);
  return clean;
}

function monogram(brand: string): string {
  const words = brand.trim().split(/\s+/).map((word) => word.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join("") : words[0]?.slice(0, 2) || "S").toUpperCase();
}

function safeBrandColor(style: AiStyleProposal, background: string): string {
  return [style.palette.primary, style.palette.heading, style.palette.text].find((color) => contrastRatio(color, background) >= 4.5) ?? style.palette.text;
}

export function fallbackBrandSvgs(brand: string, style: AiStyleProposal): { logoSvg: string; iconSvg: string } {
  const label = escapeXml(brand.trim() || "Store");
  const initials = escapeXml(monogram(brand));
  const font = escapeXml(style.fonts.heading);
  const logoColor = style.palette.primary;
  const iconColor = safeBrandColor(style, style.palette.surface);
  const length = Math.max(Array.from(brand.trim() || "Store").length, 1);
  const logoFontSize = Math.min(64, Math.max(0.001, Math.floor((540 / length) * 1000) / 1000));
  return {
    logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160" viewBox="0 0 600 160"><text x="24" y="101" fill="${logoColor}" font-family="${font}" font-size="${logoFontSize}" font-weight="700">${label}</text></svg>`,
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect x="0" y="0" width="512" height="512" rx="96" fill="${style.palette.surface}"/><text x="256" y="278" fill="${iconColor}" font-family="${font}" font-size="184" font-weight="700" text-anchor="middle" dominant-baseline="middle">${initials}</text></svg>`,
  };
}

export function brandingPrompt(brand: string, style: AiStyleProposal, correction = ""): string {
  return `Design two simple, professional brand assets for the independent store ${JSON.stringify(brand)}. Return JSON only: {"logoSvg":string,"iconSvg":string}. The logo must be exactly 600x160 with viewBox "0 0 600 160", transparent, and contain only the exact brand name in ${JSON.stringify(style.fonts.heading)}. The icon must be exactly 512x512 with viewBox "0 0 512 512", use a full-canvas background rect, and contain only the exact monogram ${JSON.stringify(monogram(brand))}. Use only this palette: ${JSON.stringify(style.palette)}. Text needs at least 4.5:1 contrast against its actual background. Put all painted shapes before text. Allowed SVG elements: ${[...ALLOWED_ELEMENTS].join(", ")}. No scripts, event handlers, embedded images, CSS, transforms, opacity, external references or data URLs. Keep each SVG under 64 KiB.${correction ? ` Previous output failed validation: ${correction}` : ""}`;
}

function parseArtwork(text: string): { logoSvg: string; iconSvg: string } {
  const clean = text.replace(/^```(?:json)?\s*|```\s*$/gm, "").trim();
  const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)) as Record<string, unknown>;
  if (typeof parsed.logoSvg !== "string" || typeof parsed.iconSvg !== "string") throw new Error("AI branding reply must contain logoSvg and iconSvg strings");
  return { logoSvg: parsed.logoSvg, iconSvg: parsed.iconSvg };
}

async function designBranding(input: EnsureBrandingInput): Promise<BrandingRecord> {
  let correction = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await input.ai("agent", brandingPrompt(input.brand, input.style, correction));
      const artwork = parseArtwork(reply.text);
      return {
        generator: "website-gen", version: 1,
        logoSvg: sanitizeBrandSvg(artwork.logoSvg, { brand: input.brand, style: input.style, kind: "logo" }),
        iconSvg: sanitizeBrandSvg(artwork.iconSvg, { brand: input.brand, style: input.style, kind: "icon" }),
        fallbackUsed: false,
      };
    } catch (error) {
      correction = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    }
  }
  const fallback = fallbackBrandSvgs(input.brand, input.style);
  // 保底也走同一验证器，避免样式输入变化后绕过安全边界。
  return {
    generator: "website-gen", version: 1,
    logoSvg: sanitizeBrandSvg(fallback.logoSvg, { brand: input.brand, style: input.style, kind: "logo" }),
    iconSvg: sanitizeBrandSvg(fallback.iconSvg, { brand: input.brand, style: input.style, kind: "icon" }),
    fallbackUsed: true,
  };
}

export async function renderBrandSvgPng(
  svg: string,
  kind: BrandAssetKind,
  launch?: (options: LaunchOptions) => Promise<Browser>,
): Promise<Buffer> {
  const size = kind === "logo" ? { width: 600, height: 160 } : { width: 512, height: 512 };
  const launchBrowser = launch ?? (async (options) => {
    const { chromium } = await import("playwright-core");
    return chromium.launch(options);
  });
  let browser: Browser | undefined;
  for (const options of browserLaunchOptions()) {
    browser = await launchBrowser(options).catch(() => undefined);
    if (browser) break;
  }
  if (!browser) throw new Error("Unable to launch Edge or Playwright Chromium to render brand assets");
  try {
    const page = await browser.newPage({ viewport: size });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size.width}px;height:${size.height}px}</style>${svg}`);
    return await page.locator("svg").screenshot({ type: "png", omitBackground: true });
  } finally {
    await browser.close();
  }
}

function safeFilename(brand: string, kind: BrandAssetKind): string {
  const slug = brand.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "store";
  return `${slug}-${kind}.png`;
}

/** 生成、渲染、上传、安装分别落盘；任一步骤中断都可从已有 media ID 续跑。 */
export async function ensureBranding(input: EnsureBrandingInput): Promise<BrandingRecord> {
  if (input.existing?.generator === "website-gen" && input.existing.logoMediaId && input.existing.iconMediaId && input.existing.installed) return input.existing;
  let record: BrandingRecord;
  if (input.existing?.generator === "website-gen") {
    try {
      record = {
        ...input.existing,
        logoSvg: sanitizeBrandSvg(input.existing.logoSvg, { brand: input.brand, style: input.style, kind: "logo" }),
        iconSvg: sanitizeBrandSvg(input.existing.iconSvg, { brand: input.brand, style: input.style, kind: "icon" }),
      };
    } catch {
      record = await designBranding(input);
      await input.save(record);
    }
  } else {
    record = await designBranding(input);
    await input.save(record);
  }
  const render = input.render ?? renderBrandSvgPng;
  if (!record.logoMediaId) {
    record.logoMediaId = await input.upload("logo", await render(record.logoSvg, "logo"), safeFilename(input.brand, "logo"));
    await input.save(record);
  }
  if (!record.iconMediaId) {
    record.iconMediaId = await input.upload("icon", await render(record.iconSvg, "icon"), safeFilename(input.brand, "icon"));
    await input.save(record);
  }
  if (!record.installed) {
    await input.install({ logoMediaId: record.logoMediaId, iconMediaId: record.iconMediaId });
    record.installed = true;
    await input.save(record);
  }
  return record;
}
