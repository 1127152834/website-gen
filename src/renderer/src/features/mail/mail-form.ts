const LOCAL_PART = /^[A-Z0-9!#$%&'*+/=?^_`{|}~.-]+$/i;
const DOMAIN_LABEL = /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;

function rawMailAddresses(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quoted = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    else if (!quoted && character === "<") angleDepth += 1;
    else if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (!quoted && angleDepth === 0 && (character === "," || character === ";")) {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }
  items.push(value.slice(start));
  return items.map((item) => item.trim()).filter(Boolean);
}

function isValidMailAddress(value: string): boolean {
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !LOCAL_PART.test(local)) return false;
  if (!domain || domain.length > 253 || domain.includes("..")) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

export function normalizeMailAddress(value: string): string {
  return value.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1]
    ?? value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    ?? value.trim();
}

export function splitMailAddresses(value: string): string[] {
  return rawMailAddresses(value).map(normalizeMailAddress).filter(Boolean);
}

export function isValidMailAddressList(value: string, required = false): boolean {
  const raw = rawMailAddresses(value);
  if (raw.length === 0) return !required;
  return raw.every((item) => isValidMailAddress(normalizeMailAddress(item)));
}
