import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertSeverity, AlertType, EntityStatus, MerchantApprovalStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AdminCollectorListQueryInput,
  AdminMerchantListQueryInput,
  AdminAlertListQueryInput,
  AdminOverviewQueryInput,
  AdminReconciliationQueryInput,
  AdminAiPerformancePickupForecastQueryInput,
  AdminAiAnomalyListQueryInput,
  AdminAiAnomalyPerformanceQueryInput,
  AdminAiAnomalyFeedbackInput,
  AdminAiPerformanceImageGradingQueryInput,
  AdminStationListQueryInput,
  AdminCollectorCreateInput,
  AdminCollectorPatchInput,
  MerchantRejectInput,
  AdminContainerCreateInput,
  AdminContainerListQueryInput,
  AdminContainerReturnInput,
  AdminContainerCancelTransitInput,
  ContainerAssignInput,
  AdminWardCreateInput,
  AdminWardPatchInput,
  AdminWardListQueryInput,
  MerchantApprovalInput,
} from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  COLLECTOR_ACTIVE_INVITE_KEY_PREFIX,
  COLLECTOR_INVITE_KEY_PREFIX,
  COLLECTOR_INVITE_TTL_SECONDS,
} from '../auth/auth.constants';
import { getDensityKgPerLiter } from '../../config/mass.constants';
import {
  scoreTransactionAnomaly,
  type TransactionAnomalyInput,
  type TransactionAnomalyResult,
} from '../collections/transaction-anomaly-scorer';
import {
  buildContainerQrCode,
  containerQrPrefix,
  normalizeWardCode,
  wardLookupKey,
} from '../containers/qr-code';
import type { StationFillAlertCandidate } from '../stations/station-fill-alert';
import { StationsService } from '../stations/stations.service';
import { evaluatePickupVolumeBacktest } from '../orders/merchant-pickup-volume-backtester';

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
  collected_kg: number;
  delivered_kg: number;
  has_estimated_mass: boolean;
  by_collector: unknown;
  undelivered_transactions: unknown;
};

type ReconciliationTransaction = Record<string, unknown> & {
  id: string;
  merchant_id: string;
  collected_at: Date | string;
  mass_source?: string | null;
  density_factor?: number | null;
};

type ReconciliationAnomaly = TransactionAnomalyResult & { historySize: number };

