import { BadGatewayException, Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ZaloLocationInput } from '@eco-oil/validation';

const ZALO_LOCATION_URL = 'https://graph.zalo.me/v2.0/me/info';
const ZALO_LOCATION_TIMEOUT_MS = 5_000;
const MIN_RELAY_TOKEN_LENGTH = 32;

type ZaloLocationResponse = {
  service?: unknown;
  version?: unknown;
  error?: unknown;
  message?: unknown;
  data?: {
    latitude?: unknown;
    longitude?: unknown;
  };
};

export type ZaloLocation = { lat: number; lng: number };
type LocationExchange = { response: Response; payload: ZaloLocationResponse };
type RelayConfig = { url: string; token: string };

@Injectable()
export class ZaloLocationProvider {
  private readonly logger = new Logger(ZaloLocationProvider.name);

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async resolve(input: ZaloLocationInput): Promise<ZaloLocation> {
    const relay = this.getRelayConfig();
    const secret = this.config.get<string>('ZALO_APP_SECRET')?.trim();
    if (!relay && !secret) {
      throw new ServiceUnavailableException({
        code: 'ZALO_APP_SECRET_NOT_CONFIGURED',
        message: 'ZALO_APP_SECRET chưa được cấu hình ở backend',
        details: null,
      });
    }

    const { response, payload } = relay
      ? await this.exchangeThroughRelay(input, relay)
      : await this.exchangeDirectly(input, secret!);

    if (relay && (response.status === 404 || response.status === 405)) {
      throw new BadGatewayException({ code: 'ZALO_LOCATION_RELAY_ENDPOINT_INVALID', message: 'Tunnel không định tuyến /zalo/location đến Location Relay (8787).', details: null });
    }
    if (relay && response.status === 401 && payload.error === 'UNAUTHORIZED') {
      throw new BadGatewayException({ code: 'ZALO_LOCATION_RELAY_AUTH_FAILED', message: 'Token xác thực backend với Location Relay không khớp.', details: null });
    }
    if (response.status >= 500) {
      throw new BadGatewayException({
        code: 'ZALO_LOCATION_PROVIDER_UNAVAILABLE',
        message: 'Dịch vụ vị trí Zalo tạm thời không khả dụng',
        details: null,
      });
    }
    if (payload.error === -501) {
      throw new ServiceUnavailableException({
        code: 'ZALO_LOCATION_REGION_RESTRICTED',
        message: 'Máy chủ giải mã vị trí phải sử dụng địa chỉ IP tại Việt Nam',
        details: null,
      });
    }
    if (payload.error === 116) {
      throw new ServiceUnavailableException({ code: 'ZALO_LOCATION_SECRET_MISSING', message: 'Zalo App Secret chưa được cấu hình đúng ở backend.', details: null });
    }
    if (payload.error === 117) {
      throw new ServiceUnavailableException({ code: 'ZALO_LOCATION_SECRET_INVALID', message: 'Zalo App Secret không hợp lệ. Kiểm tra đúng ứng dụng Zalo ở backend.', details: null });
    }
    if (payload.error === 118) {
      throw new UnauthorizedException({ code: 'ZALO_LOCATION_CODE_WRONG_APP', message: 'Mã vị trí không thuộc ứng dụng Zalo đang cấu hình. Hãy lấy lại vị trí trong Mini App.', details: null });
    }
    if (payload.error === 119) {
      throw new UnauthorizedException({ code: 'ZALO_LOCATION_CODE_USED', message: 'Mã vị trí Zalo đã được sử dụng. Hãy lấy lại vị trí rồi thử lại.', details: null });
    }
    if (!response.ok || payload.error !== undefined && payload.error !== 0) {
      this.logger.warn({
        event: 'zalo_location_exchange_rejected',
        status: response.status,
        provider_error: typeof payload.error === 'number' ? payload.error : null,
      });
      throw new UnauthorizedException({
        code: 'ZALO_LOCATION_TOKEN_INVALID',
        message: 'Token vị trí Zalo không hợp lệ hoặc đã hết hạn',
        details: null,
      });
    }

    const lat = Number(payload.data?.latitude);
    const lng = Number(payload.data?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw this.invalidResponse();
    }
    return { lat, lng };
  }

