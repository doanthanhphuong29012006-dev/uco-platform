export const ZALO_OAUTH_CODE_PARAM = 'zalo_code';

type BrowserLocation = Pick<Location, 'href'>;
type BrowserHistory = Pick<History, 'replaceState'>;

function currentLocation(): BrowserLocation | null {
  return typeof window === 'undefined' ? null : window.location;
}

function currentHistory(): BrowserHistory | null {
  return typeof window === 'undefined' ? null : window.history;
}

export function readZaloOAuthCode(location: BrowserLocation | null = currentLocation()): string | null {
  if (!location) return null;
  const code = new URL(location.href).searchParams.get(ZALO_OAUTH_CODE_PARAM)?.trim();
  return code || null;
}

export function clearZaloOAuthCode(
  location: BrowserLocation | null = currentLocation(),
  history: BrowserHistory | null = currentHistory(),
): void {
  if (!location || !history) return;
  const url = new URL(location.href);
  if (!url.searchParams.has(ZALO_OAUTH_CODE_PARAM)) return;
  url.searchParams.delete(ZALO_OAUTH_CODE_PARAM);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export async function consumeZaloOAuthCode<T>(
  exchange: (code: string) => Promise<T>,
  location: BrowserLocation | null = currentLocation(),
  history: BrowserHistory | null = currentHistory(),
): Promise<T | null> {
  const code = readZaloOAuthCode(location);
  if (!code) return null;
  try {
    return await exchange(code);
  } finally {
    clearZaloOAuthCode(location, history);
  }
}
