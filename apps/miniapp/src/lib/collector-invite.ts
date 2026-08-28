export const COLLECTOR_INVITE_PARAM = 'collector_invite';
const COLLECTOR_INVITE_STORAGE_KEY = 'eco_oil_collector_invite';

type BrowserLocation = Pick<Location, 'href'>;
type BrowserHistory = Pick<History, 'replaceState'>;

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage;
}

export function captureCollectorInvite(
  location: BrowserLocation | null = typeof window === 'undefined' ? null : window.location,
  history: BrowserHistory | null = typeof window === 'undefined' ? null : window.history,
  session: Storage | null = storage(),
): string | null {
  if (!location || !session) return null;
  const url = new URL(location.href);
  const code = url.searchParams.get(COLLECTOR_INVITE_PARAM)?.trim();
  if (!code) return session.getItem(COLLECTOR_INVITE_STORAGE_KEY);
  session.setItem(COLLECTOR_INVITE_STORAGE_KEY, code);
  url.searchParams.delete(COLLECTOR_INVITE_PARAM);
  history?.replaceState(null, '', url.pathname + url.search + url.hash);
  return code;
}

export function getStoredCollectorInvite(session: Storage | null = storage()): string | null {
  return session?.getItem(COLLECTOR_INVITE_STORAGE_KEY) ?? null;
}

export function clearStoredCollectorInvite(session: Storage | null = storage()): void {
  session?.removeItem(COLLECTOR_INVITE_STORAGE_KEY);
}
