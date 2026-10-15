// QA 截图只允许读取当前工作区 work/qa 内的真实文件，复核证据与普通截图使用同一边界。
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { QaView, ReviewIssue } from "../shared/protocol.ts";
import type { QaReport } from "./store.ts";

export function qaView(report: QaReport, workDir: string): QaView {
  const image = (path: string): string | undefined => {
    try {
      const root = realpathSync(resolve(workDir, "qa")) + sep;
      const candidate = resolve(path);
      if (!candidate.startsWith(resolve(workDir, "qa") + sep)) return;
      const file = realpathSync(candidate);
      if (!file.startsWith(root) || !statSync(file).isFile() || statSync(file).size > 20 * 1024 * 1024) return;
      const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extname(file).toLowerCase()];
      if (!mime) return;
      return "data:" + mime + ";base64," + readFileSync(file).toString("base64");
    } catch { return; }
  };
  return {
    at: report.at ?? report.review?.at ?? 0, checks: report.checks ?? [],
    shots: (report.shots ?? []).flatMap((s) => { const src = image(s.file); return src ? [{ name: s.name, src }] : []; }),
    ...(report.review ? { review: {
      ...report.review,
      issues: report.review.issues.map((i): ReviewIssue => {
        const { shot, ...issue } = i;
        const src = shot && image(shot);
        return src ? { ...issue, shot: src } : issue;
      }),
    } } : {}),
  };
}
