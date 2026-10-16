export interface GristPopupHandle {
  closed: boolean;
  opener: unknown;
  location: { replace(url: string): void };
  focus?(): void;
  close?(): void;
}

export type OpenGristWindow = (url: string, target: string, features?: string) => GristPopupHandle | null;
export interface GristPollTimers<Timer = ReturnType<typeof setInterval>> {
  setInterval(callback: () => void, milliseconds: number): Timer;
  clearInterval(timer: Timer): void;
}

export function gristLoginUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/login`;
  url.search = "?next=%2F";
  url.hash = "";
  return url.toString();
}

/**
 * Open an about:blank popup first so we retain a handle for close polling.
 * `noopener` would intentionally make window.open return null in some browsers,
 * which is indistinguishable from popup blocking and can open a duplicate tab.
 */
export function openGristLogin(loginUrl: string, openWindow: OpenGristWindow): GristPopupHandle | null {
  const fallback = () => openWindow(loginUrl, "_blank", "noopener,noreferrer");
  const popup = openWindow("about:blank", "_blank", "popup,width=1100,height=800");
  if (!popup) {
    fallback();
    return null;
  }
  try {
    popup.opener = null;
    popup.location.replace(loginUrl);
  } catch {
    try { popup.close?.(); } catch { /* The browser may have already severed the handle. */ }
    fallback();
    return null;
  }
  try { popup.focus?.(); } catch { /* Login still works when focus is denied. */ }
  return popup;
}

export function watchGristPopupClosed<Timer>(
  popup: Pick<GristPopupHandle, "closed">,
  onClosed: () => void,
  timers: GristPollTimers<Timer>,
): () => void {
  let active = true;
  let timer: Timer | undefined;
  const stop = () => {
    if (!active) return;
    active = false;
    if (timer !== undefined) timers.clearInterval(timer);
  };
  timer = timers.setInterval(() => {
    if (!active || !popup.closed) return;
    stop();
    onClosed();
  }, 500);
  return stop;
}
