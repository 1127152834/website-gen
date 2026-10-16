export type Page = "overview" | "new" | "batches" | "sites" | "accounts" | "mail" | "settings" | "users" | "not-found";
export interface Route { page: Page; id?: number; tab?: string; folder?: string; uid?: number }
export function parseRoute(path: string): Route {
  if (path === "/" || path === "/overview") return { page: "overview" };
  const mail = /^\/mail(?:\/([1-9]\d*)(?:\/([^/]+)(?:\/([1-9]\d*))?)?)?\/?$/.exec(path);
  if (mail) {
    const id = mail[1] ? Number(mail[1]) : undefined;
    const uid = mail[3] ? Number(mail[3]) : undefined;
    if ((id !== undefined && !Number.isSafeInteger(id)) || (uid !== undefined && !Number.isSafeInteger(uid))) return { page: "not-found" };
    let folder: string | undefined;
    try { folder = mail[2] ? decodeURIComponent(mail[2]) : undefined; } catch { return { page: "not-found" }; }
    if ((folder && id === undefined) || (uid !== undefined && !folder)) return { page: "not-found" };
    return { page: "mail", ...(id ? { id } : {}), ...(folder ? { folder } : {}), ...(uid ? { uid } : {}) };
  }
  const match = /^\/(new|batches|sites|accounts|settings|users)(?:\/([1-9]\d*))?(?:\/(overview|chat|mail|changes|qa))?\/?$/.exec(path);
  if (!match) return { page: "not-found" };
  const [, page, id, tab] = match;
  if ((id && page !== "sites" && page !== "batches") || (tab && (page !== "sites" || !id))) return { page: "not-found" };
  const number = id ? Number(id) : undefined;
  if (number !== undefined && !Number.isSafeInteger(number)) return { page: "not-found" };
  return { page: page as Page, ...(number ? { id: number } : {}), ...(tab ? { tab } : {}) };
}
