import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertType, ContainerState, EntityStatus, OrderStatus, Quality } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { CollectionCreateInput, CollectionListQueryInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccessTokenPayload } from '../auth/auth.types';

type InsertedTransaction = {
  id: string;
  client_uuid: string;
  order_id: string | null;
  container_id: string;
  merchant_id: string;
  collector_id: string;
  actual_liters: number;
  quality: Quality;
  photos: Prisma.JsonValue;
  collected_at: Date;
  created_at: Date;
  deleted_at: Date | null;
};

type CollectionRow = {
  id: string;
  client_uuid: string;
  order_id: string | null;
  container_id: string;
  merchant_id: string;
  collector_id: string;
  actual_liters: number;
  quality: Quality;
  photos: Prisma.JsonValue;
  collected_at: Date;
  created_at: Date;
  container_code: string;
  geo_lat: number | null;
  geo_lng: number | null;
};

@Injectable()
export class CollectionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async create(user: AccessTokenPayload, input: CollectionCreateInput) {
    return this.processOne(user, input, false);
  }

  async processOne(user: AccessTokenPayload, input: CollectionCreateInput, synced: boolean): Promise<{ data: ReturnType<CollectionsService['serialize']>; replayed: boolean }> {
    const result: { row: CollectionRow | null; replayed: boolean } = await this.prisma.$transaction(async (tx) => {
      const collector = await tx.collector.findUnique({
        where: { userId: user.sub },
        include: { collectorWards: { select: { wardId: true } } },
      });
      if (!collector || collector.status === EntityStatus.INACTIVE) {
        throw new NotFoundException('Collector profile not found');
      }

      const order = await tx.collectionOrder.findUnique({
        where: { id: input.order_id },
        include: { merchant: true, container: true },
      });
      if (!order) {
        throw new ConflictException({
          code: 'ORDER_ALREADY_COLLECTED',
          message: 'Order does not exist or has already been collected',
          details: null,
        });
      }
      const originalOrderStatus = order.status;
      if (!collector.collectorWards.some((item) => item.wardId === order.merchant.wardId)) {
        throw new ForbiddenException('Order is outside collector ward');
      }
      if (originalOrderStatus !== OrderStatus.READY && originalOrderStatus !== OrderStatus.ASSIGNED && originalOrderStatus !== OrderStatus.COLLECTED) {
        throw new ConflictException({ code: 'ORDER_NOT_READY', message: 'Order is not ready for collection', details: { order_id: order.id, status: order.status } });
      }
      if (!order.containerId || !order.container || order.container.qrCode !== input.container_code) {
        throw new ConflictException({ code: 'CONTAINER_MISMATCH', message: 'Container does not match order', details: { order_id: order.id } });
      }
      const capacity = Number(order.container.capacityLiters ?? 0);
      if (input.actual_liters <= 0 || input.actual_liters > capacity * 1.1) {
        throw new UnprocessableEntityException({
          code: 'INVALID_LITERS',
          message: 'actual_liters is outside the allowed container range',
          details: { capacity_l: capacity, max_liters: capacity * 1.1 },
        });
      }
      if (input.quality === Quality.FLAG && input.photos.length === 0) {
        throw new UnprocessableEntityException({
          code: 'PHOTO_REQUIRED_FOR_FLAG',
          message: 'At least one photo is required when quality is FLAG',
          details: null,
        });
      }

      const collectedAt = input.collected_at ?? new Date();
      const threshold = this.config.get<number>('GEO_MISMATCH_THRESHOLD_M', 500);
      const distanceRows = await tx.$queryRaw<Array<{ distanceM: number | null }>>`
        SELECT ST_Distance(
          "location",
          ST_SetSRID(ST_MakePoint(${input.geo.lng}, ${input.geo.lat}), 4326)::geography
        )::float8 AS "distanceM"
        FROM "merchants"
        WHERE "id" = ${order.merchantId}::uuid
      `;
      const distanceM = distanceRows[0]?.distanceM ?? null;
      const geoMismatch = distanceM !== null && distanceM > threshold;
      const effectiveQuality = geoMismatch ? Quality.FLAG : input.quality;

      const inserted = await tx.$queryRaw<Array<InsertedTransaction & { geo_lat: number; geo_lng: number }>>`
        WITH inserted AS (
          INSERT INTO "collection_transactions" (
            "id", "client_uuid", "order_id", "container_id", "merchant_id", "collector_id",
            "actual_liters", "quality", "geo_point", "photos", "collected_at", "created_at"
            , "synced_at"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${input.client_uuid},
            ${input.order_id}::uuid,
            ${order.containerId}::uuid,
            ${order.merchantId}::uuid,
            ${collector.id}::uuid,
            ${input.actual_liters},
            ${effectiveQuality}::"Quality",
            ST_SetSRID(ST_MakePoint(${input.geo.lng}, ${input.geo.lat}), 4326)::geography,
            ${JSON.stringify(input.photos)}::jsonb,
            ${collectedAt},
            now(),
            ${synced ? new Date() : null}
          )
          ON CONFLICT ("client_uuid") DO NOTHING
          RETURNING *
        )
        SELECT inserted."id", inserted."client_uuid", inserted."order_id", inserted."container_id",
          inserted."merchant_id", inserted."collector_id", inserted."actual_liters"::float8 AS "actual_liters",
          inserted."quality"::text AS "quality", inserted."photos", inserted."collected_at", inserted."created_at",
          inserted."deleted_at", ST_Y(inserted."geo_point"::geometry)::float8 AS "geo_lat",
          ST_X(inserted."geo_point"::geometry)::float8 AS "geo_lng"
        FROM inserted
      `;

      if (inserted.length === 0) {
        const replay = await this.loadByClientUuid(tx, input.client_uuid);
        if (!replay) {
          throw new ConflictException('Idempotent transaction could not be loaded');
        }
        if (synced) {
          await tx.collectionTransaction.update({ where: { id: replay.id }, data: { syncedAt: new Date() } });
        }
        return { row: replay, replayed: true };
      }

      if (originalOrderStatus === OrderStatus.COLLECTED) {
        throw new ConflictException({
          code: 'ORDER_ALREADY_COLLECTED',
          message: 'Order does not exist or has already been collected',
          details: { order_id: order.id, status: order.status },
        });
      }

      const transaction = inserted[0];
      await tx.collectionOrder.update({
        where: { id: order.id },
        data: { status: OrderStatus.COLLECTED, completedAt: collectedAt },
      });
      await tx.container.update({
        where: { id: order.containerId },
        data: { state: ContainerState.IN_TRANSIT, lastSeenAt: new Date() },
      });

      const averageRows = await tx.$queryRaw<Array<{ averageLiters: number | null }>>`
        SELECT AVG("actual_liters")::float8 AS "averageLiters"
        FROM "collection_transactions"
        WHERE "merchant_id" = ${order.merchantId}::uuid
          AND "deleted_at" IS NULL
          AND "collected_at" >= ${new Date(collectedAt.getTime() - 14 * 24 * 60 * 60 * 1000)}
      `;
      await tx.merchant.update({
        where: { id: order.merchantId },
        data: {
          lastCollectedAt: collectedAt,
          avgDailyLiters: averageRows[0]?.averageLiters ?? input.actual_liters,
        },
      });

      if (geoMismatch) {
        await tx.alert.create({
          data: {
            transactionId: transaction.id,
            type: AlertType.GEO_MISMATCH,
            message: 'Collection geo point is outside merchant mismatch threshold',
            details: { distance_m: distanceM, threshold_m: threshold },
          },
        });
      }
      return { row: await this.loadById(tx, transaction.id), replayed: false };
      });

    if (!result.row) {
      throw new ConflictException('Collection transaction could not be loaded');
    }
    return { data: this.serialize(result.row), replayed: result.replayed };
  }

  async listMine(user: AccessTokenPayload, query: CollectionListQueryInput) {
    const collector = await this.prisma.collector.findUnique({ where: { userId: user.sub } });
    if (!collector || collector.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Collector profile not found');
    }
    const from = query.from ?? null;
    const to = query.to ?? null;
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<CollectionRow[]>`
        SELECT ct."id", ct."client_uuid", ct."order_id", ct."container_id", ct."merchant_id", ct."collector_id",
          ct."actual_liters"::float8 AS "actual_liters", ct."quality"::text AS "quality", ct."photos",
          ct."collected_at", ct."created_at", c."qr_code" AS "container_code",
          ST_Y(ct."geo_point"::geometry)::float8 AS "geo_lat", ST_X(ct."geo_point"::geometry)::float8 AS "geo_lng"
        FROM "collection_transactions" ct
        JOIN "containers" c ON c."id" = ct."container_id"
        WHERE ct."collector_id" = ${collector.id}::uuid
          AND ct."deleted_at" IS NULL
          AND (${from}::timestamptz IS NULL OR ct."collected_at" >= ${from})
          AND (${to}::timestamptz IS NULL OR ct."collected_at" <= ${to})
        ORDER BY ct."collected_at" DESC
        LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
      `,
      this.prisma.$queryRaw<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS total
        FROM "collection_transactions" ct
        WHERE ct."collector_id" = ${collector.id}::uuid
          AND ct."deleted_at" IS NULL
          AND (${from}::timestamptz IS NULL OR ct."collected_at" >= ${from})
          AND (${to}::timestamptz IS NULL OR ct."collected_at" <= ${to})
      `,
    ]);
    return { data: rows.map((row) => this.serialize(row)), meta: { page: query.page, limit: query.limit, total: countRows[0]?.total ?? 0 } };
  }

  private async loadByClientUuid(tx: Prisma.TransactionClient, clientUuid: string): Promise<CollectionRow | null> {
    const rows = await tx.$queryRaw<CollectionRow[]>`
      SELECT ct."id", ct."client_uuid", ct."order_id", ct."container_id", ct."merchant_id", ct."collector_id",
        ct."actual_liters"::float8 AS "actual_liters", ct."quality"::text AS "quality", ct."photos",
        ct."collected_at", ct."created_at", c."qr_code" AS "container_code",
        ST_Y(ct."geo_point"::geometry)::float8 AS "geo_lat", ST_X(ct."geo_point"::geometry)::float8 AS "geo_lng"
      FROM "collection_transactions" ct
      JOIN "containers" c ON c."id" = ct."container_id"
      WHERE ct."client_uuid" = ${clientUuid}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async loadById(tx: Prisma.TransactionClient, id: string): Promise<CollectionRow | null> {
    const rows = await tx.$queryRaw<CollectionRow[]>`
      SELECT ct."id", ct."client_uuid", ct."order_id", ct."container_id", ct."merchant_id", ct."collector_id",
        ct."actual_liters"::float8 AS "actual_liters", ct."quality"::text AS "quality", ct."photos",
        ct."collected_at", ct."created_at", c."qr_code" AS "container_code",
        ST_Y(ct."geo_point"::geometry)::float8 AS "geo_lat", ST_X(ct."geo_point"::geometry)::float8 AS "geo_lng"
      FROM "collection_transactions" ct
      JOIN "containers" c ON c."id" = ct."container_id"
      WHERE ct."id" = ${id}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private serialize(row: CollectionRow) {
    return {
      id: row.id,
      client_uuid: row.client_uuid,
      order_id: row.order_id,
      container_id: row.container_id,
      container_code: row.container_code,
      merchant_id: row.merchant_id,
      collector_id: row.collector_id,
      actual_liters: Number(row.actual_liters),
      quality: row.quality,
      geo: row.geo_lat === null || row.geo_lng === null ? null : { lat: row.geo_lat, lng: row.geo_lng },
      photos: row.photos,
      collected_at: row.collected_at,
      created_at: row.created_at,
    };
  }
}
