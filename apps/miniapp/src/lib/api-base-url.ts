export const PRODUCTION_API_BASE_URL = 'https://eco-oil-api.onrender.com/api/v1';

const INVALID_PRODUCTION_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'example.com']);

export function resolveApiBaseUrl(mode: string, configured?: string): string {
  const candidate = configured?.trim() || (mode === 'development' ? '/api/v1' : PRODUCTION_API_BASE_URL);
  if (mode !== 'development') {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error('VITE_API_BASE_URL phải là URL HTTPS đầy đủ của Render khi build production.');
    }
    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '');
    if (
      parsed.protocol !== 'https:'
      || INVALID_PRODUCTION_HOSTS.has(hostname)
      || hostname.endsWith('.local')
      || hostname.endsWith('.example.com')
      || path !== '/api/v1'
    ) {
      throw new Error('VITE_API_BASE_URL production phải là URL HTTPS của API với suffix /api/v1.');
    }
  }
  return candidate.replace(/\/$/, '');
}
