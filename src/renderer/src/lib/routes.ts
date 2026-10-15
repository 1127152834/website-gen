export type Page = "overview" | "new" | "batches" | "sites" | "accounts" | "settings" | "users" | "not-found";
export interface Route { page: Page; id?: number; tab?: string }
export function parseRoute(path: string): Route {
  if (path === "/" || path === "/overview") return { page: "overview" };
  const match = /^\/(new|batches|sites|accounts|settings|users)(?:\/([1-9]\d*))?(?:\/(overview|chat|mail|changes|qa))?\/?$/.exec(path);
  if (!match) return { page: "not-found" };
  const [, page, id, tab] = match;
  if ((id && page !== "sites" && page !== "batches") || (tab && (page !== "sites" || !id))) return { page: "not-found" };
  const number = id ? Number(id) : undefined;
  if (number !== undefined && !Number.isSafeInteger(number)) return { page: "not-found" };
  return { page: page as Page, ...(number ? { id: number } : {}), ...(tab ? { tab } : {}) };
}
