import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type {
  AdminAlertListQueryInput,
  AdminOverviewQueryInput,
  AdminReconciliationQueryInput,
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
        COALESCE((SELECT json_agg(json_build_object('date', to_char(day, 'YYYY-MM-DD'), 'liters', liters) ORDER BY day) FROM daily), '[]'::json) AS daily_liters
      FROM order_counts oc CROSS JOIN container_counts cc CROSS JOIN station_rows sr
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
    };
  }

  async reconciliation(query: AdminReconciliationQueryInput) {
    const day = this.startOfDay(query.date);
    const nextDay = new Date(day.getTime() + DAY_MS);
    const threshold = Number(this.config.get<number | string>('DELIVERY_VARIANCE_THRESHOLD_PCT', 0.02));
    const rows = await this.prisma.$queryRaw<ReconciliationRow[]>`
      WITH collected AS (
        SELECT ct."collector_id", c."display_name" AS name, SUM(ct."actual_liters")::float8 AS collected_liters
        FROM "collection_transactions" ct
        JOIN "collectors" c ON c."id" = ct."collector_id"
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
          COALESCE(d.delivered_liters, 0)::float8 AS delivered_liters
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
