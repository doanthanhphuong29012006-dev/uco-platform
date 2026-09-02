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

export function isRetryableOAuthExchangeError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown };
  const status = Number(candidate.status);
  return (
    candidate.code === 'REQUEST_TIMEOUT' ||
    status === 0 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

export async function consumeZaloOAuthCode<T>(
  exchange: (code: string) => Promise<T>,
  location: BrowserLocation | null = currentLocation(),
  history: BrowserHistory | null = currentHistory(),
): Promise<T | null> {
  const code = readZaloOAuthCode(location);
  if (!code) return null;
  try {
    const session = await exchange(code);
    clearZaloOAuthCode(location, history);
    return session;
  } catch (error) {
    if (!isRetryableOAuthExchangeError(error)) {
      clearZaloOAuthCode(location, history);
    }
    throw error;
  }
}
