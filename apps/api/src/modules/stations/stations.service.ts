import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DeliveryStatus, EntityStatus, Role } from '@prisma/client';
import type {
  EntityStatusInput,
  PersonListQueryInput,
  StationCreateInput,
  StationPatchInput,
  StationRecommendInput,
} from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildStationFillAlertCandidate,
  type StationFillAlertCandidate,
} from './station-fill-alert';
import { forecastStationFill, type StationFillForecastResult } from './station-fill-forecast';

const FORECAST_HISTORY_DAYS = 7;

@Injectable()
export class StationsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: StationCreateInput) {
    await this.requireWard(input.ward_id);
    const row = await this.prisma.$transaction(async (transaction) => {
      const stationUser = await transaction.user.create({
        data: { name: input.name, role: Role.STATION },
      });
      return transaction.station.create({
        data: {
          userId: stationUser.id,
          wardId: input.ward_id,
          name: input.name,
          address: input.address,
          capacityLiters: input.capacity_liters,
          status: input.status,
          isActive: input.status === EntityStatus.ACTIVE,
          deletedAt: input.status === EntityStatus.INACTIVE ? new Date() : null,
        },
        include: { user: true, ward: true },
      });
    });
    await this.prisma.setGeographyPoint('stations', row.id, input.lat, input.lng);
    return this.findOne(row.id);
  }

  async update(id: string, input: StationPatchInput) {
    const existing = await this.getRequired(id);
    if (input.ward_id) {
      await this.requireWard(input.ward_id);
    }
    if (
      input.capacity_liters !== undefined &&
      input.capacity_liters < Number(existing.currentVolumeLiters)
    ) {
      throw new BadRequestException({
        code: 'STATION_CAPACITY_BELOW_CURRENT_VOLUME',
        message: 'Dung tích không được nhỏ hơn lượng dầu hiện có',
        details: null,
      });
    }
    const row = await this.prisma.station.update({
      where: { id },
      data: {
        ...(input.ward_id ? { wardId: input.ward_id } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.address ? { address: input.address } : {}),
        ...(input.capacity_liters !== undefined ? { capacityLiters: input.capacity_liters } : {}),
        ...(input.status
          ? {
              status: input.status,
              isActive: input.status === EntityStatus.ACTIVE,
              deletedAt: input.status === EntityStatus.INACTIVE ? new Date() : null,
            }
          : {}),
      },
    });
    if (input.lat !== undefined && input.lng !== undefined) {
      await this.prisma.setGeographyPoint('stations', id, input.lat, input.lng);
    }
    return this.findOne(row.id);
  }

  async updateStatus(id: string, input: EntityStatusInput) {
    await this.getRequired(id);
    await this.prisma.station.update({
      where: { id },
      data: {
        status: input.status,
        isActive: input.status === EntityStatus.ACTIVE,
        deletedAt: input.status === EntityStatus.INACTIVE ? new Date() : null,
      },
    });
    return this.findOne(id);
  }

  async list(query: PersonListQueryInput) {
    const where: Prisma.StationWhereInput = {
      ...(query.ward_id ? { wardId: query.ward_id } : {}),
      ...(query.status
        ? { status: query.status }
        : query.include_inactive
          ? {}
          : { status: EntityStatus.ACTIVE }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.station.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { user: true, ward: true },
      }),
      this.prisma.station.count({ where }),
    ]);
    const stationIds = rows.map((row) => row.id);
    const [points, dailyIncomingByStation, oldestStoredByStation] = await Promise.all([
      this.prisma.getGeographyPoints('stations', stationIds),
      this.dailyIncomingByStation(stationIds),
      this.oldestStoredByStation(stationIds),
    ]);
    const pointMap = new Map(points.map((point) => [point.id, point]));
    return {
      data: rows.map((row) =>
        this.serialize(
          row,
          pointMap.get(row.id),
          dailyIncomingByStation.get(row.id) ?? [],
          oldestStoredByStation.get(row.id),
        ),
      ),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async recommend(query: StationRecommendInput) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        address: string | null;
        capacity_l: number;
        current_volume_l: number;
        remaining_capacity_l: number;
        distance_m: number;
        lat: number;
        lng: number;
      }>
    >`
      SELECT s."id", s."name", s."address",
        s."capacity_l"::float8 AS "capacity_l",
        s."current_volume_l"::float8 AS "current_volume_l",
        (s."capacity_l" - s."current_volume_l")::float8 AS "remaining_capacity_l",
        ST_Distance(
          s."location",
          ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)::geography
        )::float8 AS "distance_m",
        ST_Y(s."location"::geometry)::float8 AS "lat",
        ST_X(s."location"::geometry)::float8 AS "lng"
      FROM "stations" s
      WHERE s."status" = 'ACTIVE'
        AND s."deleted_at" IS NULL
        AND s."location" IS NOT NULL
        AND s."capacity_l" - s."current_volume_l" >= ${query.liters}
      ORDER BY "distance_m" ASC, s."id" ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      lat: row.lat,
      lng: row.lng,
      capacity_l: Number(row.capacity_l),
      current_volume_l: Number(row.current_volume_l),
      remaining_capacity_l: Number(row.remaining_capacity_l),
      distance_m: Number(row.distance_m),
    }));
  }

  async findOne(id: string) {
    const row = await this.getRequired(id);
    const [point, dailyIncomingByStation, oldestStoredByStation] = await Promise.all([
      this.prisma.getGeographyPoint('stations', id),
      this.dailyIncomingByStation([id]),
      this.oldestStoredByStation([id]),
    ]);
    return this.serialize(
      row,
      point ?? undefined,
      dailyIncomingByStation.get(id) ?? [],
      oldestStoredByStation.get(id),
    );
  }

  async listFillAlertCandidates(now = new Date()): Promise<StationFillAlertCandidate[]> {
    const stations = await this.prisma.station.findMany({
      where: { status: EntityStatus.ACTIVE, isActive: true, deletedAt: null },
      select: { id: true, name: true, capacityLiters: true, currentVolumeLiters: true },
      orderBy: { createdAt: 'asc' },
    });
    const stationIds = stations.map((station) => station.id);
    const [dailyIncomingByStation, oldestStoredByStation] = await Promise.all([
      this.dailyIncomingByStation(stationIds, now),
      this.oldestStoredByStation(stationIds),
    ]);

    return stations.flatMap((station) => {
      const forecast = forecastStationFill({
        capacityLiters: Number(station.capacityLiters),
        currentVolumeLiters: Number(station.currentVolumeLiters),
        dailyIncomingLiters: dailyIncomingByStation.get(station.id) ?? [],
        oldestStoredAt: oldestStoredByStation.get(station.id),
        now,
        maxStorageDays: this.maxStorageDays(),
      });
      const candidate = buildStationFillAlertCandidate(station, forecast);
      return candidate ? [candidate] : [];
    });
  }

  private async dailyIncomingByStation(
    stationIds: string[],
    now = new Date(),
  ): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    if (stationIds.length === 0) return result;

    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const historyStart = new Date(today);
    historyStart.setUTCDate(historyStart.getUTCDate() - (FORECAST_HISTORY_DAYS - 1));
    const completedStatuses = [DeliveryStatus.OK, DeliveryStatus.FLAGGED];
    const deliveries = await this.prisma.stationDelivery.findMany({
      where: {
        stationId: { in: stationIds },
        status: { in: completedStatuses },
        deletedAt: null,
        deliveredAt: { gte: historyStart, lte: now },
      },
      select: {
        stationId: true,
        actualLiters: true,
        deliveredAt: true,
        status: true,
        deletedAt: true,
      },
      orderBy: [{ stationId: 'asc' }, { deliveredAt: 'asc' }],
    });
    const completedStatusSet = new Set<DeliveryStatus>(completedStatuses);
    const totalsByStation = new Map<string, Map<string, number>>();
    for (const delivery of deliveries) {
      const deliveredAt = delivery.deliveredAt.getTime();
      const actualLiters = Number(delivery.actualLiters);
      if (
        delivery.deletedAt !== null ||
        !completedStatusSet.has(delivery.status) ||
        !Number.isFinite(deliveredAt) ||
        deliveredAt < historyStart.getTime() ||
        deliveredAt > now.getTime() ||
        !Number.isFinite(actualLiters) ||
        actualLiters < 0
      ) {
        continue;
      }
      const day = delivery.deliveredAt.toISOString().slice(0, 10);
      const stationTotals = totalsByStation.get(delivery.stationId) ?? new Map<string, number>();
      stationTotals.set(day, (stationTotals.get(day) ?? 0) + actualLiters);
      totalsByStation.set(delivery.stationId, stationTotals);
    }

    const todayTimestamp = today.getTime();
    for (const [stationId, dailyTotals] of totalsByStation) {
      const firstDay = [...dailyTotals.keys()].sort()[0];
      if (!firstDay) continue;
      const dailyIncoming: number[] = [];
      for (
        let cursor = new Date(`${firstDay}T00:00:00.000Z`);
        cursor.getTime() <= todayTimestamp;
        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1_000)
      ) {
        dailyIncoming.push(dailyTotals.get(cursor.toISOString().slice(0, 10)) ?? 0);
      }
      result.set(stationId, dailyIncoming.slice(-FORECAST_HISTORY_DAYS));
    }
    return result;
  }

  private async oldestStoredByStation(stationIds: string[]): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (stationIds.length === 0) return result;
    const deliveries = await this.prisma.stationDelivery.findMany({
      where: {
        stationId: { in: stationIds },
        processedAt: null,
        deletedAt: null,
        status: { in: [DeliveryStatus.OK, DeliveryStatus.FLAGGED] },
      },
      select: { stationId: true, deliveredAt: true },
      orderBy: [{ stationId: 'asc' }, { deliveredAt: 'asc' }],
    });
    for (const delivery of deliveries) {
      if (!result.has(delivery.stationId)) result.set(delivery.stationId, delivery.deliveredAt);
    }
    return result;
  }

  private maxStorageDays(): number {
    const configured = Number(process.env.STATION_MAX_STORAGE_DAYS ?? 14);
    return Number.isFinite(configured) && configured > 0 ? configured : 14;
  }

  private async requireWard(id: string): Promise<void> {
    const ward = await this.prisma.ward.findUnique({ where: { id } });
    if (!ward || ward.deletedAt) {
      throw new NotFoundException('Ward not found');
    }
  }

  private async getRequired(id: string) {
    const row = await this.prisma.station.findUnique({
      where: { id },
      include: { user: true, ward: true },
    });
    if (!row) {
      throw new NotFoundException('Station not found');
    }
    return row;
  }

  private serialize(
    row: Awaited<ReturnType<StationsService['getRequired']>>,
    point?: { lat: number; lng: number },
    dailyIncomingLiters: number[] = [],
    oldestStoredAt?: Date,
  ) {
    const fillForecast = forecastStationFill({
      capacityLiters: Number(row.capacityLiters),
      currentVolumeLiters: Number(row.currentVolumeLiters),
      dailyIncomingLiters,
      oldestStoredAt,
      maxStorageDays: this.maxStorageDays(),
    });
    return {
      id: row.id,
      user_id: row.userId,
      ward_id: row.wardId,
      name: row.name,
      address: row.address,
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      capacity_l: Number(row.capacityLiters),
      current_volume_l: Number(row.currentVolumeLiters),
      status: row.status,
      is_active: row.isActive,
      ward: { id: row.ward.id, code: row.ward.code, name: row.ward.name },
      user: { id: row.user.id, name: row.user.name, phone: row.user.phone },
      fill_forecast: this.serializeFillForecast(fillForecast),
    };
  }

  private serializeFillForecast(forecast: StationFillForecastResult) {
    return {
      average_daily_incoming_liters: forecast.averageDailyIncomingLiters,
      remaining_capacity_liters: forecast.remainingCapacityLiters,
      estimated_days_until_full: forecast.estimatedDaysUntilFull,
      projected_volumes: forecast.projectedVolumes.map((projection) => ({
        day: projection.day,
        volume_liters: projection.volumeLiters,
      })),
      status: forecast.status,
      history_size: forecast.historySize,
      reason_codes: forecast.reasonCodes,
      storage_age_days: forecast.storageAgeDays,
      days_until_storage_limit: forecast.daysUntilStorageLimit,
      max_storage_days: forecast.maxStorageDays,
      storage_age_status: forecast.storageAgeStatus,
      effective_handling_days: forecast.effectiveHandlingDays,
      explanation: {
        summary: forecast.explanation.summary,
        used_daily_incoming_liters: forecast.explanation.usedDailyIncomingLiters,
        calculation_window_days: forecast.explanation.calculationWindowDays,
        formula: forecast.explanation.formula,
      },
    };
  }
}
