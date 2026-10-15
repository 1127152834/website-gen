// AI 可自由组合安全字体与颜色；代码最终决定是否满足 WCAG AA 对比度。
export const FONT_PAIRS = [
  { heading: "Georgia, serif", body: "Arial, sans-serif" },
  { heading: "Arial, sans-serif", body: "Arial, sans-serif" },
  { heading: "Trebuchet MS, sans-serif", body: "Verdana, sans-serif" },
] as const;

export interface AiStyleProposal {
  palette: { base: string; surface: string; subtle: string; text: string; heading: string; primary: string; primaryText: string; link: string; muted: string };
  fonts: { heading: string; body: string };
  radius: number;
  rationale: string;
}

export const FALLBACK_STYLE: AiStyleProposal = {
  palette: { base: "#FFFFFF", surface: "#F8F8F6", subtle: "#F0F1EE", text: "#202124", heading: "#111111", primary: "#1F4B3F", primaryText: "#FFFFFF", link: "#174C70", muted: "#535A57" },
  fonts: { heading: "Georgia, serif", body: "Arial, sans-serif" }, radius: 8,
  rationale: "Accessible neutral fallback",
};

export function stylePrompt(niche: string[], imageUrls: string[]): string {
  return `Design a restrained ecommerce visual system for ${niche.join(", ")} using the supplied product images as visual context. Use one of the allowed font pairs exactly; no external font download. Radius is 0-24 px. All body, heading and link colors must retain 4.5:1 contrast on base, surface and subtle; primaryText must retain 4.5:1 on primary. Return JSON only: {"palette":{"base":"#RRGGBB","surface":"#RRGGBB","subtle":"#RRGGBB","text":"#RRGGBB","heading":"#RRGGBB","primary":"#RRGGBB","primaryText":"#RRGGBB","link":"#RRGGBB","muted":"#RRGGBB"},"fonts":{"heading":string,"body":string},"radius":number,"rationale":string}. Allowed font pairs: ${JSON.stringify(FONT_PAIRS)}. Product images: ${JSON.stringify(imageUrls.slice(0, 20))}`;
}

export function parseStyleProposal(text: string): AiStyleProposal {
  const clean = text.replace(/^```(?:json)?\s*|```\s*$/gm, "").trim();
  return JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)) as AiStyleProposal;
}

const rgb = (hex: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  return [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16) / 255);
};
const luminance = (hex: string) => {
  const value = rgb(hex);
  if (!value) return null;
  const [r, g, b] = value.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  if (x == null || y == null) return 0;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function checkStyleProposal(style: AiStyleProposal): string[] {
  const out: string[] = [];
  const colors = Object.entries(style?.palette ?? {});
  if (colors.length !== 9 || colors.some(([, value]) => !/^#[0-9a-f]{6}$/i.test(String(value)))) out.push("palette must contain nine #RRGGBB colors");
  if (!FONT_PAIRS.some((p) => p.heading === style?.fonts?.heading && p.body === style?.fonts?.body)) out.push("fonts must use an allowed pairing");
  if (!Number.isFinite(style?.radius) || style.radius < 0 || style.radius > 24) out.push("radius must be 0-24 px");
  for (const background of ["base", "surface", "subtle"] as const) {
    if (contrastRatio(style?.palette?.text, style?.palette?.[background]) < 4.5) out.push(`body text contrast on ${background} must be at least 4.5:1`);
    if (contrastRatio(style?.palette?.heading, style?.palette?.[background]) < 4.5) out.push(`heading contrast on ${background} must be at least 4.5:1`);
    if (contrastRatio(style?.palette?.link, style?.palette?.[background]) < 4.5) out.push(`link contrast on ${background} must be at least 4.5:1`);
    if (contrastRatio(style?.palette?.muted, style?.palette?.[background]) < 4.5) out.push(`muted text contrast on ${background} must be at least 4.5:1`);
  }
  if (contrastRatio(style?.palette?.primaryText, style?.palette?.primary) < 4.5) out.push("primary button text contrast must be at least 4.5:1");
  if (contrastRatio(style?.palette?.primaryText, style?.palette?.heading) < 4.5) out.push("primary button hover contrast must be at least 4.5:1");
  return out;
}

export function safeStyleProposal(style: AiStyleProposal): { style: AiStyleProposal; fallbackUsed: boolean; problems: string[] } {
  const problems = checkStyleProposal(style);
  return problems.length ? { style: FALLBACK_STYLE, fallbackUsed: true, problems } : { style, fallbackUsed: false, problems: [] };
}

/** WordPress global-styles REST 接口接受的 Obel 样式片段。 */
export function toObelGlobalStyles(style: AiStyleProposal) {
  return {
    settings: {
      color: { palette: [
        { slug: "base", name: "Base", color: style.palette.base }, { slug: "surface", name: "Surface", color: style.palette.surface },
        { slug: "subtle", name: "Subtle", color: style.palette.subtle }, { slug: "muted", name: "Muted", color: style.palette.muted },
        { slug: "secondary", name: "Secondary", color: style.palette.surface }, { slug: "tertiary", name: "Tertiary", color: style.palette.subtle },
        { slug: "contrast", name: "Contrast", color: style.palette.text }, { slug: "primary", name: "Primary", color: style.palette.primary },
        { slug: "primary-hover", name: "Primary hover", color: style.palette.heading }, { slug: "accent", name: "Accent", color: style.palette.link },
      ] },
      typography: { fontFamilies: [
        { slug: "heading", name: "Heading", fontFamily: style.fonts.heading }, { slug: "body", name: "Body", fontFamily: style.fonts.body },
      ] },
    },
    styles: {
      color: { background: style.palette.base, text: style.palette.text },
      typography: { fontFamily: "var:preset|font-family|body" },
      elements: {
        heading: { color: { text: style.palette.heading }, typography: { fontFamily: "var:preset|font-family|heading" } },
        link: { color: { text: style.palette.link } },
        button: { color: { background: style.palette.primary, text: style.palette.primaryText }, border: { radius: `${style.radius}px` } },
      },
      blocks: { "core/image": { border: { radius: `${style.radius}px` } } },
    },
  };
}
