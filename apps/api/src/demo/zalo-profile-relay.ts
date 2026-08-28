import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const ZALO_PROFILE_URL = 'https://graph.zalo.me/v2.0/me?fields=id,name,picture';
export const ZALO_PROFILE_RELAY_PATH = '/zalo/profile';
export const ZALO_PROFILE_RELAY_SECRET_HEADER = 'x-zalo-profile-relay-secret';

const MAX_BODY_BYTES = 8 * 1024;
const TOKEN_MAX_LENGTH = 4_096;
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_SECRET_LENGTH = 32;

type JsonObject = Record<string, unknown>;
type Fetcher = typeof fetch;
type SafeDiagnostic = string | number | boolean | null;

export type ZaloProfileRelayConfig = {
  relaySecret: string;
};

export type ZaloProfileRelayLog = {
  event: string;
  status: number | null;
  content_type: string | null;
  response_keys: string[];
  provider_error: SafeDiagnostic;
  provider_message: SafeDiagnostic;
};

type RelayLogger = (entry: ZaloProfileRelayLog) => void;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeDiagnostic(value: unknown, sensitiveValues: readonly string[] = []): SafeDiagnostic {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value === undefined ? null : `[${typeof value}]`;
  let result = value.slice(0, 200);
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) result = result.split(sensitiveValue).join('[REDACTED]');
  }
  return result;
}

function providerError(body: JsonObject): unknown {
  return body.error ?? body.error_code ?? body.code ?? null;
}

function providerMessage(body: JsonObject): unknown {
  return body.message ?? body.error_message ?? null;
}

function profilePayload(body: JsonObject, sensitiveValues: readonly string[] = []): JsonObject {
  const payload: JsonObject = {};
  const error = providerError(body);
  const message = providerMessage(body);
  if (error !== null) payload.error = safeDiagnostic(error, sensitiveValues);
  if (message !== null) payload.message = safeDiagnostic(message, sensitiveValues);
  if (typeof body.id === 'string' || (typeof body.id === 'number' && Number.isFinite(body.id))) payload.id = body.id;
  if (typeof body.name === 'string') payload.name = body.name.slice(0, 200);
  if (isJsonObject(body.picture)) {
    const data = isJsonObject(body.picture.data) ? body.picture.data : null;
    const url = data && typeof data.url === 'string' ? data.url.slice(0, 2_048) : null;
    if (url) payload.picture = { data: { url } };
  }
  return payload;
}

function diagnostics(response: Response, body: JsonObject, sensitiveValues: readonly string[] = []): ZaloProfileRelayLog {
  return {
    event: 'zalo_profile_upstream_error',
    status: response.status,
    content_type: response.headers.get('content-type'),
    response_keys: Object.keys(body),
    provider_error: safeDiagnostic(providerError(body), sensitiveValues),
    provider_message: safeDiagnostic(providerMessage(body), sensitiveValues),
  };
}

async function readAccessToken(request: IncomingMessage): Promise<string> {
  const contentType = request.headers['content-type'] ?? '';
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new Error('INVALID_CONTENT_TYPE');
  }

  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new Error('BODY_TOO_LARGE');
  }

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('INVALID_INPUT');
  }
  if (!isJsonObject(value) || typeof value.access_token !== 'string') throw new Error('INVALID_INPUT');
  const accessToken = value.access_token.trim();
  if (!accessToken || accessToken.length > TOKEN_MAX_LENGTH) throw new Error('INVALID_INPUT');
  return accessToken;
}

function relayError(response: ServerResponse, error: unknown): void {
  const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  if (code === 'BODY_TOO_LARGE') {
    sendJson(response, 413, { error: 'BODY_TOO_LARGE' });
    return;
  }
  if (code === 'INVALID_CONTENT_TYPE') {
    sendJson(response, 415, { error: 'UNSUPPORTED_CONTENT_TYPE' });
    return;
  }
  sendJson(response, 400, { error: 'INVALID_INPUT' });
}

export function createZaloProfileRelayServer(
  config: ZaloProfileRelayConfig,
  fetcher: Fetcher = fetch,
  logger: RelayLogger = (entry) => console.warn('[zalo-profile-relay]', entry),
) {
  if (config.relaySecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`relaySecret must contain at least ${MIN_SECRET_LENGTH} characters`);
  }

  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method !== 'POST' || request.url !== ZALO_PROFILE_RELAY_PATH) {
      sendJson(response, 404, { error: 'NOT_FOUND' });
      return;
    }

    const suppliedSecret = typeof request.headers[ZALO_PROFILE_RELAY_SECRET_HEADER] === 'string'
      ? request.headers[ZALO_PROFILE_RELAY_SECRET_HEADER]
      : undefined;
    if (!suppliedSecret) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    if (!safeEqual(suppliedSecret, config.relaySecret)) {
      sendJson(response, 403, { error: 'FORBIDDEN' });
      return;
    }

    let accessToken: string;
    try {
      accessToken = await readAccessToken(request);
    } catch (error) {
      relayError(response, error);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const upstream = await fetcher(ZALO_PROFILE_URL, {
        method: 'GET',
        headers: { access_token: accessToken },
        signal: controller.signal,
      });
      const contentType = upstream.headers.get('content-type');
      let body: unknown;
      if (!contentType?.toLowerCase().includes('application/json')) {
        logger({ event: 'zalo_profile_upstream_invalid_content_type', status: upstream.status, content_type: contentType, response_keys: [], provider_error: null, provider_message: null });
        sendJson(response, 502, { error: 'UPSTREAM_INVALID_RESPONSE' });
        return;
      }
      try {
        body = await upstream.json();
      } catch {
        logger({ event: 'zalo_profile_upstream_invalid_json', status: upstream.status, content_type: contentType, response_keys: [], provider_error: null, provider_message: null });
        sendJson(response, 502, { error: 'UPSTREAM_INVALID_RESPONSE' });
        return;
      }
      if (!isJsonObject(body)) {
        logger({ event: 'zalo_profile_upstream_invalid_json', status: upstream.status, content_type: contentType, response_keys: [], provider_error: null, provider_message: null });
        sendJson(response, 502, { error: 'UPSTREAM_INVALID_RESPONSE' });
        return;
      }

      const payload = profilePayload(body, [accessToken, config.relaySecret]);
      if (!upstream.ok || (providerError(body) !== null && providerError(body) !== 0 && providerError(body) !== '0')) {
        logger(diagnostics(upstream, body, [accessToken, config.relaySecret]));
      }
      sendJson(response, upstream.ok ? 200 : upstream.status, payload);
    } catch {
      logger({ event: 'zalo_profile_upstream_unavailable', status: null, content_type: null, response_keys: [], provider_error: null, provider_message: null });
      sendJson(response, 502, { error: 'UPSTREAM_UNAVAILABLE' });
    } finally {
      clearTimeout(timeout);
    }
  });
}

function requiredSecret(): string {
  const value = process.env.ZALO_PROFILE_RELAY_SECRET?.trim();
  if (!value) throw new Error('ZALO_PROFILE_RELAY_SECRET is required');
  return value;
}

function relayPort(): number {
  const value = Number(process.env.ZALO_PROFILE_RELAY_PORT ?? 8787);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('ZALO_PROFILE_RELAY_PORT is invalid');
  return value;
}

if (require.main === module) {
  const server = createZaloProfileRelayServer({ relaySecret: requiredSecret() });
  server.listen(relayPort(), '127.0.0.1', () => {
    console.log(`[zalo-profile-relay] listening on http://127.0.0.1:${relayPort()}`);
  });
}
