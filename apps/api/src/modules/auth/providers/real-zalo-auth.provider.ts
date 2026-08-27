import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IZaloAuthProvider } from './zalo-auth.provider';

@Injectable()
export class RealZaloAuthProvider implements IZaloAuthProvider {
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

  async verify(accessToken: string): Promise<{ zaloId: string; phone: string | null; name?: string }> {
    if (!accessToken.trim()) {
      throw new UnauthorizedException({ code: 'INVALID_ZALO_ACCESS_TOKEN', message: 'Access token Zalo trống', details: null });
    }
    let response: Response;
    try {
      response = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name,picture', {
        headers: { access_token: accessToken },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'ZALO_PROFILE_UNAVAILABLE', message: 'Không kết nối được Zalo', details: null });
    }
    const body = await this.jsonObject(response);
    if (!response.ok || Number(body.error ?? 0) !== 0 || typeof body.id !== 'string' || !body.id.trim()) {
      if (this.isZaloTokenError(body)) {
        throw new UnauthorizedException({ code: 'INVALID_ZALO_ACCESS_TOKEN', message: 'Access token Zalo không hợp lệ hoặc đã hết hạn', details: { zalo_error: body.error ?? null } });
      }
      throw new ServiceUnavailableException({ code: 'ZALO_PROFILE_INVALID', message: 'Zalo trả về hồ sơ không hợp lệ', details: null });
    }
    return { zaloId: body.id, phone: null, ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}) };
  }

  private async requestToken(body: URLSearchParams, secretKey: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch('https://oauth.zaloapp.com/v4/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: secretKey },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'ZALO_TOKEN_UNAVAILABLE', message: 'Không kết nối được máy chủ OAuth của Zalo', details: null });
    }
    const result = await this.jsonObject(response);
    if (!response.ok || typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string') {
      throw new UnauthorizedException({ code: 'INVALID_ZALO_AUTHORIZATION_CODE', message: 'Authorization code Zalo không hợp lệ hoặc đã hết hạn', details: { zalo_error: result.error ?? null } });
    }
    return result;
  }

  private parseTokenResponse(body: Record<string, unknown>): { accessToken: string; refreshToken: string; expiresIn: number } {
    const expiresIn = Number(body.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
      throw new ServiceUnavailableException({ code: 'ZALO_TOKEN_RESPONSE_INVALID', message: 'Phản hồi token Zalo không hợp lệ', details: null });
    }
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn };
  }

  private async jsonObject(response: Response): Promise<Record<string, unknown>> {
    try {
      const body: unknown = await response.json();
      return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private isZaloTokenError(body: Record<string, unknown>): boolean {
    const error = Number(body.error);
    return error === 100 || error === 110 || error === 111 || error === 210 || error === 452 || error === 11004;
  }

  private required(name: string): string {
    const value = this.config.get<string>(name)?.trim();
    if (!value) throw new ServiceUnavailableException({ code: 'ZALO_CONFIG_MISSING', message: `${name} chưa được cấu hình`, details: { variable: name } });
    return value;
  }
}
