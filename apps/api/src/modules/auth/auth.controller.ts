import { Body, Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { Role } from '@prisma/client';
import { adminLoginSchema, refreshTokenSchema, zaloAuthSchema, zaloLocationSchema, zaloOAuthExchangeSchema } from '@eco-oil/validation';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import type { AccessTokenPayload } from './auth.types';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, ZALO_ACCESS_COOKIE, ZALO_OAUTH_STATE_COOKIE, ZALO_OAUTH_STATE_TTL_SECONDS, ZALO_REFRESH_COOKIE } from './auth.constants';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Public()
  @Post('zalo')
  login(@Body() body: unknown) {
    return this.authService.login(zaloAuthSchema.parse(body));
  }

  @Public()
  @Get('zalo/start')
  async startZaloOAuth(@Res({ passthrough: true }) response: Response) {
    const result = await this.authService.startZaloOAuth();
    response.setHeader('Set-Cookie', this.cookie(ZALO_OAUTH_STATE_COOKIE, result.state, ZALO_OAUTH_STATE_TTL_SECONDS, '/api/v1/auth/zalo'));
    response.redirect(result.authorizationUrl);
  }

  @Public()
  @Get('zalo/callback')
  async completeZaloOAuth(@Req() request: Request, @Query() query: Record<string, unknown>, @Res() response: Response) {
    const result = await this.authService.completeZaloOAuth({
      state: this.stringQuery(query.state),
      cookieState: this.cookieValue(request.headers.cookie, ZALO_OAUTH_STATE_COOKIE),
      code: this.optionalStringQuery(query.code),
      error: this.optionalStringQuery(query.error),
      errorDescription: this.optionalStringQuery(query.error_description),
    });
    response.setHeader('Set-Cookie', [
      this.cookie(ZALO_ACCESS_COOKIE, '', 0, '/'),
      this.cookie(ZALO_REFRESH_COOKIE, '', 0, '/'),
      this.cookie(ZALO_OAUTH_STATE_COOKIE, '', 0, '/api/v1/auth/zalo'),
    ]);
    response.redirect(this.authService.oauthSuccessRedirect(result.code));
  }

  @Public()
  @Post('zalo/exchange')
  exchangeZaloOAuth(@Body() body: unknown) {
    return this.authService.exchangeZaloOAuthCode(zaloOAuthExchangeSchema.parse(body).code);
  }

  @Public()
  @Post('admin/login')
  adminLogin(@Body() body: unknown) {
    return this.authService.adminLogin(adminLoginSchema.parse(body));
  }

  @Public()
  @Get('dev-accounts')
  devAccounts() {
    return this.authService.devAccounts();
  }

  @Public()
  @Post('refresh')
  refresh(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const bodyToken = typeof body === 'object' && body !== null && 'refresh_token' in body && typeof body.refresh_token === 'string' ? body.refresh_token : null;
    const refreshToken = bodyToken || this.cookieValue(request.headers.cookie, ZALO_REFRESH_COOKIE) || refreshTokenSchema.parse(body).refresh_token;
    return this.authService.refresh(refreshToken).then((result) => {
      response.setHeader('Set-Cookie', [
        this.cookie(ZALO_ACCESS_COOKIE, result.access_token, ACCESS_TOKEN_TTL_SECONDS, '/'),
        this.cookie(ZALO_REFRESH_COOKIE, result.refresh_token, REFRESH_TOKEN_TTL_SECONDS, '/'),
      ]);
      return result;
    });
  }

  @Roles(Role.MERCHANT, Role.COLLECTOR, Role.STATION, Role.ADMIN)
  @Post('logout')
  logout(@CurrentUser() user: AccessTokenPayload, @Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const bodyToken = typeof body === 'object' && body !== null && 'refresh_token' in body && typeof body.refresh_token === 'string' ? body.refresh_token : null;
    const refreshToken = bodyToken || this.cookieValue(request.headers.cookie, ZALO_REFRESH_COOKIE) || undefined;
    response.setHeader('Set-Cookie', [
      this.cookie(ZALO_ACCESS_COOKIE, '', 0, '/'),
      this.cookie(ZALO_REFRESH_COOKIE, '', 0, '/'),
    ]);
    return this.authService.logout(user.sub, refreshToken);
  }

  @Roles(Role.MERCHANT, Role.COLLECTOR, Role.STATION, Role.ADMIN)
  @Get('me')
  me(@CurrentUser() user: AccessTokenPayload) {
    return this.authService.me(user.sub);
  }

  @Roles(Role.MERCHANT, Role.COLLECTOR, Role.STATION, Role.ADMIN)
  @Post('zalo/location')
  resolveZaloLocation(@Body() body: unknown) {
    return this.authService.resolveZaloLocation(zaloLocationSchema.parse(body));
  }

  @Roles(Role.ADMIN)
  @Get('admin-check')
  adminCheck() {
    return { ok: true, role: Role.ADMIN };
  }

  private stringQuery(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private optionalStringQuery(value: unknown): string | undefined {
    const result = this.stringQuery(value);
    return result || undefined;
  }

  private cookieValue(header: string | undefined, name: string): string | null {
    const prefix = `${name}=`;
    const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return value ? decodeURIComponent(value.slice(prefix.length)) : null;
  }

  private cookie(name: string, value: string, maxAge: number, path: string): string {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    const sameSite = process.env.NODE_ENV === 'production' ? 'None' : 'Lax';
    const expiry = maxAge === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '';
    return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=${path}; Max-Age=${maxAge}; SameSite=${sameSite}${secure}${expiry}`;
  }
}
