import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Role } from '@prisma/client';
import { adminCollectorCreateSchema } from '@eco-oil/validation';
import { AdminService } from './admin.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedisService } from '../../redis/redis.service';
import type { StationsService } from '../stations/stations.service';
import { AuthService } from '../auth/auth.service';

const wardId = '10000000-0000-4000-8000-000000000001';
const collectorId = '40000000-0000-4000-8000-000000000001';
const userId = '40000000-0000-4000-8000-000000000002';

function collectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: collectorId,
    userId: null,
    displayName: 'Người thu gom thử nghiệm',
    contactPhone: '0900000000',
    vehicleType: 'Xe máy',
    maxCapacityLiters: 100,
    status: 'ACTIVE',
    isActive: true,
    linkStatus: 'PENDING_LINK',
    inviteCodeHash: 'stored-hash',
    inviteExpiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    collectorWards: [{ wardId, ward: { id: wardId, code: 'P1', name: 'Phường 1' } }],
    user: null,
    ...overrides,
  };
}

function config(): ConfigService {
  return {
    get: jest.fn((name: string) =>
      name === 'ZALO_OAUTH_SUCCESS_REDIRECT_URL' ? 'https://miniapp.example.test/' : undefined,
    ),
  } as unknown as ConfigService;
}

describe('collector invitation flow', () => {
  it('recovers an active invite URL after the Admin page reloads', async () => {
    const inviteCode = 'persisted-active-invite';
    const row = collectorRow({
      inviteCodeHash: createHash('sha256').update(inviteCode).digest('hex'),
    });
    const prisma = {
      collector: {
        findMany: jest.fn().mockResolvedValue([row]),
        count: jest.fn().mockResolvedValue(1),
      },
    } as unknown as PrismaService;
    const redis = { getValue: jest.fn().mockResolvedValue(inviteCode) } as unknown as RedisService;
    const service = new AdminService(prisma, config(), {} as StationsService, redis);

    const result = await service.listCollectors({ page: 1, limit: 20, include_inactive: true });

    expect(result.data[0]).toMatchObject({
      invite_status: 'PENDING',
      invite_expires_at: expect.any(String),
    });
    expect(result.data[0].invite_url).toContain(`collector_invite=${inviteCode}`);
  });

  it('does not expose a URL when Redis lost the active plaintext invite', async () => {
    const row = collectorRow();
    const prisma = {
      collector: {
        findMany: jest.fn().mockResolvedValue([row]),
        count: jest.fn().mockResolvedValue(1),
      },
    } as unknown as PrismaService;
    const redis = { getValue: jest.fn().mockResolvedValue(null) } as unknown as RedisService;
    const service = new AdminService(prisma, config(), {} as StationsService, redis);

    const result = await service.listCollectors({ page: 1, limit: 20, include_inactive: true });

    expect(result.data[0].invite_url).toBeNull();
  });

  it('creates a pending collector without accepting a Zalo ID from the request', async () => {
    const input = {
      name: 'Người thu gom thử nghiệm',
      phone: '0900000000',
      vehicle_type: 'Xe máy',
      max_capacity_l: 100,
      ward_ids: [wardId],
    };
    expect(() =>
      adminCollectorCreateSchema.parse({ ...input, zalo_id: 'must-not-be-accepted' }),
    ).toThrow();
    const create = jest.fn().mockResolvedValue({});
    const findUnique = jest.fn().mockResolvedValue(collectorRow());
    const redis = {
      setOneTime: jest.fn().mockResolvedValue(undefined),
      setExpiring: jest.fn().mockResolvedValue(undefined),
      deleteOneTime: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;
    const prisma = {
      ward: { findMany: jest.fn().mockResolvedValue([{ id: wardId }]) },
      collector: { create, findUnique },
    } as unknown as PrismaService;
    const service = new AdminService(prisma, config(), {} as StationsService, redis);

    const result = await service.createCollector(input);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.any(String),
          userId: null,
          linkStatus: 'PENDING_LINK',
          contactPhone: input.phone,
        }),
      }),
    );
    expect(create.mock.calls[0][0].data).not.toHaveProperty('zaloId');
    expect(redis.setOneTime).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:collector:invite:[a-f0-9]{64}$/),
      expect.any(String),
      expect.any(Number),
    );
    expect(result.collector.link_status).toBe('PENDING_LINK');
    expect(result.invite_url).toContain('collector_invite=');
  });

  it('links the authenticated user by internal ID and issues a collector session atomically', async () => {
    const invitation = collectorRow({ inviteCodeHash: 'hash-not-used-in-test' });
    const inviteCode = 'invite-code-fixture';
    invitation.inviteCodeHash = createHash('sha256').update(inviteCode).digest('hex');
    const currentUser = {
      id: userId,
      zaloId: 'zalo-from-profile',
      phone: null,
      name: 'Collector',
      role: Role.MERCHANT,
      deletedAt: null,
      merchant: null,
      collector: null,
    };
    const linkedUser = {
      ...currentUser,
      role: Role.COLLECTOR,
      collector: { id: collectorId },
      station: null,
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const userUpdate = jest.fn().mockResolvedValue(linkedUser);
    const tx = {
      user: { findUnique: jest.fn().mockResolvedValue(currentUser), update: userUpdate },
      collector: { updateMany },
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      collector: { findUnique: jest.fn().mockResolvedValue(invitation) },
      user: { findUnique: jest.fn().mockResolvedValue(linkedUser) },
      $transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const redis = {
      consumeOneTime: jest.fn().mockResolvedValue(collectorId),
      restoreOneTime: jest.fn().mockResolvedValue(undefined),
      deleteOneTime: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;
    const jwt = { signAsync: jest.fn().mockResolvedValue('jwt-fixture') };
    const auth = new AuthService(
      prisma,
      jwt as never,
      { getOrThrow: jest.fn().mockReturnValue('jwt-secret') } as never,
      {} as never,
      {} as never,
      redis,
    );

    const session = await auth.acceptCollectorInvite(
      { sub: userId, role: Role.MERCHANT },
      inviteCode,
    );
    expect(tx.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: userId } }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: collectorId, userId: null }),
      }),
    );
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: userId },
      data: { role: Role.COLLECTOR },
    });
    expect(session.user).toMatchObject({
      id: userId,
      zalo_id: 'zalo-from-profile',
      role: Role.COLLECTOR,
      collectorId: collectorId,
    });
    expect(redis.restoreOneTime).not.toHaveBeenCalled();
  });

  it('rejects a merchant with an existing merchant profile and preserves the invite for retry', async () => {
    const inviteCode = 'invite-role-conflict-fixture';
    const hash = createHash('sha256').update(inviteCode).digest('hex');
    const invitation = collectorRow({ inviteCodeHash: hash });
    const prisma = {
      collector: { findUnique: jest.fn().mockResolvedValue(invitation) },
      $transaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({
          user: {
            findUnique: jest
              .fn()
              .mockResolvedValue({
                id: userId,
                role: Role.MERCHANT,
                deletedAt: null,
                merchant: { id: 'merchant-1' },
                collector: null,
              }),
          },
        }),
      ),
    } as unknown as PrismaService;
    const redis = {
      consumeOneTime: jest.fn().mockResolvedValue(collectorId),
      restoreOneTime: jest.fn().mockResolvedValue(undefined),
      deleteOneTime: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;
    const auth = new AuthService(prisma, {} as never, {} as never, {} as never, {} as never, redis);

    await expect(
      auth.acceptCollectorInvite({ sub: userId, role: Role.MERCHANT }, inviteCode),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(redis.restoreOneTime).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:collector:invite:/),
      collectorId,
      expect.any(Number),
    );
  });

  it('allows only one concurrent consumer of the same invite', async () => {
    const inviteCode = 'invite-concurrency-fixture';
    const hash = createHash('sha256').update(inviteCode).digest('hex');
    let consumed = false;
    const invitation = collectorRow({ inviteCodeHash: hash });
    const redis = {
      consumeOneTime: jest.fn(async () => {
        if (consumed) return null;
        consumed = true;
        return collectorId;
      }),
      restoreOneTime: jest.fn().mockResolvedValue(undefined),
      deleteOneTime: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;
    const tx = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: userId,
            zaloId: 'zalo-concurrent',
            phone: null,
            name: 'Collector',
            role: Role.MERCHANT,
            deletedAt: null,
            merchant: null,
            collector: null,
            station: null,
          }),
        update: jest.fn(),
      },
      collector: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      collector: { findUnique: jest.fn().mockResolvedValue(invitation) },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: userId,
            zaloId: 'zalo-concurrent',
            phone: null,
            name: 'Collector',
            role: Role.COLLECTOR,
            deletedAt: null,
            merchant: null,
            collector: { id: collectorId },
            station: null,
          }),
      },
      $transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const jwt = { signAsync: jest.fn().mockResolvedValue('jwt-concurrent-fixture') };
    const auth = new AuthService(
      prisma,
      jwt as never,
      { getOrThrow: jest.fn().mockReturnValue('jwt-secret') } as never,
      {} as never,
      {} as never,
      redis,
    );
    const results = await Promise.allSettled([
      auth.acceptCollectorInvite({ sub: userId, role: Role.MERCHANT }, inviteCode),
      auth.acceptCollectorInvite({ sub: userId, role: Role.MERCHANT }, inviteCode),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects an expired invite without linking by phone or restoring an expired key', async () => {
    const inviteCode = 'expired-collector-invite-fixture';
    const hash = createHash('sha256').update(inviteCode).digest('hex');
    const redis = {
      consumeOneTime: jest.fn().mockResolvedValue(collectorId),
      restoreOneTime: jest.fn().mockResolvedValue(undefined),
      deleteOneTime: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;
    const prisma = {
      collector: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            collectorRow({ inviteCodeHash: hash, inviteExpiresAt: new Date(Date.now() - 1000) }),
          ),
      },
    } as unknown as PrismaService;
    const auth = new AuthService(prisma, {} as never, {} as never, {} as never, {} as never, redis);

    await expect(
      auth.acceptCollectorInvite({ sub: userId, role: Role.MERCHANT }, inviteCode),
    ).rejects.toMatchObject({ response: { code: 'COLLECTOR_INVITE_INVALID' } });
    expect(redis.restoreOneTime).not.toHaveBeenCalled();
  });

  it('rejects a previously consumed invite', async () => {
    const redis = { consumeOneTime: jest.fn().mockResolvedValue(null) } as unknown as RedisService;
    const auth = new AuthService(
      {} as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      redis,
    );

    await expect(
      auth.acceptCollectorInvite({ sub: userId, role: Role.MERCHANT }, 'already-consumed-fixture'),
    ).rejects.toMatchObject({ response: { code: 'COLLECTOR_INVITE_INVALID' } });
  });
});
