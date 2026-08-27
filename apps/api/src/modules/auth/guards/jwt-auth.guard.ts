import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
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
    try {
      const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
      const bearerToken = token || this.cookie(request.headers.cookie, 'eco_oil_access_token');
      if (!bearerToken) throw new Error('Missing access token');
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(bearerToken, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });
      if (!payload.sub || !payload.role) {
        throw new Error('Invalid access token payload');
      }
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { role: true, deletedAt: true },
      });
      if (!user || user.deletedAt || user.role !== payload.role) {
        throw new Error('Access token no longer matches the current user');
      }
      request.user = { ...payload, role: user.role };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private cookie(header: string | undefined, name: string): string | null {
    const prefix = `${name}=`;
    const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return value ? decodeURIComponent(value.slice(prefix.length)) : null;
  }
}
