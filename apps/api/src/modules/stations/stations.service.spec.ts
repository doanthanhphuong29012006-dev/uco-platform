import { DeliveryStatus, EntityStatus, Role } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { StationsService } from './stations.service';
import { EntityStatus as SharedEntityStatus } from '@eco-oil/shared-types';

const now = new Date('2026-08-20T12:00:00.000Z');

function station(id: string, currentVolumeLiters = 40) {
  return {
    id,
    userId: `user-${id}`,
    wardId: 'ward-1',
    name: `Trạm ${id}`,
    address: 'Địa chỉ trạm',
    capacityLiters: 100,
    currentVolumeLiters,
    status: EntityStatus.ACTIVE,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ward: { id: 'ward-1', code: 'Q3P7', name: 'Phường 7' },
    user: { id: `user-${id}`, name: `User ${id}`, phone: '0900000000', role: Role.STATION },
  };
}

function delivery(
  stationId: string,
  actualLiters: number,
  deliveredAt: string,
  options: { status?: DeliveryStatus; deletedAt?: Date | null } = {},
) {
  return {
    stationId,
    actualLiters,
    deliveredAt: new Date(deliveredAt),
    status: options.status ?? DeliveryStatus.OK,
    deletedAt: options.deletedAt ?? null,
  };
}

function createService(
  stations: ReturnType<typeof station>[],
  deliveries: ReturnType<typeof delivery>[],
) {
  const stationDeliveryFindMany = jest.fn().mockResolvedValue(deliveries);
  const prisma = {
    station: {
      findMany: jest.fn().mockResolvedValue(stations),
      count: jest.fn().mockResolvedValue(stations.length),
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(stations.find((item) => item.id === where.id) ?? null),
        ),
    },
    stationDelivery: { findMany: stationDeliveryFindMany },
    getGeographyPoints: jest
      .fn()
      .mockResolvedValue(stations.map((item) => ({ id: item.id, lat: 10.7, lng: 106.7 }))),
    getGeographyPoint: jest
      .fn()
      .mockImplementation((_table: string, id: string) =>
        Promise.resolve(
          stations.some((item) => item.id === id) ? { id, lat: 10.7, lng: 106.7 } : null,
        ),
      ),
  } as unknown as PrismaService;
  return { service: new StationsService(prisma), stationDeliveryFindMany };
}

