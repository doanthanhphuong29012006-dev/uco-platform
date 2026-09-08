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

export type ApiRequestOptions = Omit<RequestInit, 'body'> & { body?: unknown; retry?: boolean; timeoutMs?: number };

export interface ApiClientOptions {
  baseUrl: string;
  storage: TokenStorage;
  onUnauthorized?: () => void;
  credentials?: RequestCredentials;
}

export function createApiClient(options: ApiClientOptions) {
  let refreshPromise: Promise<string | null> | null = null;

  const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const callerSignal = init.signal;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) abortFromCaller();
      else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !callerSignal?.aborted) {
        throw new ApiError(0, { code: 'REQUEST_TIMEOUT', message: 'Máy chủ phản hồi quá thời gian chờ.', details: null });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  };

  const parseResponse = async (response: Response, timeoutMs = 15_000): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const text = await Promise.race([
      response.text(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ApiError(0, { code: 'REQUEST_TIMEOUT', message: 'Máy chủ phản hồi quá thời gian chờ.', details: null })), timeoutMs);
      }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
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
    const response = await fetchWithTimeout(`${options.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: refreshToken ? JSON.stringify({ refresh_token: refreshToken }) : undefined,
      credentials: options.credentials ?? 'include',
    }, 15_000);
    const payload = await parseResponse(response, 15_000);
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
      refreshPromise = refreshAccessToken().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  };

  const request = async <T>(path: string, requestOptions: ApiRequestOptions = {}): Promise<T> => {
    const { body, retry = true, headers, timeoutMs = 15_000, ...init } = requestOptions;
    const requestHeaders = new Headers(headers);
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    const accessToken = options.storage.getAccessToken();
    if (accessToken) requestHeaders.set('Authorization', `Bearer ${accessToken}`);
    const response = await fetchWithTimeout(`${options.baseUrl}${path}`, {
      ...init,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: options.credentials ?? 'include',
    }, timeoutMs);
    const payload = await parseResponse(response, timeoutMs);
    if (response.status === 401 && retry) {
      try {
        const refreshedToken = await getRefreshOnce();
        if (refreshedToken) return request<T>(path, { ...requestOptions, retry: false });
      } catch (refreshError) {
        // A timeout, network failure, or server-side 5xx is not proof that the
        // session is invalid. Keep both tokens so the next request can retry.
        const refreshStatus = typeof refreshError === 'object' && refreshError !== null && 'status' in refreshError
          ? Number((refreshError as { status?: unknown }).status)
          : Number.NaN;
        if (!Number.isFinite(refreshStatus) || refreshStatus === 0 || refreshStatus >= 500) {
          throw refreshError;
        }
      }
      options.storage.clear();
      options.onUnauthorized?.();
    }
    if (!response.ok) throw errorFromResponse(response.status, payload);
    return payload as T;
  };

  return { request };
}
