import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type {
  AdminCollectorListQueryInput,
  AdminMerchantListQueryInput,
  AdminAlertListQueryInput,
  AdminOverviewQueryInput,
  AdminReconciliationQueryInput,
  AdminStationListQueryInput,
} from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

type OverviewRow = {
  liters: number;
  transaction_count: number;
  active_merchants: number;
  active_collectors: number;
  ready: number;
  assigned: number;
  collected: number;
  cancelled: number;
  at_merchant: number;
  in_transit: number;
  at_station: number;
  alerts_open: number;
  stations: unknown;
  daily_liters: unknown;
  recent_transactions: unknown;
};

type ReconciliationRow = {
  collected_liters: number;
  delivered_liters: number;
  by_collector: unknown;
  undelivered_transactions: unknown;
};

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async overview(query: AdminOverviewQueryInput) {
    const { from, to } = this.period(query.from, query.to);
    const rows = await this.prisma.$queryRaw<OverviewRow[]>`
      WITH bounds AS (
        SELECT ${from}::timestamptz AS from_at, ${to}::timestamptz AS to_at
      ),
      period_transactions AS (
        SELECT ct."actual_liters", ct."merchant_id", ct."collector_id", ct."collected_at"
        FROM "collection_transactions" ct, bounds b
        WHERE ct."deleted_at" IS NULL
          AND ct."collected_at" >= b.from_at
          AND ct."collected_at" < b.to_at
      ),
      order_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE co."status" = 'READY')::int AS ready,
          COUNT(*) FILTER (WHERE co."status" = 'ASSIGNED')::int AS assigned,
          COUNT(*) FILTER (WHERE co."status" = 'COLLECTED')::int AS collected,
          COUNT(*) FILTER (WHERE co."status" = 'CANCELLED')::int AS cancelled
        FROM "collection_orders" co, bounds b
        WHERE co."deleted_at" IS NULL
          AND co."requested_at" >= b.from_at
          AND co."requested_at" < b.to_at
      ),
      container_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE c."state" = 'AT_MERCHANT' AND c."status" = 'ACTIVE')::int AS at_merchant,
          COUNT(*) FILTER (WHERE c."state" = 'IN_TRANSIT' AND c."status" = 'ACTIVE')::int AS in_transit,
          COUNT(*) FILTER (WHERE c."state" = 'AT_STATION' AND c."status" = 'ACTIVE')::int AS at_station
        FROM "containers" c
        WHERE c."deleted_at" IS NULL
      ),
      days AS (
        SELECT generate_series(
          date_trunc('day', ${from}::timestamptz),
          date_trunc('day', (${to}::timestamptz - interval '1 microsecond')),
          interval '1 day'
        ) AS day
      ),
      daily AS (
        SELECT d.day::date AS day, COALESCE(SUM(pt."actual_liters"), 0)::float8 AS liters
        FROM days d
        LEFT JOIN period_transactions pt
          ON pt."collected_at" >= d.day
         AND pt."collected_at" < d.day + interval '1 day'
        GROUP BY d.day
      ),
      station_rows AS (
        SELECT COALESCE(json_agg(json_build_object(
          'id', s."id",
          'name', s."name",
          'current_volume_l', s."current_volume_l"::float8,
          'capacity_l', s."capacity_l"::float8,
          'fill_pct', CASE WHEN s."capacity_l" > 0 THEN (s."current_volume_l" / s."capacity_l" * 100)::float8 ELSE 0 END
        ) ORDER BY s."name"), '[]'::json) AS stations
        FROM "stations" s
        WHERE s."status" = 'ACTIVE' AND s."deleted_at" IS NULL
      ),
      recent_rows AS (
        SELECT COALESCE(json_agg(json_build_object(
          'id', recent."id",
          'merchant_name', recent."merchant_name",
          'collector_name', recent."collector_name",
          'actual_liters', recent."actual_liters",
          'quality', recent."quality",
          'collected_at', recent."collected_at"
        ) ORDER BY recent."collected_at" DESC), '[]'::json) AS recent_transactions
        FROM (
          SELECT ct."id", m."business_name" AS "merchant_name", u."name" AS "collector_name",
            ct."actual_liters"::float8 AS "actual_liters", ct."quality"::text AS "quality", ct."collected_at"
          FROM "collection_transactions" ct
          JOIN "merchants" m ON m."id" = ct."merchant_id"
          LEFT JOIN "collectors" co ON co."id" = ct."collector_id"
          LEFT JOIN "users" u ON u."id" = co."user_id"
          WHERE ct."deleted_at" IS NULL
          ORDER BY ct."collected_at" DESC
          LIMIT 10
        ) recent
      )
      SELECT
        COALESCE((SELECT SUM("actual_liters")::float8 FROM period_transactions), 0)::float8 AS liters,
        (SELECT COUNT(*)::int FROM period_transactions) AS transaction_count,
        (SELECT COUNT(DISTINCT "merchant_id")::int FROM period_transactions) AS active_merchants,
        (SELECT COUNT(DISTINCT "collector_id")::int FROM period_transactions) AS active_collectors,
        oc.ready, oc.assigned, oc.collected, oc.cancelled,
        cc.at_merchant, cc.in_transit, cc.at_station,
        (SELECT COUNT(*)::int FROM "alerts" a WHERE a."resolved_at" IS NULL) AS alerts_open,
        sr.stations,
        COALESCE((SELECT json_agg(json_build_object('date', to_char(day, 'YYYY-MM-DD'), 'liters', liters) ORDER BY day) FROM daily), '[]'::json) AS daily_liters,
        rr.recent_transactions
      FROM order_counts oc CROSS JOIN container_counts cc CROSS JOIN station_rows sr CROSS JOIN recent_rows rr
    `;
    const row = rows[0];
    return {
      period: { from: from.toISOString(), to: new Date(to.getTime() - 1).toISOString() },
      totals: {
        liters: Number(row?.liters ?? 0),
        transactions: Number(row?.transaction_count ?? 0),
        active_merchants: Number(row?.active_merchants ?? 0),
        active_collectors: Number(row?.active_collectors ?? 0),
      },
      orders: {
        ready: Number(row?.ready ?? 0),
        assigned: Number(row?.assigned ?? 0),
        collected: Number(row?.collected ?? 0),
        cancelled: Number(row?.cancelled ?? 0),
      },
      containers: {
        at_merchant: Number(row?.at_merchant ?? 0),
        in_transit: Number(row?.in_transit ?? 0),
        at_station: Number(row?.at_station ?? 0),
      },
      stations: row?.stations ?? [],
      alerts_open: Number(row?.alerts_open ?? 0),
      daily_liters: row?.daily_liters ?? [],
      recent_transactions: row?.recent_transactions ?? [],
    };
  }

  async reconciliation(query: AdminReconciliationQueryInput) {
    const day = this.startOfDay(query.date);
    const nextDay = new Date(day.getTime() + DAY_MS);
    const threshold = Number(this.config.get<number | string>('DELIVERY_VARIANCE_THRESHOLD_PCT', 0.02));
    const rows = await this.prisma.$queryRaw<ReconciliationRow[]>`
      WITH collected AS (
        SELECT ct."collector_id", c."display_name" AS name, SUM(ct."actual_liters")::float8 AS collected_liters,
          COALESCE(json_agg(json_build_object(
            'id', ct."id",
            'merchant_name', m."business_name",
            'liters', ct."actual_liters"::float8,
            'collected_at', ct."collected_at"
          ) ORDER BY ct."collected_at"), '[]'::json) AS transactions
        FROM "collection_transactions" ct
        JOIN "collectors" c ON c."id" = ct."collector_id"
        JOIN "merchants" m ON m."id" = ct."merchant_id"
        WHERE ct."deleted_at" IS NULL AND ct."collected_at" >= ${day} AND ct."collected_at" < ${nextDay}
        GROUP BY ct."collector_id", c."display_name"
      ),
      delivered AS (
        SELECT sd."collector_id", c."display_name" AS name, SUM(sd."actual_liters")::float8 AS delivered_liters
        FROM "station_deliveries" sd
        JOIN "collectors" c ON c."id" = sd."collector_id"
        WHERE sd."deleted_at" IS NULL AND sd."delivered_at" >= ${day} AND sd."delivered_at" < ${nextDay}
        GROUP BY sd."collector_id", c."display_name"
      ),
      collector_rows AS (
        SELECT COALESCE(c."collector_id", d."collector_id") AS collector_id,
          COALESCE(c.name, d.name) AS name,
          COALESCE(c.collected_liters, 0)::float8 AS collected_liters,
          COALESCE(d.delivered_liters, 0)::float8 AS delivered_liters,
          COALESCE(c.transactions, '[]'::json) AS transactions
        FROM collected c FULL OUTER JOIN delivered d ON d."collector_id" = c."collector_id"
      ),
      undelivered AS (
        SELECT COALESCE(json_agg(json_build_object(
          'id', ct."id",
          'merchant_name', m."business_name",
          'liters', ct."actual_liters"::float8,
          'collected_at', ct."collected_at"
        ) ORDER BY ct."collected_at"), '[]'::json) AS items
        FROM "collection_transactions" ct
        JOIN "merchants" m ON m."id" = ct."merchant_id"
        WHERE ct."deleted_at" IS NULL
          AND ct."station_delivery_id" IS NULL
          AND ct."collected_at" >= ${day}
          AND ct."collected_at" < ${nextDay}
      )
      SELECT
        COALESCE((SELECT SUM("actual_liters")::float8 FROM "collection_transactions" WHERE "deleted_at" IS NULL AND "collected_at" >= ${day} AND "collected_at" < ${nextDay}), 0)::float8 AS collected_liters,
        COALESCE((SELECT SUM("actual_liters")::float8 FROM "station_deliveries" WHERE "deleted_at" IS NULL AND "delivered_at" >= ${day} AND "delivered_at" < ${nextDay}), 0)::float8 AS delivered_liters,
        COALESCE((SELECT json_agg(json_build_object(
          'collector_id', collector_id,
          'name', name,
          'collected_l', collected_liters,
          'delivered_l', delivered_liters,
          'variance_l', collected_liters - delivered_liters,
          'transactions', transactions,
          'status', CASE WHEN ABS((collected_liters - delivered_liters) / NULLIF(collected_liters, 0)) > ${threshold} THEN 'FLAGGED' ELSE 'OK' END
        ) ORDER BY name) FROM collector_rows), '[]'::json) AS by_collector,
        (SELECT items FROM undelivered) AS undelivered_transactions
    `;
    const row = rows[0];
    const collected = Number(row?.collected_liters ?? 0);
    const delivered = Number(row?.delivered_liters ?? 0);
    const variance = collected - delivered;
    return {
      date: day.toISOString().slice(0, 10),
      collected_liters: collected,
      delivered_liters: delivered,
      variance_l: variance,
      variance_pct: collected === 0 ? 0 : variance / collected,
      by_collector: row?.by_collector ?? [],
      undelivered_transactions: row?.undelivered_transactions ?? [],
    };
  }

  async listAlerts(query: AdminAlertListQueryInput) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      type: string;
      severity: string | null;
      message: string | null;
      details: Prisma.JsonValue;
      created_at: Date;
      resolved_at: Date | null;
      total: number;
    }>>`
      SELECT a."id", a."type"::text AS "type", a."severity"::text AS "severity", a."message", a."details",
        a."created_at", a."resolved_at", COUNT(*) OVER()::int AS "total"
      FROM "alerts" a
      WHERE (${query.type ?? null}::text IS NULL OR a."type"::text = ${query.type ?? null})
        AND (${query.resolved ?? null}::boolean IS NULL OR (${query.resolved ?? null} AND a."resolved_at" IS NOT NULL) OR (NOT ${query.resolved ?? null} AND a."resolved_at" IS NULL))
      ORDER BY a."created_at" DESC
      LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
    `;
    return {
      data: rows.map((row) => this.serializeAlert(row)),
      meta: { page: query.page, limit: query.limit, total: Number(rows[0]?.total ?? 0) },
    };
  }

  async listStations(query: AdminStationListQueryInput) {
    const where: Prisma.StationWhereInput = {
      ...(query.ward_id ? { wardId: query.ward_id } : {}),
      ...(query.status ? { status: query.status } : query.include_inactive ? {} : { status: 'ACTIVE' }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.station.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { ward: true },
      }),
      this.prisma.station.count({ where }),
    ]);
    const points = await this.prisma.getGeographyPoints('stations', rows.map((row) => row.id));
    const pointMap = new Map(points.map((point) => [point.id, point]));
    return {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        lat: pointMap.get(row.id)?.lat ?? null,
        lng: pointMap.get(row.id)?.lng ?? null,
        capacity_l: Number(row.capacityLiters),
        current_volume_l: Number(row.currentVolumeLiters),
        fill_pct: Number(row.capacityLiters) > 0 ? (Number(row.currentVolumeLiters) / Number(row.capacityLiters)) * 100 : 0,
        status: row.status,
        ward: { id: row.ward.id, code: row.ward.code, name: row.ward.name },
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async listMerchants(query: AdminMerchantListQueryInput) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      name: string;
      address: string | null;
      lat: number | null;
      lng: number | null;
      distance_m: number | null;
      status: string;
      avg_daily_liters: number | null;
      last_collected_at: Date | null;
      anomaly: boolean;
      total: number;
    }>>`
      SELECT m."id", m."business_name" AS name, m."address",
        ST_Y(m."location"::geometry)::float8 AS lat,
        ST_X(m."location"::geometry)::float8 AS lng,
        nearest.distance_m::float8 AS distance_m,
        m."status"::text AS status,
        m."avg_daily_liters"::float8 AS avg_daily_liters,
        m."last_collected_at",
        EXISTS (
          SELECT 1 FROM "collection_transactions" ct
          WHERE ct."merchant_id" = m."id" AND ct."quality" = 'FLAG' AND ct."deleted_at" IS NULL
        ) AS anomaly,
        COUNT(*) OVER()::int AS total
      FROM "merchants" m
      LEFT JOIN LATERAL (
        SELECT ST_Distance(m."location", s."location") AS distance_m
        FROM "stations" s
        WHERE s."status" = 'ACTIVE' AND s."deleted_at" IS NULL
          AND m."location" IS NOT NULL AND s."location" IS NOT NULL
        ORDER BY distance_m ASC
        LIMIT 1
      ) nearest ON true
      WHERE m."deleted_at" IS NULL
        AND (${query.ward_id ?? null}::uuid IS NULL OR m."ward_id" = ${query.ward_id ?? null}::uuid)
        AND (${query.status ?? null}::text IS NULL OR m."status"::text = ${query.status ?? null})
        AND (${query.include_inactive}::boolean OR m."status" = 'ACTIVE')
        AND (${query.search ?? null}::text IS NULL OR m."business_name" ILIKE '%' || ${query.search ?? null} || '%')
        AND (${query.anomaly ?? null}::boolean IS NULL OR EXISTS (
          SELECT 1 FROM "collection_transactions" ct2
          WHERE ct2."merchant_id" = m."id" AND ct2."quality" = 'FLAG' AND ct2."deleted_at" IS NULL
        ) = ${query.anomaly ?? null})
      ORDER BY m."business_name" ASC
      LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
    `;
    return {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        lat: row.lat === null ? null : Number(row.lat),
        lng: row.lng === null ? null : Number(row.lng),
        distance_m: row.distance_m === null ? null : Number(row.distance_m),
        status: row.status,
        avg_daily_liters: row.avg_daily_liters === null ? null : Number(row.avg_daily_liters),
        last_collected_at: row.last_collected_at,
        anomaly: row.anomaly,
      })),
      meta: { page: query.page, limit: query.limit, total: Number(rows[0]?.total ?? 0) },
    };
  }

  async listCollectors(query: AdminCollectorListQueryInput) {
    const where: Prisma.CollectorWhereInput = {
      ...(query.ward_id ? { wardId: query.ward_id } : {}),
      ...(query.status ? { status: query.status } : query.include_inactive ? {} : { status: 'ACTIVE' }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.collector.findMany({
        where,
        orderBy: { displayName: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { ward: true, user: true },
      }),
      this.prisma.collector.count({ where }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        display_name: row.displayName,
        status: row.status,
        is_active: row.isActive,
        last_seen_at: row.lastSeenAt,
        ward: { id: row.ward.id, code: row.ward.code, name: row.ward.name },
        user: { id: row.user.id, name: row.user.name, phone: row.user.phone },
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async collectorPerformance(id: string) {
    const collector = await this.prisma.collector.findUnique({ where: { id }, select: { id: true, displayName: true } });
    if (!collector) {
      throw new NotFoundException('Collector not found');
    }
    const threshold = Number(this.config.get<number | string>('DELIVERY_VARIANCE_THRESHOLD_PCT', 0.02));
    const rows = await this.prisma.$queryRaw<Array<{
      liters_7d: number;
      collections_7d: number;
      delivered_liters_7d: number;
    }>>`
      WITH bounds AS (SELECT NOW() - interval '7 days' AS from_at)
      SELECT
        COALESCE((SELECT SUM(ct."actual_liters")::float8 FROM "collection_transactions" ct, bounds b
          WHERE ct."collector_id" = ${id}::uuid AND ct."deleted_at" IS NULL AND ct."collected_at" >= b.from_at), 0)::float8 AS liters_7d,
        COALESCE((SELECT COUNT(*)::int FROM "collection_transactions" ct, bounds b
          WHERE ct."collector_id" = ${id}::uuid AND ct."deleted_at" IS NULL AND ct."collected_at" >= b.from_at), 0)::int AS collections_7d,
        COALESCE((SELECT SUM(sd."actual_liters")::float8 FROM "station_deliveries" sd, bounds b
          WHERE sd."collector_id" = ${id}::uuid AND sd."deleted_at" IS NULL AND sd."delivered_at" >= b.from_at), 0)::float8 AS delivered_liters_7d
    `;
    const row = rows[0] ?? { liters_7d: 0, collections_7d: 0, delivered_liters_7d: 0 };
    const liters = Number(row.liters_7d);
    const delivered = Number(row.delivered_liters_7d);
    const variance = liters - delivered;
    return {
      collector_id: collector.id,
      display_name: collector.displayName,
      liters_7d: liters,
      collections_7d: Number(row.collections_7d),
      delivered_liters_7d: delivered,
      variance_l: variance,
      variance_pct: liters === 0 ? 0 : variance / liters,
      status: liters === 0 || Math.abs(variance / liters) <= threshold ? 'OK' : 'FLAGGED',
    };
  }

  async resolveAlert(id: string, actorUserId: string) {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) {
      throw new NotFoundException('Alert not found');
    }
    if (alert.resolvedAt) {
      throw new ConflictException({ code: 'ALERT_ALREADY_RESOLVED', message: 'Alert is already resolved', details: { id } });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const resolved = await tx.alert.update({ where: { id }, data: { resolvedAt: new Date() } });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'RESOLVE_ALERT',
          entityType: 'Alert',
          entityId: id,
          details: { alert_type: alert.type },
        },
      });
      return resolved;
    });
    return this.serializeAlert(updated);
  }

  async merchantPerformance(id: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      merchant_id: string;
      total_liters: number;
      collection_count: number;
      avg_daily_liters: number | null;
      last_collected_at: Date | null;
      flagged_count: number;
    }>>`
      SELECT m."id" AS merchant_id,
        COALESCE(SUM(ct."actual_liters"), 0)::float8 AS total_liters,
        COUNT(ct."id")::int AS collection_count,
        m."avg_daily_liters"::float8 AS avg_daily_liters,
        MAX(ct."collected_at") AS last_collected_at,
        COUNT(ct."id") FILTER (WHERE ct."quality" = 'FLAG')::int AS flagged_count
      FROM "merchants" m
      LEFT JOIN "collection_transactions" ct ON ct."merchant_id" = m."id" AND ct."deleted_at" IS NULL
      WHERE m."id" = ${id}::uuid
      GROUP BY m."id", m."avg_daily_liters"
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Merchant not found');
    }
    return {
      merchant_id: row.merchant_id,
      total_liters: Number(row.total_liters),
      collection_count: Number(row.collection_count),
      avg_daily_liters: row.avg_daily_liters === null ? null : Number(row.avg_daily_liters),
      last_collected_at: row.last_collected_at,
      flagged_count: Number(row.flagged_count),
    };
  }

  private period(fromInput?: Date, toInput?: Date) {
    const now = new Date();
    const today = this.startOfDay(now);
    const from = fromInput ? this.startOfDay(fromInput) : new Date(today.getTime() - 29 * DAY_MS);
    const to = toInput ? new Date(this.startOfDay(toInput).getTime() + DAY_MS) : new Date(today.getTime() + DAY_MS);
    return { from, to };
  }

  private startOfDay(value: Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  private serializeAlert(row: {
    id: string;
    type: string;
    severity: string | null;
    message: string | null;
    details: Prisma.JsonValue;
    created_at?: Date;
    createdAt?: Date;
    resolved_at?: Date | null;
    resolvedAt?: Date | null;
  }) {
    return {
      id: row.id,
      type: row.type,
      severity: row.severity,
      message: row.message,
      details: row.details,
      created_at: row.created_at ?? row.createdAt,
      resolved_at: row.resolved_at ?? row.resolvedAt ?? null,
    };
  }
}