type ReconciliationCsvRow = {
  occurred_at: Date;
  merchant_names: string;
  collector_name: string;
  station_name: string | null;
  expected_kg: number | null;
  actual_kg: number | null;
  variance_kg: number | null;
  variance_pct: number | null;
  status: string;
};

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(StationsService) private readonly stations: StationsService,
    @Optional() @Inject(RedisService) private readonly redis?: RedisService,
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
          'actual_kg', recent."actual_kg",
          'mass_source', recent."mass_source",
          'grade', recent."grade",
          'suspected_adulteration', recent."suspected_adulteration",
          'image_grade_suggestion', recent."image_grade_suggestion",
          'ai_suggested_grade', recent."image_grade_suggestion",
          'collector_selected_grade', recent."grade",
          'image_grade_confidence', recent."image_grade_confidence",
          'grade_decision_source', recent."grade_decision_source",
          'image_grade_analysis', recent."image_grade_analysis",
          'quality', recent."quality",
          'collected_at', recent."collected_at"
        ) ORDER BY recent."collected_at" DESC), '[]'::json) AS recent_transactions
        FROM (
          SELECT ct."id", m."business_name" AS "merchant_name", u."name" AS "collector_name",
            ct."actual_liters"::float8 AS "actual_liters", ct."actual_kg"::float8 AS "actual_kg", ct."mass_source"::text AS "mass_source", ct."grade"::text AS "grade", ct."suspected_adulteration", ct."image_grade_suggestion"::text AS "image_grade_suggestion", ct."image_grade_suggestion"::text AS "ai_suggested_grade", ct."grade"::text AS "collector_selected_grade", ct."image_grade_confidence"::text AS "image_grade_confidence", ct."grade_decision_source"::text AS "grade_decision_source", ct."image_grade_analysis", ct."quality"::text AS "quality", ct."collected_at"
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
    const threshold = Number(
      this.config.get<number | string>('DELIVERY_VARIANCE_THRESHOLD_PCT', 0.02),
    );
    const rows = await this.prisma.$queryRaw<ReconciliationRow[]>`
      WITH collected AS (
        SELECT ct."collector_id", c."display_name" AS name, SUM(ct."actual_liters")::float8 AS collected_liters,
          SUM(ct."actual_kg")::float8 AS collected_kg,
          BOOL_OR(ct."mass_source" <> 'SCALE') AS collected_estimated,
          COALESCE(json_agg(json_build_object(
            'id', ct."id",
            'merchant_id', ct."merchant_id",
            'merchant_name', m."business_name",
             'liters', ct."actual_liters"::float8,
             'kilograms', ct."actual_kg"::float8,
             'mass_source', ct."mass_source"::text,
             'density_factor', ct."density_factor"::float8,
             'grade', ct."grade"::text,
            'suspected_adulteration', ct."suspected_adulteration",
            'image_grade_suggestion', ct."image_grade_suggestion"::text,
            'ai_suggested_grade', ct."image_grade_suggestion"::text,
            'collector_selected_grade', ct."grade"::text,
            'image_grade_confidence', ct."image_grade_confidence"::text,
            'grade_decision_source', ct."grade_decision_source"::text,
            'image_grade_analysis', ct."image_grade_analysis",
            'collected_at', ct."collected_at"
          ) ORDER BY ct."collected_at"), '[]'::json) AS transactions
        FROM "collection_transactions" ct
        JOIN "collectors" c ON c."id" = ct."collector_id"
        JOIN "merchants" m ON m."id" = ct."merchant_id"
        WHERE ct."deleted_at" IS NULL AND ct."collected_at" >= ${day} AND ct."collected_at" < ${nextDay}
        GROUP BY ct."collector_id", c."display_name"
      ),
      delivered AS (
        SELECT sd."collector_id", c."display_name" AS name, SUM(sd."actual_liters")::float8 AS delivered_liters,
          SUM(sd."actual_kg")::float8 AS delivered_kg,
          BOOL_OR(sd."has_estimated_mass") AS delivered_estimated
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
          COALESCE(c.collected_kg, 0)::float8 AS collected_kg,
          COALESCE(d.delivered_kg, 0)::float8 AS delivered_kg,
          COALESCE(c.collected_estimated, false) OR COALESCE(d.delivered_estimated, false) AS has_estimated_mass,
          COALESCE(c.transactions, '[]'::json) AS transactions
        FROM collected c FULL OUTER JOIN delivered d ON d."collector_id" = c."collector_id"
      ),
      undelivered AS (
        SELECT COALESCE(json_agg(json_build_object(
          'id', ct."id",
          'merchant_id', ct."merchant_id",
          'merchant_name', m."business_name",
           'liters', ct."actual_liters"::float8,
           'kilograms', ct."actual_kg"::float8,
           'mass_source', ct."mass_source"::text,
           'density_factor', ct."density_factor"::float8,
           'grade', ct."grade"::text,
          'suspected_adulteration', ct."suspected_adulteration",
          'image_grade_suggestion', ct."image_grade_suggestion"::text,
          'ai_suggested_grade', ct."image_grade_suggestion"::text,
          'collector_selected_grade', ct."grade"::text,
          'image_grade_confidence', ct."image_grade_confidence"::text,
          'grade_decision_source', ct."grade_decision_source"::text,
          'image_grade_analysis', ct."image_grade_analysis",
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
        COALESCE((SELECT SUM("actual_kg")::float8 FROM "collection_transactions" WHERE "deleted_at" IS NULL AND "collected_at" >= ${day} AND "collected_at" < ${nextDay}), 0)::float8 AS collected_kg,
        COALESCE((SELECT SUM("actual_kg")::float8 FROM "station_deliveries" WHERE "deleted_at" IS NULL AND "delivered_at" >= ${day} AND "delivered_at" < ${nextDay}), 0)::float8 AS delivered_kg,
        COALESCE((SELECT BOOL_OR("mass_source" <> 'SCALE') FROM "collection_transactions" WHERE "deleted_at" IS NULL AND "collected_at" >= ${day} AND "collected_at" < ${nextDay}), false)
          OR COALESCE((SELECT BOOL_OR("has_estimated_mass") FROM "station_deliveries" WHERE "deleted_at" IS NULL AND "delivered_at" >= ${day} AND "delivered_at" < ${nextDay}), false) AS has_estimated_mass,
        COALESCE((SELECT json_agg(json_build_object(
          'collector_id', collector_id,
          'name', name,
          'collected_l', collected_liters,
          'delivered_l', delivered_liters,
          'variance_l', collected_liters - delivered_liters,
          'collected_kg', collected_kg,
          'delivered_kg', delivered_kg,
          'variance_kg', collected_kg - delivered_kg,
          'has_estimated_mass', has_estimated_mass,
          'transactions', transactions,
          'status', CASE WHEN ABS((collected_kg - delivered_kg) / NULLIF(collected_kg, 0)) - ${threshold} > 0.000000001 THEN 'FLAGGED' ELSE 'OK' END
        ) ORDER BY name) FROM collector_rows), '[]'::json) AS by_collector,
        (SELECT items FROM undelivered) AS undelivered_transactions
    `;
    const row = rows[0];
    const byCollector = this.records(row?.by_collector);
    const undeliveredTransactions = this.records(row?.undelivered_transactions);
    const candidates = this.uniqueReconciliationTransactions([
      ...byCollector.flatMap((collector) => this.records(collector.transactions)),
      ...undeliveredTransactions,
    ]);
    const anomalyByTransactionId = await this.scoreReconciliationTransactions(candidates);
    const enrichedByCollector = byCollector.map((collector) => ({
      ...collector,
      transactions: this.records(collector.transactions).map((transaction) =>
        this.withReconciliationAnomaly(transaction, anomalyByTransactionId),
      ),
    }));
    const enrichedUndelivered = undeliveredTransactions.map((transaction) =>
      this.withReconciliationAnomaly(transaction, anomalyByTransactionId),
    );
    const collected = Number(row?.collected_liters ?? 0);
    const delivered = Number(row?.delivered_liters ?? 0);
    const variance = collected - delivered;
    const collectedKg = Number(row?.collected_kg ?? 0);
    const deliveredKg = Number(row?.delivered_kg ?? 0);
    const varianceKg = collectedKg - deliveredKg;
    return {
      date: day.toISOString().slice(0, 10),
      collected_liters: collected,
      delivered_liters: delivered,
      variance_l: variance,
      variance_pct: collected === 0 ? 0 : variance / collected,
      collected_kg: collectedKg,
      delivered_kg: deliveredKg,
      variance_kg: varianceKg,
      variance_kg_pct: collectedKg === 0 ? 0 : varianceKg / collectedKg,
      variance_threshold_pct: threshold,
      has_estimated_mass: Boolean(row?.has_estimated_mass),
      by_collector: enrichedByCollector,
      undelivered_transactions: enrichedUndelivered,
    };
  }

  async pickupForecastPerformance(query: AdminAiPerformancePickupForecastQueryInput) {
    const asOf = new Date();
    const windowStart = new Date(asOf.getTime() - query.window_days * DAY_MS);
    const observations = await this.prisma.findPickupForecastBacktestObservations(
      windowStart,
      asOf,
    );
    const result = evaluatePickupVolumeBacktest(observations, {
      evaluation_from: windowStart,
      evaluation_to: asOf,
    });
    return {
      window_days: query.window_days as 30 | 90 | 180,
      window_start: windowStart.toISOString(),
      window_end: asOf.toISOString(),
      ...result,
    };
  }

  async imageGradingPerformance(query: AdminAiPerformanceImageGradingQueryInput) {
    const asOf = new Date();
    const windowStart = new Date(asOf.getTime() - query.window_days * DAY_MS);
    const rows = await this.prisma.collectionTransaction.findMany({
      where: {
        deletedAt: null,
        collectedAt: { gte: windowStart, lte: asOf },
        imageGradeSuggestion: { not: null },
      },
      orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        merchantId: true,
        grade: true,
        imageGradeSuggestion: true,
        imageGradeConfidence: true,
        imageGradeAnalysis: true,
        gradeDecisionSource: true,
        collectedAt: true,
        merchant: { select: { businessName: true } },
      },
    });
    const analyzedCount = rows.length;
    const acceptedCount = rows.filter(
      (row) => row.gradeDecisionSource === 'AI_SUGGESTION_ACCEPTED',
    ).length;
    const overrideCount = rows.filter(
      (row) => row.gradeDecisionSource === 'MANUAL_OVERRIDE_AI',
    ).length;
    const agreementCount = rows.filter(
      (row) => row.imageGradeSuggestion !== null && row.imageGradeSuggestion === row.grade,
    ).length;
    const lowConfidenceCount = rows.filter((row) => row.imageGradeConfidence === 'LOW').length;
    const retakeRecommendedCount = rows.filter((row) => {
      const analysis = row.imageGradeAnalysis;
      return (
        typeof analysis === 'object' &&
        analysis !== null &&
        !Array.isArray(analysis) &&
        (analysis as Record<string, unknown>).quality_status === 'RETAKE_RECOMMENDED'
      );
    }).length;
    const reasonCodes = (value: Prisma.JsonValue): string[] => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
      const raw = (value as Record<string, unknown>).reason_codes;
      return Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string').slice(0, 20)
        : [];
    };
    const reliability =
      analyzedCount < 20
        ? 'INSUFFICIENT'
        : analyzedCount < 50
          ? 'LOW'
          : analyzedCount < 100
            ? 'MEDIUM'
            : 'HIGH';
    return {
      window_days: query.window_days as 30 | 90 | 180,
      window_start: windowStart.toISOString(),
      window_end: asOf.toISOString(),
      analyzed_count: analyzedCount,
      accepted_count: acceptedCount,
      override_count: overrideCount,
      low_confidence_count: lowConfidenceCount,
      retake_recommended_count: retakeRecommendedCount,
      agreement_count: agreementCount,
      agreement_rate_percent:
        analyzedCount === 0 ? null : Number(((agreementCount / analyzedCount) * 100).toFixed(2)),
      reliability,
      breakdown_by_confidence: (['LOW', 'MEDIUM', 'HIGH'] as const).map((confidence) => ({
        confidence,
        count: rows.filter((row) => row.imageGradeConfidence === confidence).length,
      })),
      breakdown_by_decision_source: (
        ['MANUAL', 'AI_SUGGESTION_ACCEPTED', 'MANUAL_OVERRIDE_AI'] as const
      ).map((source) => ({
        source,
        count: rows.filter((row) => row.gradeDecisionSource === source).length,
      })),
      recent_disagreements: rows
        .filter(
          (row) => row.imageGradeSuggestion !== null && row.imageGradeSuggestion !== row.grade,
        )
        .slice(0, 30)
        .map((row) => ({
          transaction_id: row.id,
          merchant_id: row.merchantId,
          merchant_name: row.merchant.businessName,
          collected_at: row.collectedAt.toISOString(),
          suggested_grade: row.imageGradeSuggestion,
          selected_grade: row.grade,
          confidence: row.imageGradeConfidence,
          reason_codes: reasonCodes(row.imageGradeAnalysis ?? null),
        })),
      explanation:
        analyzedCount < 20
          ? 'Dữ liệu đánh giá còn ít; tỷ lệ đồng thuận chỉ mô tả quyết định của người thu gom, không phải độ chính xác của AI.'
          : 'Tỷ lệ đồng thuận mô tả mức độ người thu gom giữ hoặc thay đổi gợi ý ảnh; đây không phải kết luận độ chính xác của AI.',
    };
  }

  private records(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        )
      : [];
  }

  private uniqueReconciliationTransactions(
    rows: Array<Record<string, unknown>>,
  ): ReconciliationTransaction[] {
    const transactions = new Map<string, ReconciliationTransaction>();
    for (const row of rows) {
      if (
        typeof row.id === 'string' &&
        typeof row.merchant_id === 'string' &&
        (typeof row.collected_at === 'string' || row.collected_at instanceof Date)
      ) {
        transactions.set(row.id, row as ReconciliationTransaction);
      }
    }
    return [...transactions.values()];
  }

  private async scoreReconciliationTransactions(
    transactions: ReconciliationTransaction[],
  ): Promise<Map<string, ReconciliationAnomaly>> {
    return this.scoreAnomalyTransactions(transactions);
  }

  private async scoreAnomalyTransactions(
    transactions: ReconciliationTransaction[],
  ): Promise<Map<string, ReconciliationAnomaly>> {
    const result = new Map<string, ReconciliationAnomaly>();
    if (transactions.length === 0) return result;
    const expectedDensityKgPerLiter = getDensityKgPerLiter(this.config);

    const merchantIds = [...new Set(transactions.map((transaction) => transaction.merchant_id))];
    const latestCollectedAt = new Date(
      Math.max(
        ...transactions
          .map((transaction) => new Date(transaction.collected_at).getTime())
          .filter(Number.isFinite),
      ),
    );
    const historyRows = Number.isFinite(latestCollectedAt.getTime())
      ? await this.prisma.collectionTransaction.findMany({
          where: {
            merchantId: { in: merchantIds },
            deletedAt: null,
            collectedAt: { lt: latestCollectedAt },
          },
          select: {
            id: true,
            merchantId: true,
            actualKg: true,
            actualLiters: true,
            massSource: true,
            densityFactor: true,
            collectedAt: true,
          },
          orderBy: [{ merchantId: 'asc' }, { collectedAt: 'asc' }],
        })
      : [];
    const historyByMerchant = new Map<string, Array<TransactionAnomalyInput & { id: string }>>();
    for (const row of historyRows) {
      const merchantHistory = historyByMerchant.get(row.merchantId) ?? [];
      merchantHistory.push({
        id: row.id,
        merchantId: row.merchantId,
        actualKg: row.actualKg === null ? null : Number(row.actualKg),
        actualLiters: Number(row.actualLiters),
        massSource: row.massSource,
        densityFactor: row.densityFactor === null ? null : Number(row.densityFactor),
        expectedDensityKgPerLiter,
        collectedAt: row.collectedAt,
      });
      historyByMerchant.set(row.merchantId, merchantHistory);
    }

    for (const transaction of transactions) {
      const collectedAt = new Date(transaction.collected_at);
      const collectedTimestamp = collectedAt.getTime();
      const history = Number.isFinite(collectedTimestamp)
        ? (historyByMerchant.get(transaction.merchant_id) ?? []).filter(
            (item) =>
              item.id !== transaction.id &&
              new Date(item.collectedAt).getTime() < collectedTimestamp,
          )
        : [];
      const anomaly = scoreTransactionAnomaly(history, {
        merchantId: transaction.merchant_id,
        actualKg: this.numberOrNull(transaction.kilograms),
        actualLiters: this.numberOrNull(transaction.liters),
        massSource:
          transaction.mass_source === 'SCALE' || transaction.mass_source === 'ESTIMATED_FROM_VOLUME'
            ? transaction.mass_source
            : null,
        densityFactor: this.numberOrNull(transaction.density_factor),
        expectedDensityKgPerLiter,
        collectedAt: transaction.collected_at,
      });
      result.set(transaction.id, { ...anomaly, historySize: history.length });
    }
    return result;
  }

  private async loadAnomalyCandidates(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ReconciliationTransaction[]> {
    const rows = await this.prisma.collectionTransaction.findMany({
      where: { deletedAt: null, collectedAt: { gte: windowStart, lte: windowEnd } },
      orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        merchantId: true,
        actualLiters: true,
        actualKg: true,
        massSource: true,
        densityFactor: true,
        quality: true,
        grade: true,
        collectedAt: true,
        merchant: { select: { businessName: true } },
        collector: { select: { displayName: true } },
      },
    });
    return rows.map(
      (row) =>
        ({
          id: row.id,
          merchant_id: row.merchantId,
          merchant_name: row.merchant.businessName,
          collector_name: row.collector.displayName,
          liters: Number(row.actualLiters),
          kilograms: row.actualKg === null ? null : Number(row.actualKg),
          mass_source: row.massSource,
          density_factor: row.densityFactor === null ? null : Number(row.densityFactor),
          quality: row.quality,
          grade: row.grade,
          collected_at: row.collectedAt,
        }) as ReconciliationTransaction,
    );
  }

  private async feedbackByTransactionIds(transactionIds: string[]) {
    if (transactionIds.length === 0)
      return new Map<
        string,
        Awaited<ReturnType<typeof this.prisma.anomalyFeedback.findMany>>[number]
      >();
    const feedback = await this.prisma.anomalyFeedback.findMany({
      where: { transactionId: { in: transactionIds } },
      orderBy: { updatedAt: 'desc' },
    });
    return new Map(feedback.map((item) => [item.transactionId, item]));
  }

  private serializeAnomalyFeedback(
    feedback: Awaited<ReturnType<typeof this.prisma.anomalyFeedback.findMany>>[number] | null,
  ) {
    if (!feedback) return null;
    return {
      id: feedback.id,
      verdict: feedback.verdict,
      note: feedback.note,
      reviewer_user_id: feedback.reviewerUserId,
      risk_score_snapshot: feedback.riskScoreSnapshot,
      risk_level_snapshot: feedback.riskLevelSnapshot,
      reasons_snapshot: Array.isArray(feedback.reasonsSnapshot) ? feedback.reasonsSnapshot : [],
      created_at: feedback.createdAt.toISOString(),
      updated_at: feedback.updatedAt.toISOString(),
    };
  }

  private anomalyItem(
    transaction: ReconciliationTransaction,
    anomaly: ReconciliationAnomaly,
    feedback: Awaited<ReturnType<typeof this.prisma.anomalyFeedback.findMany>>[number] | null,
  ) {
    return {
      id: `anomaly:${transaction.id}`,
      transaction_id: transaction.id,
      merchant_id: transaction.merchant_id,
      merchant_name:
        typeof transaction.merchant_name === 'string'
          ? transaction.merchant_name
          : 'Quán chưa xác định',
      collector_name:
        typeof transaction.collector_name === 'string' ? transaction.collector_name : null,
      actual_liters: this.numberOrNull(transaction.liters) ?? 0,
      actual_kg: this.numberOrNull(transaction.kilograms),
      quality: transaction.quality,
      grade: transaction.grade ?? null,
      collected_at: new Date(transaction.collected_at).toISOString(),
      risk_score: anomaly.score,
      risk_level: anomaly.level,
      explanation_summary: anomaly.explanationSummary,
      reason_codes: anomaly.reasonDetails,
      history_size: anomaly.historySize,
      feedback: this.serializeAnomalyFeedback(feedback),
    };
  }

  async listAiAnomalies(query: AdminAiAnomalyListQueryInput) {
    const asOf = new Date();
    const windowStart = new Date(asOf.getTime() - query.window_days * DAY_MS);
    const candidates = await this.loadAnomalyCandidates(windowStart, asOf);
    const anomalyByTransactionId = await this.scoreAnomalyTransactions(candidates);
    const feedbackByTransaction = await this.feedbackByTransactionIds(
      candidates.map((candidate) => candidate.id),
    );
    const rows = candidates
      .filter((candidate) => {
        const anomaly = anomalyByTransactionId.get(candidate.id);
        return (
          anomaly &&
          anomaly.level !== 'NORMAL' &&
          (!query.risk_level || anomaly.level === query.risk_level)
        );
      })
      .filter(
        (candidate) =>
          !query.verdict || feedbackByTransaction.get(candidate.id)?.verdict === query.verdict,
      )
      .map((candidate) =>
        this.anomalyItem(
          candidate,
          anomalyByTransactionId.get(candidate.id)!,
          feedbackByTransaction.get(candidate.id) ?? null,
        ),
      );
    const offset = (query.page - 1) * query.limit;
    return {
      window_days: query.window_days as 30 | 90 | 180,
      data: rows.slice(offset, offset + query.limit),
      meta: { page: query.page, limit: query.limit, total: rows.length },
    };
  }

  async updateAiAnomalyFeedback(
    transactionId: string,
    body: AdminAiAnomalyFeedbackInput,
    reviewerUserId: string,
  ) {
    const transaction = await this.prisma.collectionTransaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        merchantId: true,
        actualLiters: true,
        actualKg: true,
        massSource: true,
        densityFactor: true,
        collectedAt: true,
      },
    });
    if (!transaction) throw new NotFoundException('Không tìm thấy giao dịch bất thường.');
    const candidate = {
      id: transaction.id,
      merchant_id: transaction.merchantId,
      liters: Number(transaction.actualLiters),
      kilograms: transaction.actualKg === null ? null : Number(transaction.actualKg),
      mass_source: transaction.massSource,
      density_factor: transaction.densityFactor === null ? null : Number(transaction.densityFactor),
      collected_at: transaction.collectedAt,
    } as ReconciliationTransaction;
    const anomaly = (await this.scoreAnomalyTransactions([candidate])).get(transaction.id);
    if (!anomaly) throw new BadRequestException('Không thể chấm điểm giao dịch này.');
    const reasonsSnapshot = JSON.parse(
      JSON.stringify(anomaly.reasonDetails),
    ) as Prisma.InputJsonValue;
    const saved = await this.prisma.anomalyFeedback.upsert({
      where: { transactionId },
      create: {
        transactionId,
        verdict: body.verdict,
        note: body.note ?? null,
        reviewerUserId,
        riskScoreSnapshot: anomaly.score,
        riskLevelSnapshot: anomaly.level,
        reasonsSnapshot,
      },
      update: {
        verdict: body.verdict,
        note: body.note ?? null,
        reviewerUserId,
        riskScoreSnapshot: anomaly.score,
        riskLevelSnapshot: anomaly.level,
        reasonsSnapshot,
      },
    });
    return this.serializeAnomalyFeedback(saved);
  }

  async aiAnomalyPerformance(query: AdminAiAnomalyPerformanceQueryInput) {
    const asOf = new Date();
    const windowStart = new Date(asOf.getTime() - query.window_days * DAY_MS);
    const candidates = await this.loadAnomalyCandidates(windowStart, asOf);
    const anomalyByTransactionId = await this.scoreAnomalyTransactions(candidates);
    const alertCandidates = candidates.filter(
      (candidate) => anomalyByTransactionId.get(candidate.id)?.level !== 'NORMAL',
    );
    const feedbackByTransaction = await this.feedbackByTransactionIds(
      alertCandidates.map((candidate) => candidate.id),
    );
    const items = alertCandidates.map((candidate) =>
      this.anomalyItem(
        candidate,
        anomalyByTransactionId.get(candidate.id)!,
        feedbackByTransaction.get(candidate.id) ?? null,
      ),
    );
    const reviewed = items.filter((item) => item.feedback !== null);
    const confirmedCount = reviewed.filter(
      (item) => item.feedback?.verdict === 'CONFIRMED_ANOMALY',
    ).length;
    const falsePositiveCount = reviewed.filter(
      (item) => item.feedback?.verdict === 'FALSE_POSITIVE',
    ).length;
    const unsureCount = reviewed.filter((item) => item.feedback?.verdict === 'UNSURE').length;
    const reviewedCount = reviewed.length;
    const reasonCounts = new Map<string, number>();
    for (const item of items)
      for (const reason of item.reason_codes)
        reasonCounts.set(reason.code, (reasonCounts.get(reason.code) ?? 0) + 1);
    return {
      window_days: query.window_days as 30 | 90 | 180,
      total_alerts: items.length,
      reviewed_count: reviewedCount,
      unreviewed_count: items.length - reviewedCount,
      feedback_coverage_percent:
        items.length === 0 ? 0 : Number(((reviewedCount / items.length) * 100).toFixed(2)),
      confirmed_count: confirmedCount,
      false_positive_count: falsePositiveCount,
      unsure_count: unsureCount,
      confirmed_rate_percent:
        reviewedCount === 0 ? null : Number(((confirmedCount / reviewedCount) * 100).toFixed(2)),
      false_positive_rate_percent:
        reviewedCount === 0
          ? null
          : Number(((falsePositiveCount / reviewedCount) * 100).toFixed(2)),
      breakdown_by_risk_level: (['NORMAL', 'REVIEW', 'HIGH_RISK'] as const).map((riskLevel) => ({
        risk_level: riskLevel,
        count: items.filter((item) => item.risk_level === riskLevel).length,
      })),
      breakdown_by_reason_code: [...reasonCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
      recent_reviewed_items: [...reviewed]
        .sort((left, right) =>
          (right.feedback?.updated_at ?? '').localeCompare(left.feedback?.updated_at ?? ''),
        )
        .slice(0, 10),
      explanation:
        'Các tỷ lệ chỉ được tính trên những cảnh báo đã được Admin đánh giá; UNSURE không được xem là kết luận đúng hoặc sai.',
    };
  }

  private withReconciliationAnomaly(
    transaction: Record<string, unknown>,
    anomalyByTransactionId: Map<string, ReconciliationAnomaly>,
  ) {
    const { merchant_id: merchantId, ...publicTransaction } = transaction;
    const id = typeof transaction.id === 'string' ? transaction.id : '';
    const anomaly = anomalyByTransactionId.get(id) ?? {
      ...scoreTransactionAnomaly([], {
        merchantId: typeof merchantId === 'string' ? merchantId : null,
        actualKg: this.numberOrNull(transaction.kilograms),
        actualLiters: this.numberOrNull(transaction.liters),
        massSource:
          transaction.mass_source === 'SCALE' || transaction.mass_source === 'ESTIMATED_FROM_VOLUME'
            ? transaction.mass_source
            : null,
        densityFactor: this.numberOrNull(transaction.density_factor),
        expectedDensityKgPerLiter: getDensityKgPerLiter(this.config),
        collectedAt:
          typeof transaction.collected_at === 'string' || transaction.collected_at instanceof Date
            ? transaction.collected_at
            : 'invalid-date',
      }),
      historySize: 0,
    };
    return { ...publicTransaction, anomaly };
  }

  private numberOrNull(value: unknown): number | null {
    const numeric =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isFinite(numeric) ? numeric : null;
  }

  async listAlerts(query: AdminAlertListQueryInput) {
    const includeFillForecastAlerts = query.type === undefined && query.resolved !== true;
    const [rows, fillForecastCandidates] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          id: string;
          type: string;
          severity: string | null;
          message: string | null;
          details: Prisma.JsonValue;
          created_at: Date;
          resolved_at: Date | null;
        }>
      >`
      SELECT a."id", a."type"::text AS "type", a."severity"::text AS "severity", a."message", a."details",
        a."created_at", a."resolved_at"
      FROM "alerts" a
      WHERE (${query.type ?? null}::text IS NULL OR a."type"::text = ${query.type ?? null})
        AND (${query.resolved ?? null}::boolean IS NULL OR (${query.resolved ?? null} AND a."resolved_at" IS NOT NULL) OR (NOT ${query.resolved ?? null} AND a."resolved_at" IS NULL))
      ORDER BY a."created_at" DESC
    `,
      includeFillForecastAlerts ? this.stations.listFillAlertCandidates() : Promise.resolve([]),
    ]);
    const persistedAlerts = rows.map((row) => this.serializeAlert(row));
    const seenStationIds = new Set<string>();
    const generatedAt = new Date();
    const forecastAlerts = fillForecastCandidates.flatMap((candidate) => {
      if (seenStationIds.has(candidate.station_id)) return [];
      seenStationIds.add(candidate.station_id);
      return [this.serializeStationFillAlert(candidate, generatedAt)];
    });
    const rankedAlerts = [...persistedAlerts, ...forecastAlerts]
      .map((alert, index) => ({ alert, index }))
      .sort((left, right) => {
        const rankDifference =
          this.alertSeverityRank(left.alert.severity) -
          this.alertSeverityRank(right.alert.severity);
        return rankDifference || left.index - right.index;
      })
      .map(({ alert }) => alert);
    const offset = (query.page - 1) * query.limit;
    return {
      data: rankedAlerts.slice(offset, offset + query.limit),
      meta: { page: query.page, limit: query.limit, total: rankedAlerts.length },
    };
  }

  async listStations(query: AdminStationListQueryInput) {
    const where: Prisma.StationWhereInput = {
      ...(query.ward_id ? { wardId: query.ward_id } : {}),
      ...(query.status
        ? { status: query.status }
        : query.include_inactive
          ? {}
          : { status: 'ACTIVE' }),
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
    const points = await this.prisma.getGeographyPoints(
      'stations',
      rows.map((row) => row.id),
    );
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
        fill_pct:
          Number(row.capacityLiters) > 0
            ? (Number(row.currentVolumeLiters) / Number(row.capacityLiters)) * 100
            : 0,
        status: row.status,
        ward: { id: row.ward.id, code: row.ward.code, name: row.ward.name },
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async reconciliationCsv(query: AdminReconciliationQueryInput) {
    const day = this.startOfDay(query.date);
    const nextDay = new Date(day.getTime() + DAY_MS);
    const rows = await this.prisma.$queryRaw<ReconciliationCsvRow[]>`
      WITH delivered_rows AS (
        SELECT
          sd."delivered_at" AS occurred_at,
          string_agg(DISTINCT m."business_name", ' | ' ORDER BY m."business_name") AS merchant_names,
          c."display_name" AS collector_name,
          s."name" AS station_name,
          sd."expected_kg"::float8 AS expected_kg,
          sd."actual_kg"::float8 AS actual_kg,
          sd."variance_kg"::float8 AS variance_kg,
          sd."variance_pct"::float8 AS variance_pct,
          sd."status"::text AS status
        FROM "station_deliveries" sd
        JOIN "collectors" c ON c."id" = sd."collector_id"
        JOIN "stations" s ON s."id" = sd."station_id"
        JOIN "collection_transactions" ct ON ct."station_delivery_id" = sd."id" AND ct."deleted_at" IS NULL
        JOIN "merchants" m ON m."id" = ct."merchant_id"
        WHERE sd."deleted_at" IS NULL
          AND sd."delivered_at" >= ${day}
          AND sd."delivered_at" < ${nextDay}
        GROUP BY sd."id", c."display_name", s."name"
      ),
      undelivered_rows AS (
        SELECT
          ct."collected_at" AS occurred_at,
          m."business_name" AS merchant_names,
          c."display_name" AS collector_name,
          NULL::text AS station_name,
          ct."actual_kg"::float8 AS expected_kg,
          NULL::float8 AS actual_kg,
          ct."actual_kg"::float8 AS variance_kg,
          CASE WHEN ct."actual_kg" > 0 THEN 1::float8 ELSE NULL::float8 END AS variance_pct,
          'CHƯA NỘP'::text AS status
        FROM "collection_transactions" ct
        JOIN "collectors" c ON c."id" = ct."collector_id"
        JOIN "merchants" m ON m."id" = ct."merchant_id"
        WHERE ct."deleted_at" IS NULL
          AND ct."station_delivery_id" IS NULL
          AND ct."collected_at" >= ${day}
          AND ct."collected_at" < ${nextDay}
      )
      SELECT * FROM delivered_rows
      UNION ALL
      SELECT * FROM undelivered_rows
      ORDER BY occurred_at, collector_name, merchant_names
    `;
    const header = [
      'Thời gian',
      'Quán',
      'Người thu gom',
      'Trạm',
      'Khối lượng dự kiến (kg)',
      'Khối lượng thực tế (kg)',
      'Chênh lệch (kg)',
      'Phần trăm chênh lệch',
      'Trạng thái',
    ];
    const records = rows.map((row) => [
      row.occurred_at.toISOString(),
      row.merchant_names,
      row.collector_name,
      row.station_name ?? 'Chưa nộp trạm',
      this.csvNumber(row.expected_kg, 3),
      this.csvNumber(row.actual_kg, 3),
      this.csvNumber(row.variance_kg, 3),
      row.variance_pct === null ? '' : `${(row.variance_pct * 100).toFixed(2)}%`,
      row.status,
    ]);
    const content = `\uFEFF${[header, ...records].map((record) => record.map((cell) => this.csvCell(cell)).join(',')).join('\r\n')}\r\n`;
    return { filename: `eco-oil-reconciliation-${day.toISOString().slice(0, 10)}.csv`, content };
  }

  async listMerchants(query: AdminMerchantListQueryInput) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        address: string | null;
        lat: number | null;
        lng: number | null;
        distance_m: number | null;
        status: string;
        approval_status: string;
        rejection_reason: string | null;
        business_type: string | null;
        phone: string | null;
        ward_code: string | null;
        ward_name: string | null;
        avg_daily_liters: number | null;
        last_collected_at: Date | null;
        anomaly: boolean;
        total: number;
      }>
    >`
      SELECT m."id", m."business_name" AS name, m."address", u."phone", w."code" AS ward_code, w."name" AS ward_name,
        ST_Y(m."location"::geometry)::float8 AS lat,
        ST_X(m."location"::geometry)::float8 AS lng,
        nearest.distance_m::float8 AS distance_m,
        m."status"::text AS status,
        m."approval_status"::text AS approval_status,
        m."rejection_reason",
        m."business_type",
        m."avg_daily_liters"::float8 AS avg_daily_liters,
        m."last_collected_at",
        EXISTS (
          SELECT 1 FROM "collection_transactions" ct
          WHERE ct."merchant_id" = m."id" AND ct."quality" = 'FLAG' AND ct."deleted_at" IS NULL
        ) AS anomaly,
        COUNT(*) OVER()::int AS total
      FROM "merchants" m
      JOIN "users" u ON u."id" = m."user_id"
      JOIN "wards" w ON w."id" = m."ward_id"
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
        AND (${query.status ?? null}::text IS NULL OR m."approval_status"::text = ${query.status ?? null})
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
        approval_status: row.approval_status as MerchantApprovalStatus,
        rejection_reason: row.rejection_reason,
        business_type: row.business_type,
        phone: row.phone,
        ward_code: row.ward_code,
        ward_name: row.ward_name,
        avg_daily_liters: row.avg_daily_liters === null ? null : Number(row.avg_daily_liters),
        last_collected_at: row.last_collected_at,
        anomaly: row.anomaly,
      })),
      meta: { page: query.page, limit: query.limit, total: Number(rows[0]?.total ?? 0) },
    };
  }

  async listCollectors(query: AdminCollectorListQueryInput) {
    const where: Prisma.CollectorWhereInput = {
      ...(query.ward_id ? { collectorWards: { some: { wardId: query.ward_id } } } : {}),
      ...(query.status
        ? { status: query.status }
        : query.include_inactive
          ? {}
          : { status: 'ACTIVE' }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.collector.findMany({
        where,
        orderBy: { displayName: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          user: true,
          collectorWards: { include: { ward: true }, orderBy: { createdAt: 'asc' } },
        },
      }),
      this.prisma.collector.count({ where }),
    ]);
    const now = Date.now();
    const redis = this.redis;
    const activeCodes = await Promise.all(
      rows.map(async (row) => {
        if (
          !redis ||
          row.linkStatus !== 'PENDING_LINK' ||
          !row.inviteCodeHash ||
          !row.inviteExpiresAt ||
          row.inviteExpiresAt.getTime() <= now
        )
          return null;
        try {
          const code = await redis.getValue(COLLECTOR_ACTIVE_INVITE_KEY_PREFIX + row.id);
          return code && this.hashInviteCode(code) === row.inviteCodeHash ? code : null;
        } catch {
          return null;
        }
      }),
    );
    return {
      data: rows.map((row, index) => ({
        id: row.id,
        display_name: row.displayName,
        status: row.status,
        is_active: row.isActive,
        link_status: row.linkStatus,
        invite_status:
          row.linkStatus === 'PENDING_LINK'
            ? row.inviteExpiresAt && row.inviteExpiresAt.getTime() > now
              ? 'PENDING'
              : 'EXPIRED'
            : null,
        invite_expires_at: row.inviteExpiresAt?.toISOString() ?? null,
        invite_url: activeCodes[index] ? this.collectorInviteUrl(activeCodes[index]) : null,
        last_seen_at: row.lastSeenAt,
        wards: row.collectorWards.map((item) => ({
          id: item.ward.id,
          code: item.ward.code,
          name: item.ward.name,
        })),
        contact_phone: row.contactPhone,
        user: row.user ? { id: row.user.id, name: row.user.name, phone: row.user.phone } : null,
        vehicle_type: row.vehicleType,
        max_capacity_l: Number(row.maxCapacityLiters),
        ward_ids: row.collectorWards.map((item) => item.wardId),
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async collectorPerformance(id: string) {
    const collector = await this.prisma.collector.findUnique({
      where: { id },
      select: { id: true, displayName: true },
    });
    if (!collector) {
      throw new NotFoundException('Collector not found');
    }
    const threshold = Number(
      this.config.get<number | string>('DELIVERY_VARIANCE_THRESHOLD_PCT', 0.02),
    );
    const rows = await this.prisma.$queryRaw<
      Array<{
        liters_7d: number;
        collections_7d: number;
        delivered_liters_7d: number;
      }>
    >`
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
      throw new ConflictException({
        code: 'ALERT_ALREADY_RESOLVED',
        message: 'Alert is already resolved',
        details: { id },
      });
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
    const rows = await this.prisma.$queryRaw<
      Array<{
        merchant_id: string;
        total_liters: number;
        collection_count: number;
        avg_daily_liters: number | null;
        last_collected_at: Date | null;
        flagged_count: number;
      }>
    >`
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

  async approveMerchant(id: string, actorUserId: string, input: MerchantApprovalInput = {}) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
      include: { ward: true },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');
    const storedPoint = await this.prisma.getGeographyPoint('merchants', id);
    const lat = input.lat ?? storedPoint?.lat;
    const lng = input.lng ?? storedPoint?.lng;
    if (lat === undefined || lng === undefined || lat === null || lng === null) {
      throw new BadRequestException({
        code: 'MERCHANT_LOCATION_REQUIRED',
        message: 'Cần nhập tọa độ thực của quán trước khi duyệt',
        details: { lat, lng },
      });
    }
    if (this.isKnownDefaultLocation(lat, lng)) {
      throw new BadRequestException({
        code: 'MERCHANT_LOCATION_REQUIRED',
        message: 'Tọa độ hiện tại là tọa độ mặc định, cần thay bằng vị trí thực của quán',
        details: { lat, lng },
      });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "merchants"
        SET "location" = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
        WHERE "id" = ${id}::uuid
      `;
      const row = await tx.merchant.update({
        where: { id },
        data: { approvalStatus: MerchantApprovalStatus.APPROVED, rejectionReason: null },
      });
      if (merchant.ward.centerLat !== null && merchant.ward.centerLng !== null) {
        const distanceRows = await tx.$queryRaw<Array<{ distance_m: number }>>`
          SELECT ST_Distance(
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
            ST_SetSRID(ST_MakePoint(${merchant.ward.centerLng}, ${merchant.ward.centerLat}), 4326)::geography
          ) AS distance_m
        `;
        const distanceM = Number(distanceRows[0]?.distance_m ?? 0);
        if (distanceM > 20000) {
          await tx.alert.create({
            data: {
              type: AlertType.WARD_LOCATION_MISMATCH,
              severity: AlertSeverity.HIGH,
              message: 'Tọa độ quán cách xa tâm phường được gán hơn 20 km',
              details: {
                merchant_id: id,
                ward_id: merchant.wardId,
                distance_m: distanceM,
                threshold_m: 20000,
              },
            },
          });
        }
      }
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'APPROVE_MERCHANT',
          entityType: 'Merchant',
          entityId: id,
          details: {},
        },
      });
      return row;
    });
    return this.merchantProfile(updated.id);
  }

  private isKnownDefaultLocation(lat: number, lng: number) {
    return Math.abs(lat - 10.7769) < 0.000001 && Math.abs(lng - 106.7009) < 0.000001;
  }

  async rejectMerchant(id: string, actorUserId: string, input: MerchantRejectInput) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id } });
    if (!merchant) throw new NotFoundException('Merchant not found');
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.merchant.update({
        where: { id },
        data: { approvalStatus: MerchantApprovalStatus.REJECTED, rejectionReason: input.reason },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'REJECT_MERCHANT',
          entityType: 'Merchant',
          entityId: id,
          details: { reason: input.reason },
        },
      });
      return row;
    });
    return this.merchantProfile(updated.id);
  }

  async listContainers(query: AdminContainerListQueryInput) {
    const where: Prisma.ContainerWhereInput = {
      ...(query.state ? { state: query.state } : {}),
      ...(query.merchant_id ? { merchantId: query.merchant_id } : {}),
      ...(query.unassigned ? { merchantId: null } : {}),
      ...(query.include_inactive ? {} : { status: EntityStatus.ACTIVE }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.container.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { merchant: true },
      }),
      this.prisma.container.count({ where }),
    ]);
    return {
      data: rows.map((row) => this.serializeAdminContainer(row)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async listWards(query: AdminWardListQueryInput = { include_inactive: true }) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        code: string;
        name: string;
        district: string;
        city: string;
        center_lat: number | null;
        center_lng: number | null;
        status: string;
        is_active: boolean;
        merchant_count: number;
        container_count: number;
        collector_count: number;
      }>
    >`
      SELECT w."id", w."code", w."name", w."district", w."city",
        w."center_lat", w."center_lng", w."status"::text AS "status", w."is_active",
        (SELECT COUNT(*)::int FROM "merchants" m WHERE m."ward_id" = w."id" AND m."status" = 'ACTIVE' AND m."deleted_at" IS NULL) AS "merchant_count",
        (SELECT COUNT(*)::int FROM "containers" c WHERE c."ward_id" = w."id" AND c."status" = 'ACTIVE' AND c."deleted_at" IS NULL) AS "container_count",
        (SELECT COUNT(DISTINCT c."id")::int FROM "collectors" c JOIN "collector_wards" cw ON cw."collector_id" = c."id" WHERE cw."ward_id" = w."id" AND c."status" = 'ACTIVE' AND c."deleted_at" IS NULL) AS "collector_count"
      FROM "wards" w
      WHERE w."deleted_at" IS NULL
        AND (${query.include_inactive}::boolean OR (w."status" = 'ACTIVE' AND w."is_active" = true))
      ORDER BY w."code" ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      code: normalizeWardCode(row.code),
      name: row.name,
      district: row.district,
      city: row.city,
      center_lat: row.center_lat === null ? null : Number(row.center_lat),
      center_lng: row.center_lng === null ? null : Number(row.center_lng),
      status: row.status as EntityStatus,
      is_active: row.is_active,
      merchant_count: Number(row.merchant_count),
      container_count: Number(row.container_count),
      collector_count: Number(row.collector_count),
    }));
  }

  async createWard(input: AdminWardCreateInput, actorUserId: string) {
    const existing = await this.prisma.ward.findUnique({ where: { code: input.code } });
    if (existing && existing.deletedAt === null) {
      throw new ConflictException({
        code: 'WARD_CODE_ALREADY_EXISTS',
        message: 'Mã phường đã tồn tại',
        details: { code: input.code },
      });
    }
    const ward = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ward.create({
        data: {
          code: input.code,
          name: input.name,
          district: input.district,
          city: input.city,
          centerLat: input.center_lat,
          centerLng: input.center_lng,
          status: EntityStatus.ACTIVE,
          isActive: true,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'CREATE_WARD',
          entityType: 'Ward',
          entityId: created.id,
          details: { code: created.code },
        },
      });
      return created;
    });
    return (await this.listWards({ include_inactive: true })).find((item) => item.id === ward.id);
  }

  async updateWard(id: string, input: AdminWardPatchInput, actorUserId: string) {
    const existing = await this.prisma.ward.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new NotFoundException('Ward not found');
    const disabling = input.status === EntityStatus.INACTIVE || input.is_active === false;
    if (disabling) {
      const activeMerchants = await this.prisma.merchant.count({
        where: { wardId: id, status: EntityStatus.ACTIVE, deletedAt: null },
      });
      if (activeMerchants > 0) {
        throw new ConflictException({
          code: 'WARD_HAS_ACTIVE_MERCHANTS',
          message: 'Không thể tắt phường vì còn quán đang hoạt động',
          details: { active_merchants: activeMerchants },
        });
      }
    }
    if (input.code && input.code !== existing.code) {
      const duplicate = await this.prisma.ward.findUnique({ where: { code: input.code } });
      if (duplicate && duplicate.id !== id && duplicate.deletedAt === null)
        throw new ConflictException({
          code: 'WARD_CODE_ALREADY_EXISTS',
          message: 'Mã phường đã tồn tại',
          details: { code: input.code },
        });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.ward.update({
        where: { id },
        data: {
          ...(input.code !== undefined ? { code: input.code } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.district !== undefined ? { district: input.district } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.center_lat !== undefined ? { centerLat: input.center_lat } : {}),
          ...(input.center_lng !== undefined ? { centerLng: input.center_lng } : {}),
          ...(input.status !== undefined
            ? {
                status: input.status,
                isActive: input.status === EntityStatus.ACTIVE,
                deletedAt: input.status === EntityStatus.INACTIVE ? new Date() : null,
              }
            : {}),
          ...(input.is_active !== undefined && input.status === undefined
            ? {
                isActive: input.is_active,
                status: input.is_active ? EntityStatus.ACTIVE : EntityStatus.INACTIVE,
                deletedAt: input.is_active ? null : new Date(),
              }
            : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'UPDATE_WARD',
          entityType: 'Ward',
          entityId: id,
          details: input,
        },
      });
    });
    return (await this.listWards({ include_inactive: true })).find((item) => item.id === id);
  }

  async getContainer(id: string) {
    const row = await this.prisma.container.findUnique({
      where: { id },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException('Container not found');
    return this.serializeAdminContainer(row);
  }

  async createContainer(input: AdminContainerCreateInput, actorUserId: string) {
    const ward = await this.findWard(input.ward_id, input.ward_code);
    if (!ward)
      throw new NotFoundException({
        code: 'WARD_NOT_FOUND',
        message: 'Không tìm thấy phường đã chọn',
        details: null,
      });
    const qrCode = input.qr_code ?? (await this.nextAdminQrCode(ward.code));
    const duplicate = await this.prisma.container.findUnique({ where: { qrCode } });
    if (duplicate)
      throw new ConflictException({
        code: 'QR_CODE_ALREADY_EXISTS',
        message: 'Mã QR đã tồn tại',
        details: { qr_code: qrCode },
      });
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.container.create({
        data: {
          qrCode,
          capacityLiters: input.capacity_liters,
          state: 'AT_MERCHANT',
          merchantId: null,
          wardId: ward.id,
        },
        include: { merchant: true },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'CREATE_CONTAINER',
          entityType: 'Container',
          entityId: created.id,
          details: {
            qr_code: qrCode,
            ward_code: ward.code,
            capacity_liters: input.capacity_liters,
          },
        },
      });
      return created;
    });
    return this.serializeAdminContainer(row);
  }

  async assignContainer(id: string, input: ContainerAssignInput, actorUserId: string) {
    const [container, merchant] = await Promise.all([
      this.prisma.container.findUnique({ where: { id }, include: { merchant: true } }),
      this.prisma.merchant.findUnique({ where: { id: input.merchant_id } }),
    ]);
    if (!container) throw new NotFoundException('Container not found');
    if (!merchant || merchant.status === EntityStatus.INACTIVE)
      throw new NotFoundException('Merchant not found');
    if (container.merchantId && container.merchantId !== merchant.id) {
      throw new ConflictException({
        code: 'CONTAINER_ALREADY_ASSIGNED',
        message: 'Can đang thuộc quán khác',
        details: { merchant_id: container.merchantId },
      });
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.container.update({
        where: { id },
        data: {
          merchantId: merchant.id,
          state: 'AT_MERCHANT',
          status: 'ACTIVE',
          isActive: true,
          deletedAt: null,
        },
        include: { merchant: true },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'ASSIGN_CONTAINER',
          entityType: 'Container',
          entityId: id,
          details: { merchant_id: merchant.id },
        },
      });
      return updated;
    });
    return this.serializeAdminContainer(row);
  }

  async unassignContainer(id: string, actorUserId: string) {
    const container = await this.prisma.container.findUnique({
      where: { id },
      include: { merchant: true },
    });
    if (!container) throw new NotFoundException('Container not found');
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.container.update({
        where: { id },
        data: { merchantId: null, state: 'AT_MERCHANT' },
        include: { merchant: true },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'UNASSIGN_CONTAINER',
          entityType: 'Container',
          entityId: id,
          details: { previous_merchant_id: container.merchantId },
        },
      });
      return updated;
    });
    return this.serializeAdminContainer(row);
  }

  async returnContainerToMerchant(
    id: string,
    input: AdminContainerReturnInput,
    actorUserId: string,
  ) {
    const row = await this.prisma.$transaction(async (tx) => {
      const container = await tx.container.findUnique({
        where: { id },
        include: { merchant: true },
      });
      if (!container) throw new NotFoundException('Container not found');
      if (container.state !== 'AT_STATION') {
        throw new BadRequestException({
          code: 'CONTAINER_NOT_AT_STATION',
          message: 'Can không ở tại trạm nên không thể trả về quán',
          details: { state: container.state },
        });
      }

      const merchantId = input.merchant_id ?? container.merchantId;
      if (!merchantId) {
        throw new BadRequestException({
          code: 'MERCHANT_REQUIRED',
          message: 'Cần chọn quán nhận can trước khi trả can',
          details: null,
        });
      }

      const merchant = await tx.merchant.findUnique({ where: { id: merchantId } });
      if (
        !merchant ||
        merchant.approvalStatus !== MerchantApprovalStatus.APPROVED ||
        merchant.status === EntityStatus.INACTIVE
      ) {
        throw new BadRequestException({
          code: 'MERCHANT_NOT_APPROVED',
          message: 'Quán nhận can chưa được duyệt hoặc không còn hoạt động',
          details: { merchant_id: merchantId },
        });
      }

      const before = { state: container.state, merchant_id: container.merchantId };
      const after = { state: 'AT_MERCHANT', merchant_id: merchant.id };
      const updated = await tx.container.update({
        where: { id },
        data: { state: 'AT_MERCHANT', merchantId: merchant.id, lastSeenAt: new Date() },
        include: { merchant: true },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'RETURN_CONTAINER',
          entityType: 'Container',
          entityId: id,
          details: { before, after, note: input.note ?? null },
        },
      });
      return updated;
    });
    return this.serializeAdminContainer(row);
  }

  async cancelContainerTransit(
    id: string,
    input: AdminContainerCancelTransitInput,
    actorUserId: string,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const container = await tx.container.findUnique({
        where: { id },
        include: { merchant: true },
      });
      if (!container) throw new NotFoundException('Container not found');
      if (container.state !== 'IN_TRANSIT') {
        throw new BadRequestException({
          code: 'CONTAINER_NOT_IN_TRANSIT',
          message: 'Can không ở trạng thái đang vận chuyển',
          details: { state: container.state },
        });
      }
      if (!container.merchantId || !container.merchant) {
        throw new BadRequestException({
          code: 'MERCHANT_REQUIRED',
          message: 'Can đang vận chuyển chưa được gắn với quán',
          details: null,
        });
      }

      const pendingTransactions = await tx.collectionTransaction.findMany({
        where: { containerId: id, stationDeliveryId: null, deletedAt: null },
        select: { id: true },
      });
      const affectedTransactionIds = pendingTransactions.map((transaction) => transaction.id);
      const before = { state: container.state, merchant_id: container.merchantId };
      const after = {
        state: 'AT_MERCHANT',
        merchant_id: container.merchantId,
        note: input.note ?? null,
        affected_transaction_ids: affectedTransactionIds,
      };
      const updated = await tx.container.update({
        where: { id },
        data: { state: 'AT_MERCHANT', lastSeenAt: new Date() },
        include: { merchant: true },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'CANCEL_TRANSIT',
          entityType: 'Container',
          entityId: id,
          details: { before, after },
        },
      });
      await tx.alert.create({
        data: {
          type: AlertType.CONTAINER_TRANSIT_CANCELLED,
          severity: AlertSeverity.MEDIUM,
          message: `Đã huỷ ca vận chuyển can ${container.qrCode} của quán ${container.merchant.businessName}; ${affectedTransactionIds.length} giao dịch chưa nộp trạm.`,
          details: {
            container_id: id,
            qr_code: container.qrCode,
            merchant_id: container.merchantId,
            merchant_name: container.merchant.businessName,
            affected_transaction_ids: affectedTransactionIds,
            note: input.note ?? null,
          },
        },
      });
      return { updated, affectedTransactionIds };
    });
    return {
      ...this.serializeAdminContainer(result.updated),
      affected_transaction_ids: result.affectedTransactionIds,
    };
  }

  private async nextAdminQrCode(wardCode: string) {
    const prefix = containerQrPrefix(wardCode);
    const rows = await this.prisma.container.findMany({
      where: { qrCode: { startsWith: prefix } },
      select: { qrCode: true },
    });
    const max = rows.reduce((highest, row) => {
      const suffix = Number(row.qrCode.slice(prefix.length));
      return Number.isInteger(suffix) && suffix > highest ? suffix : highest;
    }, 0);
    return buildContainerQrCode(wardCode, max + 1);
  }

  private async findWard(wardId?: string, wardCode?: string) {
    if (wardId)
      return this.prisma.ward.findFirst({
        where: { id: wardId, deletedAt: null, status: EntityStatus.ACTIVE, isActive: true },
      });
    if (!wardCode) return null;
    const normalized = normalizeWardCode(wardCode);
    const wards = await this.prisma.ward.findMany({
      where: { deletedAt: null, status: EntityStatus.ACTIVE, isActive: true },
    });
    return wards.find((ward) => wardLookupKey(ward.code) === wardLookupKey(normalized)) ?? null;
  }

  private serializeAdminContainer(row: {
    id: string;
    qrCode: string;
    state: string;
    status: string;
    capacityLiters: Prisma.Decimal | null;
    lastSeenAt: Date | null;
    merchant: { id: string; businessName: string; address: string | null } | null;
  }) {
    return {
      id: row.id,
      qr_code: row.qrCode,
      state: row.state,
      status: row.status,
      capacity_liters: row.capacityLiters === null ? null : Number(row.capacityLiters),
      last_seen_at: row.lastSeenAt,
      merchant: row.merchant
        ? { id: row.merchant.id, name: row.merchant.businessName, address: row.merchant.address }
        : null,
    };
  }

  async createCollector(input: AdminCollectorCreateInput) {
    const wards = await this.prisma.ward.findMany({
      where: { id: { in: input.ward_ids }, deletedAt: null },
    });
    if (wards.length !== input.ward_ids.length) throw new NotFoundException('Ward not found');
    const collectorId = randomUUID();
    const inviteCode = randomBytes(32).toString('base64url');
    const inviteCodeHash = this.hashInviteCode(inviteCode);
    const inviteExpiresAt = new Date(Date.now() + COLLECTOR_INVITE_TTL_SECONDS * 1000);
    const inviteKey = COLLECTOR_INVITE_KEY_PREFIX + inviteCodeHash;
    const inviteUrl = this.collectorInviteUrl(inviteCode);
    const redis = this.requiredRedis();
    await redis.setOneTime(inviteKey, collectorId, COLLECTOR_INVITE_TTL_SECONDS);
    try {
      await redis.setExpiring(
        COLLECTOR_ACTIVE_INVITE_KEY_PREFIX + collectorId,
        inviteCode,
        COLLECTOR_INVITE_TTL_SECONDS,
      );
      await this.prisma.collector.create({
        data: {
          id: collectorId,
          userId: null,
          displayName: input.name,
          contactPhone: input.phone,
          vehicleType: input.vehicle_type,
          maxCapacityLiters: input.max_capacity_l,
          linkStatus: 'PENDING_LINK',
          inviteCodeHash,
          inviteExpiresAt,
          collectorWards: { create: input.ward_ids.map((wardId) => ({ wardId })) },
        },
      });
    } catch (error) {
      await redis.deleteOneTime(inviteKey).catch(() => undefined);
      await redis
        .deleteOneTime(COLLECTOR_ACTIVE_INVITE_KEY_PREFIX + collectorId)
        .catch(() => undefined);
      throw error;
    }
    return {
      collector: await this.collectorProfile(collectorId),
      invite_url: inviteUrl,
      invite_expires_at: inviteExpiresAt.toISOString(),
    };
  }

  async regenerateCollectorInvite(id: string) {
    const existing = await this.prisma.collector.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        linkStatus: true,
        status: true,
        isActive: true,
        inviteCodeHash: true,
      },
    });
    if (!existing) throw new NotFoundException('Collector not found');
    if (existing.userId || existing.linkStatus === 'LINKED') {
      throw new ConflictException({
        code: 'COLLECTOR_ALREADY_LINKED',
        message: 'Người thu gom đã liên kết Zalo',
        details: null,
      });
    }
    if (!existing.isActive || existing.status !== EntityStatus.ACTIVE) {
      throw new ForbiddenException({
        code: 'COLLECTOR_LOCKED',
        message: 'Người thu gom đã bị khóa',
        details: null,
      });
    }

    const inviteCode = randomBytes(32).toString('base64url');
    const inviteCodeHash = this.hashInviteCode(inviteCode);
    const inviteExpiresAt = new Date(Date.now() + COLLECTOR_INVITE_TTL_SECONDS * 1000);
    const inviteKey = COLLECTOR_INVITE_KEY_PREFIX + inviteCodeHash;
    const inviteUrl = this.collectorInviteUrl(inviteCode);
    const redis = this.requiredRedis();
    await redis.setOneTime(inviteKey, id, COLLECTOR_INVITE_TTL_SECONDS);
    try {
      await redis.setExpiring(
        COLLECTOR_ACTIVE_INVITE_KEY_PREFIX + id,
        inviteCode,
        COLLECTOR_INVITE_TTL_SECONDS,
      );
      await this.prisma.collector.update({
        where: { id },
        data: { linkStatus: 'PENDING_LINK', inviteCodeHash, inviteExpiresAt },
      });
    } catch (error) {
      await redis.deleteOneTime(inviteKey).catch(() => undefined);
      await redis.deleteOneTime(COLLECTOR_ACTIVE_INVITE_KEY_PREFIX + id).catch(() => undefined);
      throw error;
    }
    if (existing.inviteCodeHash) {
      await redis
        .deleteOneTime(COLLECTOR_INVITE_KEY_PREFIX + existing.inviteCodeHash)
        .catch(() => undefined);
    }
    return {
      collector: await this.collectorProfile(id),
      invite_url: inviteUrl,
      invite_expires_at: inviteExpiresAt.toISOString(),
    };
  }

  async updateCollector(id: string, input: AdminCollectorPatchInput) {
    const collector = await this.prisma.collector.findUnique({ where: { id } });
    if (!collector) throw new NotFoundException('Collector not found');
    if (input.ward_ids) {
      const wards = await this.prisma.ward.findMany({
        where: { id: { in: input.ward_ids }, deletedAt: null },
      });
      if (wards.length !== input.ward_ids.length) throw new NotFoundException('Ward not found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.collector.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { displayName: input.name } : {}),
          ...(input.vehicle_type !== undefined ? { vehicleType: input.vehicle_type } : {}),
          ...(input.max_capacity_l !== undefined
            ? { maxCapacityLiters: input.max_capacity_l }
            : {}),
          ...(!collector.userId && input.phone !== undefined ? { contactPhone: input.phone } : {}),
          ...(input.status !== undefined
            ? {
                status: input.status,
                isActive: input.status === EntityStatus.ACTIVE,
                deletedAt: input.status === EntityStatus.INACTIVE ? new Date() : null,
              }
            : {}),
        },
      });
      if (collector.userId && (input.name !== undefined || input.phone !== undefined)) {
        await tx.user.update({
          where: { id: collector.userId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
          },
        });
      }
      if (input.ward_ids) {
        await tx.collectorWard.createMany({
          data: input.ward_ids.map((wardId) => ({ collectorId: id, wardId })),
          skipDuplicates: true,
        });
      }
    });
    return this.collectorProfile(id);
  }

  private async merchantProfile(id: string) {
    const row = await this.prisma.merchant.findUnique({
      where: { id },
      include: { user: true, ward: true },
    });
    if (!row) throw new NotFoundException('Merchant not found');
    const point = await this.prisma.getGeographyPoint('merchants', id);
    return {
      id: row.id,
      name: row.businessName,
      address: row.address,
      business_type: row.businessType,
      phone: row.user.phone,
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      status: row.status,
      approval_status: row.approvalStatus,
      rejection_reason: row.rejectionReason,
      ward: { id: row.ward.id, code: row.ward.code, name: row.ward.name },
    };
  }

  private async collectorProfile(id: string) {
    const row = await this.prisma.collector.findUnique({
      where: { id },
      include: {
        user: true,
        collectorWards: { include: { ward: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('Collector not found');
    return {
      id: row.id,
      display_name: row.displayName,
      vehicle_type: row.vehicleType,
      max_capacity_l: Number(row.maxCapacityLiters),
      status: row.status,
      is_active: row.isActive,
      link_status: row.linkStatus,
      invite_status:
        row.linkStatus === 'PENDING_LINK'
          ? row.inviteExpiresAt && row.inviteExpiresAt.getTime() > Date.now()
            ? 'PENDING'
            : 'EXPIRED'
          : null,
      invite_expires_at: row.inviteExpiresAt?.toISOString() ?? null,
      last_seen_at: row.lastSeenAt,
      contact_phone: row.contactPhone,
      wards: row.collectorWards.map((item) => ({
        id: item.ward.id,
        code: item.ward.code,
        name: item.ward.name,
      })),
      ward_ids: row.collectorWards.map((item) => item.wardId),
      user: row.user ? { id: row.user.id, name: row.user.name, phone: row.user.phone } : null,
    };
  }

  private hashInviteCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private requiredRedis(): RedisService {
    if (!this.redis)
      throw new ServiceUnavailableException({
        code: 'COLLECTOR_INVITE_UNAVAILABLE',
        message: 'Không tạo được lời mời người thu gom',
        details: null,
      });
    return this.redis;
  }

  private collectorInviteUrl(code: string): string {
    const rawBaseUrl = this.config.get<string>('ZALO_OAUTH_SUCCESS_REDIRECT_URL')?.trim();
    if (!rawBaseUrl) {
      throw new ServiceUnavailableException({
        code: 'COLLECTOR_INVITE_URL_NOT_CONFIGURED',
        message: 'Chưa cấu hình địa chỉ Mini App cho lời mời',
        details: null,
      });
    }
    try {
      const url = new URL(rawBaseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
      url.searchParams.set('collector_invite', code);
      return url.toString();
    } catch {
      throw new ServiceUnavailableException({
        code: 'COLLECTOR_INVITE_URL_NOT_CONFIGURED',
        message: 'Địa chỉ Mini App cho lời mời không hợp lệ',
        details: null,
      });
    }
  }

  private period(fromInput?: Date, toInput?: Date) {
    const now = new Date();
    const today = this.startOfDay(now);
    const from = fromInput ? this.startOfDay(fromInput) : new Date(today.getTime() - 29 * DAY_MS);
    const to = toInput
      ? new Date(this.startOfDay(toInput).getTime() + DAY_MS)
      : new Date(today.getTime() + DAY_MS);
    return { from, to };
  }

  private startOfDay(value: Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  private csvNumber(value: number | null, digits: number): string {
    return value === null ? '' : Number(value).toFixed(digits);
  }

  private csvCell(value: unknown): string {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
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

  private serializeStationFillAlert(candidate: StationFillAlertCandidate, generatedAt: Date) {
    return {
      id: `station-fill:${candidate.station_id}`,
      type: 'STATION_FILL_FORECAST',
      severity: candidate.severity,
      message: candidate.message,
      details: {
        station_id: candidate.station_id,
        station_name: candidate.station_name,
        forecast_status: candidate.forecast_status,
        estimated_days_until_full: candidate.estimated_days_until_full,
        reason_codes: [...candidate.reason_codes],
        trigger: candidate.trigger,
        storage_age_days: candidate.storage_age_days,
        max_storage_days: candidate.max_storage_days,
      },
      created_at: generatedAt,
      resolved_at: null,
      dynamic: true,
    };
  }

  private alertSeverityRank(severity: string | null): number {
    if (severity === AlertSeverity.HIGH) return 0;
    if (severity === AlertSeverity.MEDIUM) return 1;
    return 2;
  }
}
