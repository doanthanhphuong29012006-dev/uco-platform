import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertSeverity, AlertType, ContainerState, DeliveryStatus, EntityStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { StationDeliveryCreateInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
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
        collector_id: string;
        station_delivery_id: string | null;
        container_id: string;
      }>>`
        SELECT "id", "actual_liters"::float8 AS "actual_liters", "collector_id", "station_delivery_id", "container_id"
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

      const expectedLiters = transactions.reduce((sum, transaction) => sum + Number(transaction.actual_liters), 0);
      const varianceLiters = input.actual_liters - expectedLiters;
      const variancePct = expectedLiters === 0 ? 0 : varianceLiters / expectedLiters;
      const threshold = this.config.get<number>('DELIVERY_VARIANCE_THRESHOLD_PCT', 0.02);
      const status = Math.abs(variancePct) > threshold ? DeliveryStatus.FLAGGED : DeliveryStatus.OK;
      const deliveredAt = input.delivered_at ?? new Date();

      const inserted = await tx.$queryRaw<Array<DeliveryRow>>`
        WITH inserted AS (
          INSERT INTO "station_deliveries" (
            "id", "client_uuid", "station_id", "collector_id", "expected_liters", "actual_liters",
            "variance_liters", "variance_pct", "status", "delivered_at", "created_at"
            , "note", "photos"
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
            ${JSON.stringify(input.photos ?? [])}::jsonb
          )
          ON CONFLICT ("client_uuid") DO NOTHING
          RETURNING *
        )
        SELECT inserted."id", inserted."client_uuid", inserted."station_id", inserted."collector_id",
          inserted."expected_liters"::float8 AS "expected_liters", inserted."actual_liters"::float8 AS "actual_liters",
        inserted."variance_liters"::float8 AS "variance_liters", inserted."variance_pct"::float8 AS "variance_pct",
          inserted."status"::text AS "status", inserted."note", inserted."photos", inserted."delivered_at", inserted."created_at",
          ARRAY[]::uuid[] AS "transaction_ids"
        FROM inserted
      `;

      if (inserted.length === 0) {
        const replay = await this.loadByClientUuid(tx, input.client_uuid);
        if (!replay) {
          throw new ConflictException('Idempotent station delivery could not be loaded');
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
            details: { variance_pct: variancePct, threshold_pct: threshold },
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

  private async loadByClientUuid(tx: Prisma.TransactionClient, clientUuid: string) {
    const rows = await tx.$queryRaw<DeliveryRow[]>`
      SELECT sd."id", sd."client_uuid", sd."station_id", sd."collector_id",
        sd."expected_liters"::float8 AS "expected_liters", sd."actual_liters"::float8 AS "actual_liters",
        sd."variance_liters"::float8 AS "variance_liters", sd."variance_pct"::float8 AS "variance_pct",
        sd."status"::text AS "status", sd."note", sd."photos", sd."delivered_at", sd."created_at",
        COALESCE(array_agg(ct."id") FILTER (WHERE ct."id" IS NOT NULL), ARRAY[]::uuid[]) AS "transaction_ids"
      FROM "station_deliveries" sd
      LEFT JOIN "collection_transactions" ct ON ct."station_delivery_id" = sd."id"
      WHERE sd."client_uuid" = ${clientUuid}
      GROUP BY sd."id"
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async loadById(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<DeliveryRow[]>`
      SELECT sd."id", sd."client_uuid", sd."station_id", sd."collector_id",
        sd."expected_liters"::float8 AS "expected_liters", sd."actual_liters"::float8 AS "actual_liters",
        sd."variance_liters"::float8 AS "variance_liters", sd."variance_pct"::float8 AS "variance_pct",
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
