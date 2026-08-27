export interface TokenStorage {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setTokens(accessToken: string, refreshToken: string): void;
  clear(): void;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly status: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

export type ApiRequestOptions = Omit<RequestInit, 'body'> & { body?: unknown; retry?: boolean };

export interface ApiClientOptions {
  baseUrl: string;
  storage: TokenStorage;
  onUnauthorized?: () => void;
  credentials?: RequestCredentials;
}

export function createApiClient(options: ApiClientOptions) {
  let refreshPromise: Promise<string | null> | null = null;

  const parseResponse = async (response: Response): Promise<unknown> => {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };

  const errorFromResponse = (status: number, payload: unknown): ApiError => {
    if (typeof payload === 'object' && payload !== null && 'code' in payload && 'message' in payload) {
      const body = payload as ApiErrorBody;
      return new ApiError(status, { code: body.code, message: body.message, details: body.details ?? null });
    }
    return new ApiError(status, {
      code: status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR',
      message: 'Không thể xử lý yêu cầu',
      details: null,
    });
  };

  const refreshAccessToken = async (): Promise<string | null> => {
    const refreshToken = options.storage.getRefreshToken();
    const response = await fetch(`${options.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: refreshToken ? JSON.stringify({ refresh_token: refreshToken }) : undefined,
      credentials: options.credentials ?? 'include',
    });
    const payload = await parseResponse(response);
    if (!response.ok) throw errorFromResponse(response.status, payload);
    if (typeof payload !== 'object' || payload === null || !('access_token' in payload) || !('refresh_token' in payload)) {
      throw new ApiError(502, { code: 'INVALID_REFRESH_RESPONSE', message: 'Phiên đăng nhập không hợp lệ', details: null });
    }
    const tokens = payload as { access_token: string; refresh_token: string };
    options.storage.setTokens(tokens.access_token, tokens.refresh_token);
    return tokens.access_token;
  };

  const getRefreshOnce = (): Promise<string | null> => {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken().catch(() => null).finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  };

  const request = async <T>(path: string, requestOptions: ApiRequestOptions = {}): Promise<T> => {
    const { body, retry = true, headers, ...init } = requestOptions;
    const requestHeaders = new Headers(headers);
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    const accessToken = options.storage.getAccessToken();
    if (accessToken) requestHeaders.set('Authorization', `Bearer ${accessToken}`);
    const response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: options.credentials ?? 'include',
    });
    const payload = await parseResponse(response);
    if (response.status === 401 && retry) {
      const refreshedToken = await getRefreshOnce();
      if (refreshedToken) return request<T>(path, { ...requestOptions, retry: false });
      options.storage.clear();
      options.onUnauthorized?.();
    }
    if (!response.ok) throw errorFromResponse(response.status, payload);
    return payload as T;
  };

  return { request };
}
