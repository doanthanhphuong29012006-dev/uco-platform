import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const ZALO_LOCATION_URL = 'https://graph.zalo.me/v2.0/me/info';
const MAX_BODY_BYTES = 8 * 1024;
const TOKEN_MAX_LENGTH = 4_096;
const REQUEST_TIMEOUT_MS = 5_000;

type RelayConfig = {
  appSecret: string;
  relayToken: string;
};

type LocationInput = {
  access_token: string;
  location_token: string;
};

type ZaloPayload = {
  error?: unknown;
  message?: unknown;
  data?: {
    latitude?: unknown;
    longitude?: unknown;
  };
};

type Fetcher = typeof fetch;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function readInput(request: IncomingMessage): Promise<LocationInput> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('BODY_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<LocationInput>;
  if (
    typeof value.access_token !== 'string'
    || value.access_token.length === 0
    || value.access_token.length > TOKEN_MAX_LENGTH
    || typeof value.location_token !== 'string'
    || value.location_token.length === 0
    || value.location_token.length > TOKEN_MAX_LENGTH
  ) {
    throw new Error('INVALID_INPUT');
  }
  return { access_token: value.access_token, location_token: value.location_token };
}

function safeProviderValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return typeof value === 'string' ? value.slice(0, 200) : null;
}

async function exchangeLocation(input: LocationInput, appSecret: string, fetcher: Fetcher): Promise<{ status: number; payload: ZaloPayload }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(ZALO_LOCATION_URL, {
      method: 'GET',
      headers: {
        access_token: input.access_token,
        code: input.location_token,
        secret_key: appSecret,
      },
      signal: controller.signal,
    });
    const payload = await response.json() as ZaloPayload;
    if (!response.ok || payload.error !== undefined && payload.error !== 0) {
      return {
        status: response.status,
        payload: {
          error: safeProviderValue(payload.error),
          message: safeProviderValue(payload.message),
        },
      };
    }
    const latitude = Number(payload.data?.latitude);
    const longitude = Number(payload.data?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('INVALID_PROVIDER_RESPONSE');
    }
    return {
      status: response.status,
      payload: { error: 0, data: { latitude, longitude } },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createZaloLocationRelayServer(config: RelayConfig, fetcher: Fetcher = fetch) {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/zalo/location') {
      sendJson(response, 404, { error: 'NOT_FOUND' });
      return;
    }
    if (!safeEqual(request.headers.authorization, `Bearer ${config.relayToken}`)) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    try {
      const input = await readInput(request);
      const result = await exchangeLocation(input, config.appSecret, fetcher);
      sendJson(response, result.status, result.payload);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      if (code === 'BODY_TOO_LARGE') {
        sendJson(response, 413, { error: 'BODY_TOO_LARGE' });
        return;
      }
      if (code === 'INVALID_INPUT' || error instanceof SyntaxError) {
        sendJson(response, 400, { error: 'INVALID_INPUT' });
        return;
      }
      console.warn('[zalo-location-relay] provider request failed', { code });
      sendJson(response, 502, { error: 'PROVIDER_UNAVAILABLE' });
    }
  });
}

function requiredEnvironment(name: 'ZALO_APP_SECRET' | 'ZALO_LOCATION_RELAY_TOKEN'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

if (require.main === module) {
  const appSecret = requiredEnvironment('ZALO_APP_SECRET');
  const relayToken = requiredEnvironment('ZALO_LOCATION_RELAY_TOKEN');
  if (relayToken.length < 32) {
    throw new Error('ZALO_LOCATION_RELAY_TOKEN must contain at least 32 characters');
  }
  const port = Number(process.env.ZALO_LOCATION_RELAY_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('ZALO_LOCATION_RELAY_PORT is invalid');
  }
  const server = createZaloLocationRelayServer({ appSecret, relayToken });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[zalo-location-relay] listening on http://127.0.0.1:${port}`);
  });
}
