import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma} from '@prisma/client';
import { PrismaClient } from '@prisma/client';

type GeographyTable = 'merchants' | 'stations';

export interface GeographyPoint {
  id: string;
  lat: number;
  lng: number;
}

export interface RouteOrderRow {
  orderId: string;
  merchantId: string;
  merchantName: string;
  merchantAddress: string | null;
  merchantPhone: string | null;
  merchantLat: number;
  merchantLng: number;
  wardCenterLat: number | null;
  wardCenterLng: number | null;
  containerCode: string;
  expectedLiters: number;
  containerCapacityLiters: number | null;
  lastCollectedAt: Date | null;
  priority: number;
  distanceM: number;
}

export interface LiveRouteStopMerchantRow {
  orderId: string;
  merchantName: string;
  merchantAddress: string | null;
  merchantPhone: string | null;
  merchantLat: number;
  merchantLng: number;
  wardCenterLat: number | null;
  wardCenterLng: number | null;
  containerCode: string;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async setGeographyPoint(table: GeographyTable, id: string, lat: number, lng: number): Promise<void> {
    const tableName = table === 'merchants' ? 'merchants' : 'stations';
    await this.$executeRawUnsafe(
      `UPDATE "${tableName}" SET "location" = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography WHERE "id" = $3::uuid`,
      lng,
      lat,
      id,
    );
  }

  async getGeographyPoints(table: GeographyTable, ids: string[]): Promise<GeographyPoint[]> {
    if (ids.length === 0) {
      return [];
    }
    const tableName = table === 'merchants' ? 'merchants' : 'stations';
    return this.$queryRawUnsafe<GeographyPoint[]>(
      `SELECT "id", ST_Y("location"::geometry)::float8 AS "lat", ST_X("location"::geometry)::float8 AS "lng" FROM "${tableName}" WHERE "id" = ANY($1::uuid[])`,
      ids,
    );
  }

  async getGeographyPoint(table: GeographyTable, id: string): Promise<GeographyPoint | null> {
    const points = await this.getGeographyPoints(table, [id]);
    return points[0] ?? null;
  }

  async queryGeography<T>(query: Prisma.Sql): Promise<T[]> {
    return this.$queryRaw<T[]>(query);
  }

  async findReadyOrdersForRoute(wardIds: string[], originLat: number, originLng: number): Promise<RouteOrderRow[]> {
    if (wardIds.length === 0) {
      return [];
    }
    return this.$queryRawUnsafe<RouteOrderRow[]>(
      `WITH origin AS (
        SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS point
      )
      SELECT
        o."id" AS "orderId",
        m."id" AS "merchantId",
        m."business_name" AS "merchantName",
        m."address" AS "merchantAddress",
        u."phone" AS "merchantPhone",
        ST_Y(COALESCE(m."location", ST_SetSRID(ST_MakePoint(COALESCE(w."center_lng", $1), COALESCE(w."center_lat", $2)), 4326)::geography)::geometry)::float8 AS "merchantLat",
        ST_X(COALESCE(m."location", ST_SetSRID(ST_MakePoint(COALESCE(w."center_lng", $1), COALESCE(w."center_lat", $2)), 4326)::geography)::geometry)::float8 AS "merchantLng",
        w."center_lat"::float8 AS "wardCenterLat",
        w."center_lng"::float8 AS "wardCenterLng",
        c."qr_code" AS "containerCode",
        COALESCE(o."expected_liters", 0)::float8 AS "expectedLiters",
        c."capacity_liters"::float8 AS "containerCapacityLiters",
        m."last_collected_at" AS "lastCollectedAt",
        o."priority"::float8 AS "priority",
        ST_Distance(
          COALESCE(m."location", ST_SetSRID(ST_MakePoint(COALESCE(w."center_lng", $1), COALESCE(w."center_lat", $2)), 4326)::geography),
          origin.point
        )::float8 AS "distanceM"
      FROM "collection_orders" o
      JOIN "merchants" m ON m."id" = o."merchant_id"
      JOIN "users" u ON u."id" = m."user_id"
      JOIN "containers" c ON c."id" = o."container_id"
      JOIN "wards" w ON w."id" = m."ward_id"
      CROSS JOIN origin
      WHERE o."status" = 'READY'::"OrderStatus"
        AND o."deleted_at" IS NULL
        AND m."status" = 'ACTIVE'::"EntityStatus"
        AND c."status" = 'ACTIVE'::"EntityStatus"
        AND m."ward_id" = ANY($3::uuid[])
      ORDER BY o."priority" DESC, "distanceM" ASC, o."requested_at" ASC`,
      originLng,
      originLat,
      wardIds,
    );
  }

