import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertSeverity, AlertType, ContainerState, DeliveryStatus, EntityStatus, MassSource } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { StationDeliveryCreateInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import { getDensityKgPerLiter } from '../../config/mass.constants';
import type { AccessTokenPayload } from '../auth/auth.types';

type DeliveryRow = {
  id: string;
  client_uuid: string;
  station_id: string;
  collector_id: string;
  expected_liters: number;
  actual_liters: number;
  variance_liters: number;
  variance_pct: number;
  expected_kg: number | null;
  actual_kg: number | null;
  variance_kg: number | null;
  mass_source: MassSource;
  has_estimated_mass: boolean;
  status: DeliveryStatus;
  note: string | null;
  photos: unknown;
  delivered_at: Date;
  created_at: Date;
  transaction_ids: string[];
};

@Injectable()
export class StationDeliveriesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async create(user: AccessTokenPayload, input: StationDeliveryCreateInput): Promise<{ data: ReturnType<StationDeliveriesService['serialize']>; replayed: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const collector = await tx.collector.findUnique({ where: { userId: user.sub } });
      if (!collector || collector.status === EntityStatus.INACTIVE) {
        throw new NotFoundException('Collector profile not found');
      }
      const existingDelivery = await this.loadByClientUuid(tx, input.client_uuid, collector.id);
      if (existingDelivery) {
        return { row: existingDelivery, replayed: true };
      }

      const stationRows = await tx.$queryRaw<Array<{ id: string; capacity_l: number; current_volume_l: number }>>`
        SELECT "id", "capacity_l"::float8 AS "capacity_l", "current_volume_l"::float8 AS "current_volume_l"
        FROM "stations"
        WHERE "id" = ${input.station_id}::uuid AND "status" = 'ACTIVE' AND "deleted_at" IS NULL
        FOR UPDATE
      `;
      const station = stationRows[0];
      if (!station) {
        throw new NotFoundException('Station not found');
      }

      const transactionIds = input.transaction_ids.map((id) => Prisma.sql`${id}::uuid`);
      const transactions = await tx.$queryRaw<Array<{
        id: string;
        actual_liters: number;
        actual_kg: number | null;
        mass_source: MassSource;
        collector_id: string;
        station_delivery_id: string | null;
        container_id: string;
        synced_at: Date | null;
      }>>`
        SELECT "id", "actual_liters"::float8 AS "actual_liters", "actual_kg"::float8 AS "actual_kg", "mass_source"::text AS "mass_source", "collector_id", "station_delivery_id", "container_id", "synced_at"
        FROM "collection_transactions"
        WHERE "id" IN (${Prisma.join(transactionIds)}) AND "deleted_at" IS NULL
        FOR UPDATE
      `;
      if (transactions.length !== input.transaction_ids.length) {
        throw new ConflictException({ code: 'TRANSACTION_NOT_FOUND', message: 'One or more collection transactions were not found', details: null });
      }
      if (transactions.some((transaction) => transaction.collector_id !== collector.id)) {
        throw new ForbiddenException('Collection transaction ownership required');
      }
      const unsynced = transactions.filter((transaction) => transaction.synced_at === null);
      if (unsynced.length > 0) {
        throw new ConflictException({
          code: 'TRANSACTION_NOT_SYNCED',
          message: 'Giao dịch chưa được đồng bộ lên máy chủ',
          details: { transaction_ids: unsynced.map((transaction) => transaction.id) },
        });
      }

      const expectedLiters = transactions.reduce((sum, transaction) => sum + Number(transaction.actual_liters), 0);
      const expectedKg = transactions.reduce((sum, transaction) => sum + Number(transaction.actual_kg ?? 0), 0);
      const expectedMassEstimated = transactions.some((transaction) => transaction.mass_source !== MassSource.SCALE);
      const densityFactor = getDensityKgPerLiter(this.config);
      const massSource = input.actual_kg === undefined ? MassSource.ESTIMATED_FROM_VOLUME : MassSource.SCALE;
      const actualKg = input.actual_kg ?? input.actual_liters * densityFactor;
      const hasEstimatedMass = expectedMassEstimated || massSource === MassSource.ESTIMATED_FROM_VOLUME;
      const varianceLiters = input.actual_liters - expectedLiters;
      const variancePct = expectedLiters === 0 ? 0 : varianceLiters / expectedLiters;
      const varianceKg = actualKg - expectedKg;
      const varianceKgPct = expectedKg === 0 ? 0 : varianceKg / expectedKg;
      const threshold = this.config.get<number>('DELIVERY_VARIANCE_THRESHOLD_PCT', 0.02);
      const status = Math.abs(varianceKgPct) - threshold > 1e-9 ? DeliveryStatus.FLAGGED : DeliveryStatus.OK;
      const deliveredAt = input.delivered_at ?? new Date();

      const inserted = await tx.$queryRaw<Array<DeliveryRow>>`
        WITH inserted AS (
          INSERT INTO "station_deliveries" (
            "id", "client_uuid", "station_id", "collector_id", "expected_liters", "actual_liters",
            "variance_liters", "variance_pct", "status", "delivered_at", "created_at"
            , "note", "photos", "expected_kg", "actual_kg", "variance_kg", "mass_source", "has_estimated_mass"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${input.client_uuid},
            ${input.station_id}::uuid,
            ${collector.id}::uuid,
            ${expectedLiters},
            ${input.actual_liters},
            ${varianceLiters},
            ${variancePct},
            ${status}::"DeliveryStatus",
            ${deliveredAt},
            now(),
            ${input.note ?? null},
            ${JSON.stringify(input.photos ?? [])}::jsonb,
            ${expectedKg},
            ${actualKg},
            ${varianceKg},
            ${massSource}::"MassSource",
            ${hasEstimatedMass}
          )
          ON CONFLICT ("client_uuid") DO NOTHING
          RETURNING *
        )
        SELECT inserted."id", inserted."client_uuid", inserted."station_id", inserted."collector_id",
          inserted."expected_liters"::float8 AS "expected_liters", inserted."actual_liters"::float8 AS "actual_liters",
          inserted."expected_kg"::float8 AS "expected_kg", inserted."actual_kg"::float8 AS "actual_kg", inserted."variance_kg"::float8 AS "variance_kg",
          inserted."mass_source"::text AS "mass_source", inserted."has_estimated_mass",
        inserted."variance_liters"::float8 AS "variance_liters", inserted."variance_pct"::float8 AS "variance_pct",
          inserted."status"::text AS "status", inserted."note", inserted."photos", inserted."delivered_at", inserted."created_at",
          ARRAY[]::uuid[] AS "transaction_ids"
        FROM inserted
      `;

      if (inserted.length === 0) {
        const replay = await this.loadByClientUuid(tx, input.client_uuid, collector.id);
        if (!replay) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: 'Mã idempotency đã được sử dụng cho phiếu khác',
            details: null,
          });
        }
        return { row: replay, replayed: true };
      }

      const alreadyDelivered = transactions.filter((transaction) => transaction.station_delivery_id !== null);
      if (alreadyDelivered.length > 0) {
        throw new ConflictException({
          code: 'TRANSACTION_ALREADY_DELIVERED',
          message: 'One or more collection transactions already belong to another delivery',
          details: { transaction_ids: alreadyDelivered.map((transaction) => transaction.id) },
        });
      }
      if (station.current_volume_l + input.actual_liters > station.capacity_l) {
        throw new UnprocessableEntityException({
          code: 'STATION_OVER_CAPACITY',
          message: 'Station does not have enough remaining capacity',
          details: { capacity_l: station.capacity_l, current_volume_l: station.current_volume_l, incoming_l: input.actual_liters },
        });
      }

      const delivery = inserted[0];
      await tx.collectionTransaction.updateMany({
        where: { id: { in: input.transaction_ids } },
        data: { stationDeliveryId: delivery.id },
      });
      await tx.container.updateMany({
        where: { id: { in: transactions.map((transaction) => transaction.container_id) } },
        data: { state: ContainerState.AT_STATION, lastSeenAt: new Date() },
      });
      await tx.station.update({
        where: { id: input.station_id },
        data: { currentVolumeLiters: station.current_volume_l + input.actual_liters },
      });
      if (status === DeliveryStatus.FLAGGED) {
        await tx.alert.create({
          data: {
            stationDeliveryId: delivery.id,
            type: AlertType.DELIVERY_VARIANCE,
            severity: AlertSeverity.HIGH,
            message: 'Station delivery variance exceeded configured threshold',
            details: { variance_pct: variancePct, variance_kg_pct: varianceKgPct, threshold_pct: threshold, expected_kg: expectedKg, actual_kg: actualKg, has_estimated_mass: hasEstimatedMass },
          },
        });
      }
      return { row: await this.loadById(tx, delivery.id), replayed: false };
    });

    if (!result.row) {
      throw new ConflictException('Station delivery could not be loaded');
    }
    return { data: this.serialize(result.row), replayed: result.replayed };
  }

  private async loadByClientUuid(tx: Prisma.TransactionClient, clientUuid: string, collectorId: string) {
    const rows = await tx.$queryRaw<DeliveryRow[]>`
      SELECT sd."id", sd."client_uuid", sd."station_id", sd."collector_id",
        sd."expected_liters"::float8 AS "expected_liters", sd."actual_liters"::float8 AS "actual_liters",
        sd."expected_kg"::float8 AS "expected_kg", sd."actual_kg"::float8 AS "actual_kg", sd."variance_kg"::float8 AS "variance_kg",
        sd."mass_source"::text AS "mass_source", sd."has_estimated_mass", sd."variance_liters"::float8 AS "variance_liters", sd."variance_pct"::float8 AS "variance_pct",
        sd."status"::text AS "status", sd."note", sd."photos", sd."delivered_at", sd."created_at",
        COALESCE(array_agg(ct."id") FILTER (WHERE ct."id" IS NOT NULL), ARRAY[]::uuid[]) AS "transaction_ids"
      FROM "station_deliveries" sd
      LEFT JOIN "collection_transactions" ct ON ct."station_delivery_id" = sd."id"
      WHERE sd."client_uuid" = ${clientUuid} AND sd."collector_id" = ${collectorId}::uuid
      GROUP BY sd."id"
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async loadById(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<DeliveryRow[]>`
      SELECT sd."id", sd."client_uuid", sd."station_id", sd."collector_id",
        sd."expected_liters"::float8 AS "expected_liters", sd."actual_liters"::float8 AS "actual_liters",
        sd."expected_kg"::float8 AS "expected_kg", sd."actual_kg"::float8 AS "actual_kg", sd."variance_kg"::float8 AS "variance_kg",
        sd."mass_source"::text AS "mass_source", sd."has_estimated_mass", sd."variance_liters"::float8 AS "variance_liters", sd."variance_pct"::float8 AS "variance_pct",
        sd."status"::text AS "status", sd."note", sd."photos", sd."delivered_at", sd."created_at",
        COALESCE(array_agg(ct."id") FILTER (WHERE ct."id" IS NOT NULL), ARRAY[]::uuid[]) AS "transaction_ids"
      FROM "station_deliveries" sd
      LEFT JOIN "collection_transactions" ct ON ct."station_delivery_id" = sd."id"
      WHERE sd."id" = ${id}::uuid
      GROUP BY sd."id"
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private serialize(row: DeliveryRow) {
    return {
      id: row.id,
      client_uuid: row.client_uuid,
      station_id: row.station_id,
      collector_id: row.collector_id,
      transaction_ids: row.transaction_ids,
      expected_liters: Number(row.expected_liters),
      actual_liters: Number(row.actual_liters),
      expected_kg: row.expected_kg === null ? null : Number(row.expected_kg),
      actual_kg: row.actual_kg === null ? null : Number(row.actual_kg),
      variance_kg: row.variance_kg === null ? null : Number(row.variance_kg),
      mass_source: row.mass_source,
      has_estimated_mass: row.has_estimated_mass,
      variance_l: Number(row.variance_liters),
      variance_pct: Number(row.variance_pct),
      status: row.status,
      note: row.note,
      photos: row.photos,
      delivered_at: row.delivered_at,
      created_at: row.created_at,
    };
  }
}
