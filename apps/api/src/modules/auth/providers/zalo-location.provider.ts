import { BadGatewayException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ZaloLocationInput } from '@eco-oil/validation';

const ZALO_LOCATION_URL = 'https://graph.zalo.me/v2.0/me/info';
const ZALO_LOCATION_TIMEOUT_MS = 5_000;

type ZaloLocationResponse = {
  error?: unknown;
  data?: {
    latitude?: unknown;
    longitude?: unknown;
  };
};

export type ZaloLocation = { lat: number; lng: number };

@Injectable()
export class ZaloLocationProvider {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async resolve(input: ZaloLocationInput): Promise<ZaloLocation> {
    const secret = this.config.get<string>('ZALO_APP_SECRET')?.trim();
    if (!secret) {
      throw new ServiceUnavailableException({
        code: 'ZALO_APP_SECRET_NOT_CONFIGURED',
        message: 'ZALO_APP_SECRET chưa được cấu hình ở backend',
        details: null,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ZALO_LOCATION_TIMEOUT_MS);
    let response: Response;
    let payload: ZaloLocationResponse;
    try {
      response = await fetch(ZALO_LOCATION_URL, {
        method: 'GET',
        headers: {
          access_token: input.access_token,
          code: input.location_token,
          secret_key: secret,
        },
        signal: controller.signal,
      });
      try {
        payload = await response.json() as ZaloLocationResponse;
      } catch {
        throw this.invalidResponse();
      }
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw error;
      }
      throw new BadGatewayException({
        code: 'ZALO_LOCATION_PROVIDER_UNAVAILABLE',
        message: 'Không kết nối được dịch vụ vị trí Zalo',
        details: null,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 500) {
      throw new BadGatewayException({
        code: 'ZALO_LOCATION_PROVIDER_UNAVAILABLE',
        message: 'Dịch vụ vị trí Zalo tạm thời không khả dụng',
        details: null,
      });
    }
    if (!response.ok || payload.error !== undefined && payload.error !== 0) {
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

  private invalidResponse(): BadGatewayException {
    return new BadGatewayException({
      code: 'INVALID_ZALO_LOCATION_RESPONSE',
      message: 'Phản hồi vị trí từ Zalo không hợp lệ',
      details: null,
    });
  }
}
