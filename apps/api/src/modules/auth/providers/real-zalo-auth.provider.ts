import { Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IZaloAuthProvider, ZaloProfile } from './zalo-auth.provider';

const ZALO_TOKEN_URL = 'https://oauth.zaloapp.com/v4/access_token';
const ZALO_PROFILE_URL = 'https://graph.zalo.me/v2.0/me?fields=id,name,picture';
const ZALO_REQUEST_TIMEOUT_MS = 10_000;
const ZALO_PROFILE_RELAY_PATH = '/zalo/profile';

type JsonObject = Record<string, unknown>;

/** Maps the documented /me response without making optional profile fields mandatory. */
export function mapZaloProfileResponse(input: unknown): ZaloProfile | null {
  if (!isJsonObject(input)) return null;

  const zaloId = stringifiedZaloId(input.id);
  if (!zaloId) return null;

  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
  const picture = isJsonObject(input.picture) ? input.picture : null;
  const pictureData = picture && isJsonObject(picture.data) ? picture.data : null;
  const avatarUrl = pictureData && typeof pictureData.url === 'string' && pictureData.url.trim()
    ? pictureData.url.trim()
    : undefined;

  return {
    zaloId,
    phone: null,
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifiedZaloId(value: unknown): string | null {
  if (typeof value === 'string') {
    const result = value.trim();
    return result || null;
  }
  // Zalo documents this as a string, but accepting a JSON number avoids rejecting
  // valid production responses. Never convert the identifier through Number().
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  return null;
}

@Injectable()
export class RealZaloAuthProvider implements IZaloAuthProvider {
  private readonly logger = new Logger(RealZaloAuthProvider.name);

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async exchangeCode(code: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const appId = this.required('ZALO_APP_ID');
    const secretKey = this.required('ZALO_APP_SECRET');
    const response = await this.requestToken(new URLSearchParams({
      code,
      app_id: appId,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }), secretKey);
    return this.parseTokenResponse(response);
  }

  async verify(accessToken: string): Promise<ZaloProfile> {
    if (!accessToken.trim()) {
      throw new UnauthorizedException({ code: 'INVALID_ZALO_ACCESS_TOKEN', message: 'Access token Zalo trống', details: null });
    }

    const relay = this.profileRelayConfig();
    let response: Response;
    try {
      response = relay
        ? await fetch(relay.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-zalo-profile-relay-secret': relay.secret,
          },
          body: JSON.stringify({ access_token: accessToken }),
          signal: AbortSignal.timeout(ZALO_REQUEST_TIMEOUT_MS),
        })
        : await fetch(ZALO_PROFILE_URL, {
          headers: { access_token: accessToken },
          signal: AbortSignal.timeout(ZALO_REQUEST_TIMEOUT_MS),
        });
    } catch {
      throw new ServiceUnavailableException({ code: 'ZALO_PROFILE_UNAVAILABLE', message: 'Không kết nối được Zalo', details: null });
    }

    const body = await this.jsonObject(response);
    const diagnostics = this.profileDiagnostics(response, body, [accessToken, ...(relay ? [relay.secret] : [])]);
    const providerError = this.providerError(body);
    if (!response.ok || (providerError !== null && !this.isSuccessfulProviderError(providerError))) {
      this.logger.warn({ event: 'zalo_profile_request_failed', ...diagnostics });
      if (this.isZaloTokenError(providerError)) {
        throw new UnauthorizedException({
          code: 'INVALID_ZALO_ACCESS_TOKEN',
          message: 'Access token Zalo không hợp lệ hoặc đã hết hạn',
          details: null,
        });
      }
      throw new ServiceUnavailableException({
        code: 'ZALO_PROFILE_API_ERROR',
        message: 'Zalo không thể trả về hồ sơ người dùng',
        details: null,
      });
    }

    const profile = mapZaloProfileResponse(body);
    if (!profile) {
      this.logger.warn({ event: 'zalo_profile_response_invalid', ...diagnostics });
      throw new ServiceUnavailableException({ code: 'ZALO_PROFILE_INVALID', message: 'Zalo trả về hồ sơ không hợp lệ', details: null });
    }
    return profile;
  }

  private async requestToken(body: URLSearchParams, secretKey: string): Promise<JsonObject> {
    let response: Response;
    try {
      response = await fetch(ZALO_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: secretKey },
        body,
        signal: AbortSignal.timeout(ZALO_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'ZALO_TOKEN_EXCHANGE_UNAVAILABLE', message: 'Không kết nối được máy chủ OAuth của Zalo', details: null });
    }

    const result = await this.jsonObject(response);
    if (!response.ok || (this.providerError(result) !== null && !this.isSuccessfulProviderError(this.providerError(result)))) {
      throw new UnauthorizedException({
        code: 'ZALO_TOKEN_EXCHANGE_ERROR',
        message: 'Không đổi được authorization code Zalo lấy access token',
        details: {
          zalo_error: this.safeDiagnostic(this.providerError(result)),
          zalo_message: this.safeDiagnostic(this.providerMessage(result)),
        },
      });
    }
    return result;
  }

  private parseTokenResponse(body: JsonObject): { accessToken: string; refreshToken: string; expiresIn: number } {
    const expiresIn = typeof body.expires_in === 'string' || typeof body.expires_in === 'number' ? Number(body.expires_in) : NaN;
    if (
      !Number.isFinite(expiresIn)
      || expiresIn <= 0
      || typeof body.access_token !== 'string'
      || !body.access_token.trim()
      || typeof body.refresh_token !== 'string'
      || !body.refresh_token.trim()
    ) {
      throw new ServiceUnavailableException({ code: 'ZALO_TOKEN_RESPONSE_INVALID', message: 'Phản hồi token Zalo không hợp lệ', details: null });
    }
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn };
  }

  private async jsonObject(response: Response): Promise<JsonObject> {
    try {
      const body: unknown = await response.json();
      return isJsonObject(body) ? body : {};
    } catch {
      return {};
    }
  }

  private profileDiagnostics(response: Response, body: JsonObject, sensitiveValues: readonly string[] = []): {
    status: number;
    content_type: string | null;
    top_level_keys: string[];
    provider_error: string | number | boolean | null;
    provider_message: string | number | boolean | null;
  } {
    return {
      status: response.status,
      content_type: response.headers.get('content-type'),
      top_level_keys: Object.keys(body),
      provider_error: this.safeDiagnostic(this.providerError(body), sensitiveValues),
      provider_message: this.safeDiagnostic(this.providerMessage(body), sensitiveValues),
    };
  }

  private providerError(body: JsonObject): unknown {
    return body.error ?? body.error_code ?? body.code ?? null;
  }

  private providerMessage(body: JsonObject): unknown {
    return body.message ?? body.error_message ?? null;
  }

  private isZaloTokenError(error: unknown): boolean {
    const normalized = typeof error === 'number' ? error : typeof error === 'string' && /^\d+$/.test(error) ? Number(error) : null;
    return normalized === 452;
  }

  private isSuccessfulProviderError(error: unknown): boolean {
    return error === 0 || error === '0';
  }

  private safeDiagnostic(value: unknown, sensitiveValues: readonly string[] = []): string | number | boolean | null {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      let result = value.slice(0, 200);
      for (const sensitiveValue of sensitiveValues) {
        if (sensitiveValue) result = result.split(sensitiveValue).join('[REDACTED]');
      }
      return result;
    }
    return value === undefined ? null : `[${typeof value}]`;
  }

  private profileRelayConfig(): { url: string; secret: string } | null {
    const configuredUrl = this.config.get<string>('ZALO_PROFILE_RELAY_URL')?.trim();
    if (!configuredUrl) return null;

    const secret = this.config.get<string>('ZALO_PROFILE_RELAY_SECRET')?.trim();
    if (!secret) {
      throw new ServiceUnavailableException({
        code: 'ZALO_CONFIG_MISSING',
        message: 'ZALO_PROFILE_RELAY_SECRET chưa được cấu hình',
        details: { variable: 'ZALO_PROFILE_RELAY_SECRET' },
      });
    }

    let relayUrl: URL;
    try {
      relayUrl = new URL(configuredUrl);
    } catch {
      throw new ServiceUnavailableException({
        code: 'ZALO_PROFILE_RELAY_CONFIG_INVALID',
        message: 'Cấu hình relay profile Zalo không hợp lệ',
        details: null,
      });
    }
    const isLocalHttp = relayUrl.protocol === 'http:' && (relayUrl.hostname === '127.0.0.1' || relayUrl.hostname === 'localhost');
    if ((relayUrl.protocol !== 'https:' && !isLocalHttp) || relayUrl.username || relayUrl.password || !secret) {
      throw new ServiceUnavailableException({
        code: 'ZALO_PROFILE_RELAY_CONFIG_INVALID',
        message: 'Relay profile Zalo cần URL HTTPS hoặc localhost HTTP',
        details: null,
      });
    }
    relayUrl.pathname = ZALO_PROFILE_RELAY_PATH;
    relayUrl.search = '';
    relayUrl.hash = '';
    return { url: relayUrl.toString(), secret };
  }

  private required(name: string): string {
    const value = this.config.get<string>(name)?.trim();
    if (!value) throw new ServiceUnavailableException({ code: 'ZALO_CONFIG_MISSING', message: `${name} chưa được cấu hình`, details: { variable: name } });
    return value;
  }
}
