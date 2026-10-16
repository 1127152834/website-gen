import { notFound } from "@tanstack/react-router";

export function safeReturnTo(path: unknown): string {
  return typeof path === "string"
    && path.startsWith("/")
    && !path.startsWith("//")
    && !path.includes("\\")
    && !/[\u0000-\u0020\u007f]/.test(path)
    && !/^\/(?:login|change-password)(?:[/?#]|$)/.test(path)
    ? path
    : "/";
}

export function positiveId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw notFound();
  return Number(value);
}

export const siteTabs = ["overview", "chat", "mail", "changes", "qa"] as const;
