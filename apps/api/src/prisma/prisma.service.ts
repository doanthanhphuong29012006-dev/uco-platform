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
  merchantName: string;
  merchantAddress: string | null;
  merchantLat: number;
  merchantLng: number;
  containerCode: string;
  expectedLiters: number;
  priority: number;
  distanceM: number;
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
        m."business_name" AS "merchantName",
        m."address" AS "merchantAddress",
        ST_Y(COALESCE(m."location", ST_SetSRID(ST_MakePoint(COALESCE(w."center_lng", $1), COALESCE(w."center_lat", $2)), 4326)::geography)::geometry)::float8 AS "merchantLat",
        ST_X(COALESCE(m."location", ST_SetSRID(ST_MakePoint(COALESCE(w."center_lng", $1), COALESCE(w."center_lat", $2)), 4326)::geography)::geometry)::float8 AS "merchantLng",
        c."qr_code" AS "containerCode",
        COALESCE(o."expected_liters", 0)::float8 AS "expectedLiters",
        o."priority"::float8 AS "priority",
        ST_Distance(
          COALESCE(m."location", ST_SetSRID(ST_MakePoint(COALESCE(w."center_lng", $1), COALESCE(w."center_lat", $2)), 4326)::geography),
          origin.point
        )::float8 AS "distanceM"
      FROM "collection_orders" o
      JOIN "merchants" m ON m."id" = o."merchant_id"
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
}
