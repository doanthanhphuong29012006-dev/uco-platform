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
}