  private async exchangeDirectly(input: ZaloLocationInput, secret: string): Promise<LocationExchange> {
    return this.exchange(ZALO_LOCATION_URL, {
      method: 'GET',
      headers: {
        access_token: input.access_token,
        code: input.location_token,
        secret_key: secret,
      },
    });
  }

  private async exchangeThroughRelay(input: ZaloLocationInput, relay: RelayConfig): Promise<LocationExchange> {
    const health = await this.exchange(new URL('/health', relay.url).toString(), { method: 'GET' });
    if (!health.response.ok || health.payload.service !== 'ecollect-zalo-location-relay' || health.payload.version !== 2) {
      throw new BadGatewayException({
        code: 'ZALO_LOCATION_RELAY_SERVICE_MISMATCH',
        message: 'URL GPS không tới Location Relay version 2. Kiểm tra tunnel cổng 8787, không dùng tunnel Profile Relay 8788.',
        details: null,
      });
    }
    return this.exchange(relay.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${relay.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  }

  private async exchange(url: string, options: RequestInit): Promise<LocationExchange> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ZALO_LOCATION_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      this.logger.log({ event: 'zalo_location_http', stage: options.method === 'GET' && url.endsWith('/health') ? 'relay-health' : 'exchange', http_status: response.status, elapsed_ms: Date.now() - started });
      if (response.status === 404 || response.status === 405) throw new BadGatewayException({ code: 'ZALO_LOCATION_RELAY_ENDPOINT_INVALID', message: 'Endpoint vị trí không tồn tại. Kiểm tra URL và cổng tunnel.', details: null });
      try {
        const payload = await response.json() as ZaloLocationResponse;
        return { response, payload };
      } catch {
        throw this.invalidResponse();
      }
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw error;
      }
      throw new BadGatewayException({
        code: controller.signal.aborted ? 'ZALO_LOCATION_TIMEOUT' : 'ZALO_LOCATION_PROVIDER_UNAVAILABLE',
        message: controller.signal.aborted ? 'Dịch vụ đổi token vị trí quá thời gian chờ. Hãy lấy token mới.' : 'Không kết nối được dịch vụ vị trí Zalo',
        details: null,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private getRelayConfig(): RelayConfig | null {
    const urlValue = this.config.get<string>('ZALO_LOCATION_RELAY_URL')?.trim();
    const token = this.config.get<string>('ZALO_LOCATION_RELAY_TOKEN')?.trim();
    if (!urlValue && !token) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(urlValue ?? '');
    } catch {
      throw new ServiceUnavailableException({
        code: 'ZALO_LOCATION_RELAY_CONFIG_INVALID',
        message: 'Cấu hình relay vị trí Zalo không hợp lệ',
        details: null,
      });
    }
    if (url.protocol !== 'https:' || url.pathname !== '/zalo/location' || url.search || url.username || url.password || !token || token.length < MIN_RELAY_TOKEN_LENGTH) {
      throw new ServiceUnavailableException({
        code: 'ZALO_LOCATION_RELAY_CONFIG_INVALID',
        message: 'Relay vị trí Zalo cần URL HTTPS và token tối thiểu 32 ký tự',
        details: null,
      });
    }
    return { url: url.toString(), token };
  }

  private safeDiagnostic(value: unknown): string | number | boolean | null {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return value.slice(0, 200);
    }
    return value === undefined ? null : `[${typeof value}]`;
  }

  private invalidResponse(): BadGatewayException {
    return new BadGatewayException({
      code: 'INVALID_ZALO_LOCATION_RESPONSE',
      message: 'Phản hồi vị trí từ Zalo không hợp lệ',
      details: null,
    });
  }
}
