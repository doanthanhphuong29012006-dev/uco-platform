import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedisService } from '../../redis/redis.service';
import { AuthService } from './auth.service';
import type { ZaloLocationProvider } from './providers/zalo-location.provider';
import { Role } from '@prisma/client';

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

describe('AuthService stable Zalo identity mapping', () => {
  it('maps repeated login for one Zalo ID to the existing User and Collector', async () => {
    const user = {
      id: 'user-existing',
      zaloId: 'zalo-stable',
      phone: '0900000001',
      name: 'Collector cũ',
      role: Role.COLLECTOR,
      deletedAt: null,
      merchant: null,
      collector: { id: 'collector-existing' },
      station: null,
    };
    const config = {
      get: jest.fn((name: string, fallback?: unknown) => ({ NODE_ENV: 'test', ZALO_AUTH_MODE: 'mock' }[name] ?? fallback)),
      getOrThrow: jest.fn(() => 'test-secret'),
    } as unknown as ConfigService;
    const provider = { verify: jest.fn().mockResolvedValue({ zaloId: 'zalo-stable', phone: '0900000001', name: 'Collector cũ' }), exchangeCode: jest.fn() };
    const tx = { refreshToken: { create: jest.fn().mockResolvedValue({}) } };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        upsert: jest.fn().mockResolvedValue(user),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
    const service = new AuthService(prisma as never, jwt as never, config, provider, {} as ZaloLocationProvider, {} as RedisService);

    const first = await service.login({ zalo_id: 'zalo-stable', phone: '0900000001' });
    const second = await service.login({ zalo_id: 'zalo-stable', phone: '0900000001' });

    expect(first.user).toMatchObject({ id: 'user-existing', collectorId: 'collector-existing', role: Role.COLLECTOR });
    expect(second.user).toMatchObject({ id: 'user-existing', collectorId: 'collector-existing', role: Role.COLLECTOR });
    expect(prisma.user.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.user.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { zaloId: 'zalo-stable' } }));
    expect(prisma.user.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { zaloId: 'zalo-stable' } }));
  });
});