  async findLiveRouteStopMerchants(orderIds: string[]): Promise<LiveRouteStopMerchantRow[]> {
    const uniqueOrderIds = [...new Set(orderIds)];
    if (uniqueOrderIds.length === 0) {
      return [];
    }
    return this.$queryRawUnsafe<LiveRouteStopMerchantRow[]>(
      `SELECT
        o."id" AS "orderId",
        m."business_name" AS "merchantName",
        m."address" AS "merchantAddress",
        u."phone" AS "merchantPhone",
        ST_Y(COALESCE(m."location", ST_SetSRID(ST_MakePoint(w."center_lng", w."center_lat"), 4326)::geography)::geometry)::float8 AS "merchantLat",
        ST_X(COALESCE(m."location", ST_SetSRID(ST_MakePoint(w."center_lng", w."center_lat"), 4326)::geography)::geometry)::float8 AS "merchantLng",
        w."center_lat"::float8 AS "wardCenterLat",
        w."center_lng"::float8 AS "wardCenterLng",
        c."qr_code" AS "containerCode"
      FROM "collection_orders" o
      JOIN "merchants" m ON m."id" = o."merchant_id"
      JOIN "users" u ON u."id" = m."user_id"
      JOIN "containers" c ON c."id" = o."container_id"
      JOIN "wards" w ON w."id" = m."ward_id"
      WHERE o."id" = ANY($1::uuid[])
        AND o."deleted_at" IS NULL`,
      uniqueOrderIds,
    );
  }

  async findRecentCollectionHistoryByMerchantIds(
    merchantIds: string[],
    limitPerMerchant = 5,
  ): Promise<Array<{ merchantId: string; actualLiters: number; collectedAt: Date }>> {
    const uniqueMerchantIds = [...new Set(merchantIds)];
    if (uniqueMerchantIds.length === 0) {
      return [];
    }
    const safeLimit = Math.max(0, Math.floor(limitPerMerchant));
    if (safeLimit === 0) {
      return [];
    }
    return this.$queryRawUnsafe<Array<{ merchantId: string; actualLiters: number; collectedAt: Date }>>(
      `WITH ranked_transactions AS (
        SELECT
          ct."merchant_id" AS "merchantId",
          ct."actual_liters"::float8 AS "actualLiters",
          ct."collected_at" AS "collectedAt",
          ROW_NUMBER() OVER (
            PARTITION BY ct."merchant_id"
            ORDER BY ct."collected_at" DESC, ct."id" DESC
          ) AS row_number
        FROM "collection_transactions" ct
        WHERE ct."merchant_id" = ANY($1::uuid[])
          AND ct."deleted_at" IS NULL
          AND ct."quality" = 'PASS'::"Quality"
      )
      SELECT "merchantId", "actualLiters", "collectedAt"
      FROM ranked_transactions
      WHERE row_number <= $2
      ORDER BY "merchantId", "collectedAt" DESC` ,
      uniqueMerchantIds,
      safeLimit,
    );
  }

  async findPickupForecastBacktestObservations(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<Array<{
    merchant_id: string;
    merchant_name: string;
    collected_at: Date;
    actual_liters: number;
    declared_estimated_liters: number | null;
    container_capacity_liters: number | null;
  }>> {
    return this.$queryRaw`
      WITH window_transactions AS (
        SELECT
          ct."merchant_id" AS merchant_id,
          m."business_name" AS merchant_name,
          ct."collected_at" AS collected_at,
          ct."actual_liters"::float8 AS actual_liters,
          o."expected_liters"::float8 AS declared_estimated_liters,
          c."capacity_liters"::float8 AS container_capacity_liters
        FROM "collection_transactions" ct
        JOIN "merchants" m ON m."id" = ct."merchant_id"
        LEFT JOIN "collection_orders" o ON o."id" = ct."order_id"
        LEFT JOIN "containers" c ON c."id" = ct."container_id"
        WHERE ct."deleted_at" IS NULL
          AND ct."quality" = 'PASS'::"Quality"
          AND ct."collected_at" >= ${windowStart}
          AND ct."collected_at" <= ${windowEnd}
      ),
      previous_ranked AS (
        SELECT
          ct."merchant_id" AS merchant_id,
          m."business_name" AS merchant_name,
          ct."collected_at" AS collected_at,
          ct."actual_liters"::float8 AS actual_liters,
          NULL::float8 AS declared_estimated_liters,
          c."capacity_liters"::float8 AS container_capacity_liters,
          ROW_NUMBER() OVER (
            PARTITION BY ct."merchant_id"
            ORDER BY ct."collected_at" DESC, ct."id" DESC
          ) AS row_number
        FROM "collection_transactions" ct
        JOIN "merchants" m ON m."id" = ct."merchant_id"
        LEFT JOIN "containers" c ON c."id" = ct."container_id"
        WHERE ct."deleted_at" IS NULL
          AND ct."quality" = 'PASS'::"Quality"
          AND ct."collected_at" < ${windowStart}
      ),
      previous_transactions AS (
        SELECT merchant_id, merchant_name, collected_at, actual_liters, declared_estimated_liters, container_capacity_liters
        FROM previous_ranked
        WHERE row_number <= 5
      )
      SELECT merchant_id, merchant_name, collected_at, actual_liters, declared_estimated_liters, container_capacity_liters
      FROM previous_transactions
      UNION ALL
      SELECT merchant_id, merchant_name, collected_at, actual_liters, declared_estimated_liters, container_capacity_liters
      FROM window_transactions
      ORDER BY merchant_id, collected_at ASC
    `;
  }
}
