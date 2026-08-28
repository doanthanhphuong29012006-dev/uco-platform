import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AdminLoginInput, RealZaloAuthInput, SeedZaloAuthInput, ZaloAuthInput, ZaloLocationInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  ZALO_OAUTH_HANDOFF_KEY_PREFIX,
  ZALO_OAUTH_HANDOFF_TTL_SECONDS,
  ZALO_OAUTH_STATE_TTL_SECONDS,
  ZALO_AUTH_PROVIDER,
} from './auth.constants';
import type { AccessTokenPayload, AuthUserResponse } from './auth.types';
import type { IZaloAuthProvider } from './providers/zalo-auth.provider';
import { ZaloLocationProvider } from './providers/zalo-location.provider';
import { RedisService } from '../../redis/redis.service';

type UserWithProfiles = Prisma.UserGetPayload<{
  include: {
    merchant: { select: { id: true; approvalStatus: true; rejectionReason: true } };
    collector: { select: { id: true } };
    station: { select: { id: true } };
  };
}>;

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ZALO_AUTH_PROVIDER) private readonly zaloProvider: IZaloAuthProvider,
    @Inject(ZaloLocationProvider) private readonly zaloLocationProvider: ZaloLocationProvider,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async resolveZaloLocation(input: ZaloLocationInput): Promise<{ lat: number; lng: number }> {
    return this.zaloLocationProvider.resolve(input);
  }

  async login(input: ZaloAuthInput): Promise<{
    access_token: string;
    refresh_token: string;
    user: AuthUserResponse;
  }> {
    this.assertAuthModeAllowed();
    let zaloId: string;
    let phone: string | null;
    let requestedName: string | undefined;

    if (this.isMockMode()) {
      if (!this.isSeedZaloAuthInput(input)) {
        throw new BadRequestException({
          code: 'SEED_LOGIN_PAYLOAD_REQUIRED',
          message: 'Chế độ mô phỏng chỉ chấp nhận tài khoản thử nghiệm',
          details: null,
        });
      }
      if (input.zalo_id.startsWith('mock-access-token:')) {
        throw new UnauthorizedException({
          code: 'INVALID_ZALO_ID',
          message: 'Mã Zalo không hợp lệ cho đăng nhập mô phỏng',
          details: null,
        });
      }

      const verified = await this.zaloProvider.verify(input.zalo_id);
      zaloId = verified.zaloId;
      if (!zaloId || zaloId.startsWith('mock-access-token:')) {
        throw new UnauthorizedException({
          code: 'INVALID_ZALO_ID',
          message: 'Mã Zalo không hợp lệ cho đăng nhập mô phỏng',
          details: null,
        });
      }
      phone = input.phone || verified.phone;
      requestedName = input.name ?? verified.name;
    } else {
      if (!this.isRealZaloAuthInput(input)) {
        throw new BadRequestException({
          code: 'ZALO_ACCESS_TOKEN_REQUIRED',
          message: 'Đăng nhập Zalo thật yêu cầu access token hợp lệ',
          details: null,
        });
      }

      const verified = await this.zaloProvider.verify(input.access_token);
      if (!verified.zaloId) {
        throw new UnauthorizedException({
          code: 'INVALID_ZALO_ACCESS_TOKEN',
          message: 'Không xác minh được tài khoản Zalo',
          details: null,
        });
      }
      zaloId = verified.zaloId;
      phone = verified.phone;
      requestedName = verified.name;
    }

    let user = await this.prisma.user.findUnique({ where: { zaloId } });

    if (user?.role === Role.ADMIN) {
      throw new ForbiddenException({ code: 'ADMIN_LOGIN_REQUIRES_PASSWORD', message: 'Tài khoản quản trị phải đăng nhập bằng mật khẩu', details: null });
    }

    user = await this.upsertZaloUser(zaloId, phone, requestedName);

    return this.issueTokens(user.id);
  }

  async startZaloOAuth(): Promise<{ authorizationUrl: string; state: string }> {
    this.requireRealOAuthMode();
    const appId = this.requiredConfig('ZALO_APP_ID');
    const callbackUrl = this.requiredAbsoluteUrl('ZALO_OAUTH_CALLBACK_URL');
    const codeVerifier = randomBytes(32).toString('base64url');
    const state = this.sealOAuthState({
      nonce: randomBytes(24).toString('base64url'),
      code_verifier: codeVerifier,
      issued_at: Date.now(),
    });
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const authorization = new URL('https://oauth.zaloapp.com/v4/permission');
    authorization.search = new URLSearchParams({
      app_id: appId,
      redirect_uri: callbackUrl,
      code_challenge: codeChallenge,
      state,
    }).toString();
    return { authorizationUrl: authorization.toString(), state };
  }

  oauthSuccessRedirect(handoffCode: string): string {
    const redirect = new URL(this.requiredAbsoluteUrl('ZALO_OAUTH_SUCCESS_REDIRECT_URL'));
    redirect.searchParams.set('zalo_code', handoffCode);
    return redirect.toString();
  }

  async completeZaloOAuth(input: {
    state: string;
    cookieState: string | null;
    code?: string;
    error?: string;
    errorDescription?: string;
  }) {
    this.requireRealOAuthMode();
    if (!input.state || !input.cookieState || !this.equalSecrets(input.state, input.cookieState)) {
      throw new UnauthorizedException({ code: 'INVALID_ZALO_OAUTH_STATE', message: 'OAuth state không hợp lệ hoặc đã hết hạn', details: null });
    }
    const sealed = this.openOAuthState(input.state);
    if (!input.code) {
      throw new UnauthorizedException({
        code: 'ZALO_AUTHORIZATION_DENIED',
        message: input.errorDescription || 'Người dùng chưa cấp quyền Zalo',
        details: { provider_error: input.error ?? null },
      });
    }
    const token = await this.zaloProvider.exchangeCode(input.code, sealed.code_verifier);
    const verified = await this.zaloProvider.verify(token.accessToken);
    const existing = await this.prisma.user.findUnique({ where: { zaloId: verified.zaloId } });
    if (existing?.role === Role.ADMIN) {
      throw new ForbiddenException({ code: 'ADMIN_LOGIN_REQUIRES_PASSWORD', message: 'Tài khoản quản trị phải đăng nhập bằng mật khẩu', details: null });
    }
    const user = await this.upsertZaloUser(verified.zaloId, verified.phone, verified.name);
    return this.createOAuthHandoff(user.id);
  }

  async exchangeZaloOAuthCode(code: string) {
    const normalizedCode = code.trim();
    if (!normalizedCode || normalizedCode.length > 256) {
      throw new UnauthorizedException({ code: 'ZALO_OAUTH_HANDOFF_INVALID', message: 'Mã bàn giao đăng nhập không hợp lệ hoặc đã hết hạn', details: null });
    }

    let userId: string | null;
    try {
      userId = await this.redis.consumeOneTime(`${ZALO_OAUTH_HANDOFF_KEY_PREFIX}${this.hashToken(normalizedCode)}`);
    } catch {
      throw new ServiceUnavailableException({ code: 'ZALO_OAUTH_HANDOFF_UNAVAILABLE', message: 'Không hoàn tất được phiên đăng nhập Zalo', details: null });
    }
    if (!userId) {
      throw new UnauthorizedException({ code: 'ZALO_OAUTH_HANDOFF_INVALID', message: 'Mã bàn giao đăng nhập không hợp lệ hoặc đã hết hạn', details: null });
    }
    return this.issueTokens(userId);
  }

  async adminLogin(input: AdminLoginInput) {
    const configuredPassword = this.config.get<string>('ADMIN_PASSWORD')?.trim();
    if (!configuredPassword) {
      throw new UnauthorizedException({ code: 'ADMIN_PASSWORD_NOT_CONFIGURED', message: 'ADMIN_PASSWORD chưa được cấu hình', details: null });
    }
    if (input.password !== configuredPassword) {
      throw new UnauthorizedException({ code: 'INVALID_ADMIN_CREDENTIALS', message: 'Sai tài khoản hoặc mật khẩu quản trị', details: null });
    }
    const user = await this.prisma.user.findUnique({ where: { zaloId: input.zalo_id } });
    if (!user || user.role !== Role.ADMIN || user.deletedAt || user.phone !== input.phone) {
      throw new UnauthorizedException({ code: 'INVALID_ADMIN_CREDENTIALS', message: 'Sai tài khoản hoặc mật khẩu quản trị', details: null });
    }
    return this.issueTokens(user.id);
  }

  async devAccounts() {
    if (!this.isDevelopmentOrTest() || !this.isMockMode()) {
      throw new NotFoundException('Dev accounts are only available in mock mode');
    }
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: [{ role: 'asc' }, { name: 'asc' }, { zaloId: 'asc' }],
      include: {
        merchant: { include: { ward: { select: { code: true, name: true, district: true, city: true } } } },
        collector: { include: { collectorWards: { include: { ward: { select: { code: true, name: true, district: true, city: true } } } } } },
        station: { include: { ward: { select: { code: true, name: true, district: true, city: true } } } },
      },
    });
    return users.filter((user) => {
      if (user.zaloId.includes(':')) return false;
      if (this.isDemoMode() && user.role !== Role.MERCHANT && user.role !== Role.COLLECTOR) return false;
      if (user.merchant) return user.merchant.status === 'ACTIVE' && user.merchant.isActive && user.merchant.deletedAt === null;
      if (user.collector) return user.collector.status === 'ACTIVE' && user.collector.isActive && user.collector.deletedAt === null;
      if (user.station) return user.station.status === 'ACTIVE' && user.station.isActive && user.station.deletedAt === null;
      return true;
    }).map((user) => ({
      id: user.id,
      zalo_id: user.zaloId,
      phone: user.phone,
      name: user.collector?.displayName ?? user.name,
      role: user.role,
      wards: user.collector?.collectorWards.map((item) => item.ward)
        ?? (user.merchant?.ward ? [user.merchant.ward] : user.station?.ward ? [user.station.ward] : []),
    }));
  }

  async refresh(rawRefreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    user: AuthUserResponse;
  }> {
    const tokenHash = this.hashToken(rawRefreshToken);
    const storedToken = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!storedToken || storedToken.revokedAt || storedToken.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.loadUser(storedToken.userId);
    if (!user) {
      throw new UnauthorizedException('User for refresh token was not found');
    }

    return this.issueTokens(user.id, storedToken.id);
  }

  async logout(userId: string, rawRefreshToken?: string): Promise<{ success: true }> {
    if (!rawRefreshToken) {
      await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return { success: true };
    }
    const result = await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        tokenHash: this.hashToken(rawRefreshToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) {
      throw new UnauthorizedException('Invalid or already revoked refresh token');
    }
    return { success: true };
  }

  async me(userId: string): Promise<AuthUserResponse> {
    const user = await this.loadUser(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return this.serializeUser(user);
  }

  private async issueTokens(userId: string, replacedTokenId?: string): Promise<{
    access_token: string;
    refresh_token: string;
    user: AuthUserResponse;
  }> {
    const user = await this.loadUser(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const payload = this.toAccessTokenPayload(user);
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshTokenId = randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    await this.prisma.$transaction(async (transaction) => {
      if (replacedTokenId) {
        const revoked = await transaction.refreshToken.updateMany({
          where: { id: replacedTokenId, revokedAt: null },
          data: { revokedAt: new Date(), replacedBy: refreshTokenId },
        });
        if (revoked.count !== 1) {
          throw new UnauthorizedException('Refresh token has already been rotated');
        }
      }
      await transaction.refreshToken.create({
        data: {
          id: refreshTokenId,
          tokenHash: this.hashToken(refreshToken),
          userId: user.id,
          expiresAt,
        },
      });
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: this.serializeUser(user),
    };
  }

  private async loadUser(userId: string): Promise<UserWithProfiles | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        merchant: { select: { id: true, approvalStatus: true, rejectionReason: true } },
        collector: { select: { id: true } },
        station: { select: { id: true } },
      },
    });
  }

  private toAccessTokenPayload(user: UserWithProfiles): AccessTokenPayload {
    return {
      sub: user.id,
      role: user.role,
      ...(user.merchant ? { merchantId: user.merchant.id } : {}),
      ...(user.collector ? { collectorId: user.collector.id } : {}),
    };
  }

  private serializeUser(user: UserWithProfiles): AuthUserResponse {
    return {
      id: user.id,
      zalo_id: user.zaloId,
      phone: user.phone,
      name: user.name,
      role: user.role,
      merchantId: user.merchant?.id ?? null,
      collectorId: user.collector?.id ?? null,
      merchantApprovalStatus: user.merchant?.approvalStatus ?? null,
      merchantRejectionReason: user.merchant?.rejectionReason ?? null,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async createOAuthHandoff(userId: string): Promise<{ code: string }> {
    const code = randomBytes(32).toString('base64url');
    try {
      await this.redis.setOneTime(
        `${ZALO_OAUTH_HANDOFF_KEY_PREFIX}${this.hashToken(code)}`,
        userId,
        ZALO_OAUTH_HANDOFF_TTL_SECONDS,
      );
    } catch {
      throw new ServiceUnavailableException({ code: 'ZALO_OAUTH_HANDOFF_UNAVAILABLE', message: 'Không tạo được phiên bàn giao đăng nhập Zalo', details: null });
    }
    return { code };
  }

  private isDemoMode(): boolean {
    return this.config.get<string>('DEMO_MODE', 'false').toLowerCase() === 'true';
  }

  private isMockMode(): boolean {
    return this.config.get<string>('ZALO_AUTH_MODE', 'mock') === 'mock';
  }

  private isDevelopmentOrTest(): boolean {
    const environment = this.config.get<string>('NODE_ENV', process.env.NODE_ENV ?? 'development');
    return environment === 'development' || environment === 'test';
  }

  private assertAuthModeAllowed(): void {
    if (!this.isDevelopmentOrTest() && this.isMockMode()) {
      throw new ServiceUnavailableException({ code: 'MOCK_AUTH_DISABLED', message: 'Mock Zalo login is disabled outside development/test', details: null });
    }
  }

  private requireRealOAuthMode(): void {
    this.assertAuthModeAllowed();
    if (this.isMockMode()) {
      throw new ServiceUnavailableException({ code: 'REAL_ZALO_AUTH_REQUIRED', message: 'Real Zalo OAuth is not enabled', details: null });
    }
  }

  private requiredConfig(name: string): string {
    const value = this.config.get<string>(name)?.trim();
    if (!value) {
      throw new ServiceUnavailableException({ code: 'ZALO_CONFIG_MISSING', message: `${name} chưa được cấu hình`, details: { variable: name } });
    }
    return value;
  }

  private requiredAbsoluteUrl(name: string): string {
    const value = this.requiredConfig(name);
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
      return parsed.toString();
    } catch {
      throw new ServiceUnavailableException({ code: 'ZALO_CONFIG_INVALID', message: `${name} phải là callback URL hợp lệ`, details: { variable: name } });
    }
  }

  private async upsertZaloUser(zaloId: string, phone: string | null, name?: string): Promise<UserWithProfiles> {
    return this.prisma.user.upsert({
      where: { zaloId },
      create: { zaloId, phone, name: name ?? null, role: Role.MERCHANT },
      update: { ...(phone ? { phone } : {}), ...(name ? { name } : {}), deletedAt: null },
      include: {
        merchant: { select: { id: true, approvalStatus: true, rejectionReason: true } },
        collector: { select: { id: true } },
        station: { select: { id: true } },
      },
    });
  }

  private sealOAuthState(payload: { nonce: string; code_verifier: string; issued_at: number }): string {
    const key = createHash('sha256').update(this.config.getOrThrow<string>('JWT_SECRET')).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  private openOAuthState(state: string): { nonce: string; code_verifier: string; issued_at: number } {
    try {
      const [ivPart, tagPart, encryptedPart] = state.split('.');
      if (!ivPart || !tagPart || !encryptedPart) throw new Error('Malformed state');
      const key = createHash('sha256').update(this.config.getOrThrow<string>('JWT_SECRET')).digest();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      const raw = Buffer.concat([decipher.update(Buffer.from(encryptedPart, 'base64url')), decipher.final()]).toString('utf8');
      const payload = JSON.parse(raw) as Partial<{ nonce: string; code_verifier: string; issued_at: number }>;
      const issuedAt = payload.issued_at;
      if (!payload.nonce || !payload.code_verifier || payload.code_verifier.length !== 43 || typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || Date.now() - issuedAt > ZALO_OAUTH_STATE_TTL_SECONDS * 1000 || issuedAt > Date.now() + 30_000) throw new Error('Expired state');
      return { nonce: payload.nonce, code_verifier: payload.code_verifier, issued_at: issuedAt };
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_ZALO_OAUTH_STATE', message: 'OAuth state không hợp lệ hoặc đã hết hạn', details: null });
    }
  }

  private equalSecrets(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  private isSeedZaloAuthInput(input: ZaloAuthInput): input is SeedZaloAuthInput {
    return 'zalo_id' in input;
  }

  private isRealZaloAuthInput(input: ZaloAuthInput): input is RealZaloAuthInput {
    return 'access_token' in input;
  }
}
