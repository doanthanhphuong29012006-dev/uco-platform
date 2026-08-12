import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ZaloAuthInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  ZALO_AUTH_PROVIDER,
} from './auth.constants';
import type { AccessTokenPayload, AuthUserResponse } from './auth.types';
import type { IZaloAuthProvider } from './providers/zalo-auth.provider';

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
  ) {}

  async login(input: ZaloAuthInput): Promise<{
    access_token: string;
    refresh_token: string;
    user: AuthUserResponse;
  }> {
    const verified = await this.zaloProvider.verify(input.zalo_id);
    const zaloId = verified.zaloId || input.zalo_id;
    const phone = input.phone || verified.phone;
    let user = await this.prisma.user.findUnique({ where: { zaloId } });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          zaloId,
          phone,
          name: input.name ?? verified.name ?? null,
          role: Role.MERCHANT,
        },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          phone,
          ...(input.name || verified.name ? { name: input.name ?? verified.name } : {}),
          deletedAt: null,
        },
      });
    }

    return this.issueTokens(user.id);
  }

  async devAccounts() {
    if (this.config.get<string>('ZALO_AUTH_MODE', 'mock') !== 'mock') {
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
    return users.map((user) => ({
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

  async logout(userId: string, rawRefreshToken: string): Promise<{ success: true }> {
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
}
