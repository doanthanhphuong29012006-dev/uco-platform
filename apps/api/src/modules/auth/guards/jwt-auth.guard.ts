import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../auth.constants';
import type { AccessTokenPayload, AuthenticatedRequest } from '../auth.types';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
    const bearerToken = token || this.cookie(request.headers.cookie, 'eco_oil_access_token');
    if (!bearerToken) throw new UnauthorizedException('Invalid or expired access token');
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(bearerToken, { secret: this.config.getOrThrow<string>('JWT_SECRET') });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (!payload.sub || !payload.role) throw new UnauthorizedException('Invalid or expired access token');
    let user;
    try {
      user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { role: true, deletedAt: true } });
    } catch {
      throw new ServiceUnavailableException({ code: 'AUTH_USER_LOOKUP_UNAVAILABLE', message: 'Không thể kiểm tra phiên lúc này. Hãy thử lại.', details: null });
    }
    if (!user || user.deletedAt || user.role !== payload.role) throw new UnauthorizedException('Invalid or expired access token');
    request.user = { ...payload, role: user.role };
    return true;
  }

  private cookie(header: string | undefined, name: string): string | null {
    const prefix = `${name}=`;
    const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return value ? decodeURIComponent(value.slice(prefix.length)) : null;
  }
}