describe('StationsService fill forecast integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('preserves existing list fields and returns insufficient forecast without history', async () => {
    const firstStation = station('station-1');
    const { service } = createService([firstStation], []);

    const result = await service.list({ page: 1, limit: 20, include_inactive: false });

    expect(result.data[0]).toMatchObject({
      id: firstStation.id,
      user_id: firstStation.userId,
      ward_id: firstStation.wardId,
      name: firstStation.name,
      address: firstStation.address,
      lat: 10.7,
      lng: 106.7,
      capacity_l: 100,
      current_volume_l: 40,
      status: EntityStatus.ACTIVE,
      is_active: true,
      ward: firstStation.ward,
    });
    expect(result.data[0].fill_forecast).toMatchObject({
      average_daily_incoming_liters: 0,
      remaining_capacity_liters: 60,
      estimated_days_until_full: null,
      status: 'INSUFFICIENT_DATA',
      history_size: 0,
    });
  });

  it('adds the forecast to station detail and aggregates completed deliveries by UTC day', async () => {
    const firstStation = station('station-1');
    const { service } = createService(
      [firstStation],
      [
        delivery(firstStation.id, 4, '2026-08-17T01:00:00.000Z'),
        delivery(firstStation.id, 6, '2026-08-17T23:30:00.000Z'),
        delivery(firstStation.id, 20, '2026-08-19T08:00:00.000Z', {
          status: DeliveryStatus.FLAGGED,
        }),
        delivery(firstStation.id, 30, '2026-08-20T09:00:00.000Z'),
      ],
    );

    const result = await service.findOne(firstStation.id);

    expect(result.id).toBe(firstStation.id);
    expect(result.fill_forecast).toMatchObject({
      average_daily_incoming_liters: 15,
      remaining_capacity_liters: 60,
      estimated_days_until_full: 4,
      status: 'WATCH',
      history_size: 4,
      explanation: { used_daily_incoming_liters: [10, 0, 20, 30], calculation_window_days: 4 },
    });
    expect(result.fill_forecast.projected_volumes).toHaveLength(7);
  });

  it('loads delivery history once for every station in the list', async () => {
    const stations = [station('station-1'), station('station-2')];
    const { service, stationDeliveryFindMany } = createService(stations, []);

    const result = await service.list({ page: 1, limit: 20, include_inactive: false });

    expect(result.data).toHaveLength(2);
    expect(result.data.every((item) => item.fill_forecast.status === 'INSUFFICIENT_DATA')).toBe(
      true,
    );
    expect(stationDeliveryFindMany).toHaveBeenCalledTimes(2);
    expect(stationDeliveryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stationId: { in: ['station-1', 'station-2'] } }),
      }),
    );
  });

  it('excludes future and soft-deleted deliveries from forecast history', async () => {
    const firstStation = station('station-1');
    const { service, stationDeliveryFindMany } = createService(
      [firstStation],
      [
        delivery(firstStation.id, 10, '2026-08-18T08:00:00.000Z'),
        delivery(firstStation.id, 10, '2026-08-19T08:00:00.000Z'),
        delivery(firstStation.id, 10, '2026-08-20T08:00:00.000Z'),
        delivery(firstStation.id, 500, '2026-08-21T08:00:00.000Z'),
        delivery(firstStation.id, 500, '2026-08-19T10:00:00.000Z', {
          deletedAt: new Date('2026-08-19T11:00:00.000Z'),
        }),
      ],
    );

    const result = await service.findOne(firstStation.id);

    expect(result.fill_forecast).toMatchObject({
      average_daily_incoming_liters: 10,
      history_size: 3,
      estimated_days_until_full: 6,
      status: 'WATCH',
    });
    expect(stationDeliveryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [DeliveryStatus.OK, DeliveryStatus.FLAGGED] },
          deletedAt: null,
          deliveredAt: { gte: new Date('2026-08-14T00:00:00.000Z'), lte: now },
        }),
      }),
    );
  });
});

describe('StationsService Admin CRUD', () => {
  it('creates the internal Station user automatically and saves capacity without a fake Zalo ID', async () => {
    const created = { ...station('station-created'), capacityLiters: 1_500 };
    const userCreate = jest.fn().mockResolvedValue({ id: created.userId });
    const stationCreate = jest.fn().mockResolvedValue(created);
    const prisma = {
      ward: { findUnique: jest.fn().mockResolvedValue({ id: created.wardId, deletedAt: null }) },
      $transaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({
          user: { create: userCreate },
          station: { create: stationCreate },
        }),
      ),
      station: { findUnique: jest.fn().mockResolvedValue(created) },
      stationDelivery: { findMany: jest.fn().mockResolvedValue([]) },
      setGeographyPoint: jest.fn().mockResolvedValue(undefined),
      getGeographyPoint: jest.fn().mockResolvedValue({ id: created.id, lat: 21.03, lng: 105.85 }),
    } as unknown as PrismaService;
    const service = new StationsService(prisma);

    const result = await service.create({
      name: 'Trạm ECollect mới',
      address: '1 Hàng Bạc, Hà Nội',
      ward_id: created.wardId,
      capacity_liters: 1_500,
      lat: 21.03,
      lng: 105.85,
      status: SharedEntityStatus.ACTIVE,
    });

    expect(userCreate).toHaveBeenCalledWith({
      data: { name: 'Trạm ECollect mới', role: Role.STATION },
    });
    expect(userCreate.mock.calls[0]![0].data).not.toHaveProperty('zaloId');
    expect(stationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ capacityLiters: 1_500, userId: created.userId }),
      }),
    );
    expect(result.capacity_l).toBe(1_500);
  });
});
