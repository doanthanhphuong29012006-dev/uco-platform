import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedisService } from '../../redis/redis.service';
import { AuthService } from './auth.service';
import type { ZaloLocationProvider } from './providers/zalo-location.provider';

describe('AuthService auth-mode safety', () => {
  it('does not invoke mock login outside development/test', async () => {
    const config = {
      get: jest.fn((name: string, fallback?: unknown) => ({ NODE_ENV: 'production', ZALO_AUTH_MODE: 'mock' }[name] ?? fallback)),
    } as unknown as ConfigService;
    const provider = { verify: jest.fn(), exchangeCode: jest.fn() };
    const service = new AuthService({} as PrismaService, {} as JwtService, config, provider, {} as ZaloLocationProvider, {} as RedisService);

    await expect(service.login({ zalo_id: 'dev-account', phone: '0900000000' })).rejects.toMatchObject({ response: { code: 'MOCK_AUTH_DISABLED' } });
    expect(provider.verify).not.toHaveBeenCalled();
  });
});
