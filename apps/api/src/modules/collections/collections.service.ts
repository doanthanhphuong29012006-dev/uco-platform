import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertSeverity, AlertType, ContainerState, EntityStatus, MassSource, OilGrade, OrderStatus, Quality } from '@prisma/client';
import type { GradeDecisionSource, ImageGradeConfidence } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { CollectionCreateInput, CollectionListQueryInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import { getDensityKgPerLiter } from '../../config/mass.constants';
import type { AccessTokenPayload } from '../auth/auth.types';

type InsertedTransaction = {
  id: string;
  client_uuid: string;
  order_id: string | null;
  container_id: string;
  merchant_id: string;
  collector_id: string;
  actual_liters: number;
  actual_kg: number;
  mass_source: MassSource;
  density_factor: number | null;
  grade: OilGrade | null;
  grade_photo_url: string | null;
  grade_note: string | null;
  suspected_adulteration: boolean;
  image_grade_suggestion: OilGrade | null;
  image_grade_confidence: ImageGradeConfidence | null;
  image_grade_model_version: string | null;
  image_grade_analysis: Prisma.JsonValue | null;
  grade_decision_source: GradeDecisionSource | null;
  grade_ai_override_acknowledged: boolean;
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
  actual_kg: number;
  mass_source: MassSource;
  density_factor: number | null;
  grade: OilGrade | null;
  grade_photo_url: string | null;
  grade_note: string | null;
  suspected_adulteration: boolean;
  image_grade_suggestion: OilGrade | null;
  image_grade_confidence: ImageGradeConfidence | null;
  image_grade_model_version: string | null;
  image_grade_analysis: Prisma.JsonValue | null;
  grade_decision_source: GradeDecisionSource | null;
  grade_ai_override_acknowledged: boolean;
  quality: Quality;
  photos: Prisma.JsonValue;
  collected_at: Date;
  created_at: Date;
  container_code: string;
  geo_lat: number | null;
  geo_lng: number | null;
};

const COLLECTION_LITERS_DEVIATION_THRESHOLD_PCT = 0.3;

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
      if (originalOrderStatus === OrderStatus.ASSIGNED && order.collectorId !== collector.id) {
        throw new ForbiddenException({
          code: 'ORDER_ASSIGNED_TO_OTHER_COLLECTOR',
          message: 'Đơn đã được giao cho người thu gom khác',
          details: { order_id: order.id },
        });
      }
      if (!order.containerId || !order.container || order.container.qrCode !== input.container_code) {
        throw new ConflictException({ code: 'CONTAINER_MISMATCH', message: 'Container does not match order', details: { order_id: order.id } });
      }
      const densityFactor = getDensityKgPerLiter(this.config);
      const hasLiters = input.actual_liters !== undefined && input.actual_liters > 0;
      const hasKilograms = input.actual_kg !== undefined && input.actual_kg > 0;
      if ((input.actual_liters !== undefined && input.actual_liters < 0) || (input.actual_kg !== undefined && input.actual_kg < 0) || (!hasLiters && !hasKilograms)) {
        throw new UnprocessableEntityException({
          code: 'INVALID_MASS_INPUT',
          message: 'Vui lòng nhập số kg hoặc số lít lớn hơn 0',
          details: null,
        });
      }
      const actualLiters = hasLiters ? input.actual_liters as number : (input.actual_kg as number) / densityFactor;
      const actualKg = hasKilograms ? input.actual_kg as number : actualLiters * densityFactor;
      const litersDerivedFromKilograms = !hasLiters && hasKilograms;
      const capacity = Number(order.container.capacityLiters ?? 0);
      if (actualLiters > capacity * 1.1) {
        throw new UnprocessableEntityException({
          code: 'INVALID_LITERS',
          message: litersDerivedFromKilograms
            ? `Số lít suy ra từ khối lượng (${actualLiters.toFixed(2)} lít) vượt dung tích cho phép ${ (capacity * 1.1).toFixed(1) } lít`
            : `Số lít phải lớn hơn 0 và không vượt quá dung tích can ${capacity} lít`,
          details: { capacity_l: capacity, max_liters: capacity * 1.1, derived_from_kg: litersDerivedFromKilograms },
        });
      }
      if (input.quality === Quality.FLAG && input.photos.length === 0) {
        throw new UnprocessableEntityException({
          code: 'PHOTO_REQUIRED_FOR_FLAG',
          message: 'At least one photo is required when quality is FLAG',
          details: null,
        });
      }

      const gradePhotoUrl = input.grade_photo_url ?? input.photos[0] ?? null;
      const gradeRequiresPhoto = input.grade === OilGrade.B || input.grade === OilGrade.C || input.suspected_adulteration;
      if (gradeRequiresPhoto && !gradePhotoUrl) {
        throw new UnprocessableEntityException({
          code: 'PHOTO_REQUIRED_FOR_GRADE',
          message: 'Hạng B, hạng C hoặc nghi ngờ pha lẫn bắt buộc phải có ít nhất 1 ảnh.',
          details: { grade: input.grade, suspected_adulteration: input.suspected_adulteration },
        });
      }

      const decisionSource = input.grade_decision_source ?? 'MANUAL';
      const imageSuggestion = input.image_grade_suggestion ?? null;
      const imageConfidence = input.image_grade_confidence ?? null;
      const imageAnalysis = input.image_grade_analysis ?? null;
      if (imageAnalysis && (imageAnalysis.suggested_grade !== imageSuggestion || imageAnalysis.confidence !== imageConfidence)) {
        throw new UnprocessableEntityException({
          code: 'IMAGE_GRADE_METADATA_INCONSISTENT',
          message: 'Thông tin phân tích ảnh không khớp với gợi ý phân hạng.',
          details: null,
        });
      }
      if (decisionSource === 'AI_SUGGESTION_ACCEPTED' && imageSuggestion !== input.grade) {
        throw new UnprocessableEntityException({
          code: 'IMAGE_GRADE_DECISION_INVALID',
          message: 'Phân hạng được chấp nhận phải khớp với gợi ý từ ảnh.',
          details: null,
        });
      }
      if (decisionSource === 'MANUAL_OVERRIDE_AI' && (!imageSuggestion || imageSuggestion === input.grade)) {
        throw new UnprocessableEntityException({
          code: 'IMAGE_GRADE_DECISION_INVALID',
          message: 'Ghi đè gợi ý ảnh cần có gợi ý khác với phân hạng đã chọn.',
          details: null,
        });
      }
      if (decisionSource === 'MANUAL_OVERRIDE_AI' && (imageConfidence === 'HIGH' || imageConfidence === 'MEDIUM') && input.grade_ai_override_acknowledged !== true) {
        throw new UnprocessableEntityException({
          code: 'IMAGE_GRADE_OVERRIDE_ACK_REQUIRED',
          message: 'Cần xác nhận khi giữ phân hạng khác với gợi ý ảnh có độ tin cậy trung bình hoặc cao.',
          details: null,
        });
      }

      const massSource = hasKilograms ? MassSource.SCALE : MassSource.ESTIMATED_FROM_VOLUME;
      const storedDensityFactor = !hasLiters || !hasKilograms ? densityFactor : null;

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
            , "synced_at", "actual_kg", "mass_source", "density_factor", "grade", "grade_photo_url", "grade_note", "suspected_adulteration", "image_grade_suggestion", "image_grade_confidence", "image_grade_model_version", "image_grade_analysis", "grade_decision_source", "grade_ai_override_acknowledged"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${input.client_uuid},
            ${input.order_id}::uuid,
            ${order.containerId}::uuid,
            ${order.merchantId}::uuid,
            ${collector.id}::uuid,
            ${actualLiters},
            ${effectiveQuality}::"Quality",
            ST_SetSRID(ST_MakePoint(${input.geo.lng}, ${input.geo.lat}), 4326)::geography,
            ${JSON.stringify(input.photos)}::jsonb,
            ${collectedAt},
            now(),
            ${synced ? new Date() : null},
            ${actualKg},
            ${massSource}::"MassSource",
            ${storedDensityFactor},
            ${input.grade}::"OilGrade",
            ${gradePhotoUrl},
            ${input.grade_note ?? null},
            ${input.suspected_adulteration}
            , ${imageSuggestion}::"OilGrade"
            , ${imageConfidence}::"ImageGradeConfidence"
            , ${input.image_grade_model_version ?? null}
            , ${imageAnalysis ? JSON.stringify(imageAnalysis) : null}::jsonb
            , ${decisionSource}::"GradeDecisionSource"
            , ${input.grade_ai_override_acknowledged === true}
          )
          ON CONFLICT ("client_uuid") DO NOTHING
          RETURNING *
        )
        SELECT inserted."id", inserted."client_uuid", inserted."order_id", inserted."container_id",
          inserted."merchant_id", inserted."collector_id", inserted."actual_liters"::float8 AS "actual_liters",
          inserted."actual_kg"::float8 AS "actual_kg", inserted."mass_source"::text AS "mass_source", inserted."density_factor"::float8 AS "density_factor",
          inserted."grade"::text AS "grade", inserted."grade_photo_url", inserted."grade_note", inserted."suspected_adulteration",
           inserted."quality"::text AS "quality", inserted."photos", inserted."collected_at", inserted."created_at",
           inserted."image_grade_suggestion"::text AS "image_grade_suggestion", inserted."image_grade_confidence"::text AS "image_grade_confidence", inserted."image_grade_model_version", inserted."image_grade_analysis", inserted."grade_decision_source"::text AS "grade_decision_source", inserted."grade_ai_override_acknowledged",
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
      const activeRouteStop = await tx.collectionRouteStop.findFirst({
        where: {
          orderId: order.id,
          status: 'PENDING',
          route: { collectorId: collector.id, status: 'ACTIVE' },
        },
      });
      if (activeRouteStop) {
        await tx.collectionRouteStop.update({
          where: { id: activeRouteStop.id },
          data: { status: 'COLLECTED', collectedAt },
        });
      }

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
          avgDailyLiters: averageRows[0]?.averageLiters ?? actualLiters,
        },
      });

      if (geoMismatch) {
        await tx.alert.create({
          data: {
            transactionId: transaction.id,
            type: AlertType.GEO_MISMATCH,
            severity: AlertSeverity.HIGH,
            message: 'Collection geo point is outside merchant mismatch threshold',
            details: { distance_m: distanceM, threshold_m: threshold },
          },
        });
      }
      const expectedLiters = Number(order.expectedLiters ?? 0);
      if (expectedLiters > 0) {
        const deviationPct = Math.abs(actualLiters - expectedLiters) / expectedLiters;
        if (deviationPct > COLLECTION_LITERS_DEVIATION_THRESHOLD_PCT) {
          await tx.alert.create({
            data: {
              transactionId: transaction.id,
              type: AlertType.COLLECTION_LITERS_DEVIATION,
              severity: AlertSeverity.MEDIUM,
              message: `Merchant reported ${expectedLiters} L; collector recorded ${actualLiters} L; deviation ${(deviationPct * 100).toFixed(1)}%.`,
              details: {
                expected_liters: expectedLiters,
                actual_liters: actualLiters,
                deviation_pct: deviationPct,
                threshold_pct: COLLECTION_LITERS_DEVIATION_THRESHOLD_PCT,
              },
            },
          });
        }
      }
      if (massSource === MassSource.ESTIMATED_FROM_VOLUME) {
        await tx.alert.create({
          data: {
            transactionId: transaction.id,
            type: AlertType.MASS_ESTIMATED_NOT_WEIGHED,
            severity: AlertSeverity.LOW,
            message: `Giao dịch chưa được cân: ${actualLiters.toFixed(2)} lít được quy đổi thành ${actualKg.toFixed(2)} kg với hệ số ${densityFactor} kg/lít.`,
            details: { actual_liters: actualLiters, actual_kg: actualKg, density_factor: densityFactor },
          },
        });
      }
      if (input.suspected_adulteration) {
        await tx.alert.create({
          data: {
            transactionId: transaction.id,
            type: AlertType.SUSPECTED_ADULTERATION,
            severity: AlertSeverity.HIGH,
            message: `Nghi ngờ pha lẫn tại quán ${order.merchant.businessName}: ${actualKg.toFixed(2)} kg, hạng ${input.grade}.`,
            details: { merchant_id: order.merchantId, actual_kg: actualKg, grade: input.grade },
          },
        });
      }
      if (input.grade === OilGrade.C) {
        await tx.alert.create({
          data: {
            transactionId: transaction.id,
            type: AlertType.OIL_GRADE_C,
            severity: AlertSeverity.MEDIUM,
            message: `Dầu hạng C tại quán ${order.merchant.businessName}: ${actualKg.toFixed(2)} kg.`,
            details: { merchant_id: order.merchantId, actual_kg: actualKg, grade: input.grade },
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
          ct."actual_liters"::float8 AS "actual_liters", ct."actual_kg"::float8 AS "actual_kg", ct."mass_source"::text AS "mass_source", ct."density_factor"::float8 AS "density_factor", ct."grade"::text AS "grade", ct."grade_photo_url", ct."grade_note", ct."suspected_adulteration", ct."image_grade_suggestion"::text AS "image_grade_suggestion", ct."image_grade_confidence"::text AS "image_grade_confidence", ct."image_grade_model_version", ct."image_grade_analysis", ct."grade_decision_source"::text AS "grade_decision_source", ct."grade_ai_override_acknowledged", ct."quality"::text AS "quality", ct."photos",
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
        ct."actual_liters"::float8 AS "actual_liters", ct."actual_kg"::float8 AS "actual_kg", ct."mass_source"::text AS "mass_source", ct."density_factor"::float8 AS "density_factor", ct."grade"::text AS "grade", ct."grade_photo_url", ct."grade_note", ct."suspected_adulteration", ct."image_grade_suggestion"::text AS "image_grade_suggestion", ct."image_grade_confidence"::text AS "image_grade_confidence", ct."image_grade_model_version", ct."image_grade_analysis", ct."grade_decision_source"::text AS "grade_decision_source", ct."grade_ai_override_acknowledged", ct."quality"::text AS "quality", ct."photos",
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
        ct."actual_liters"::float8 AS "actual_liters", ct."actual_kg"::float8 AS "actual_kg", ct."mass_source"::text AS "mass_source", ct."density_factor"::float8 AS "density_factor", ct."grade"::text AS "grade", ct."grade_photo_url", ct."grade_note", ct."suspected_adulteration", ct."image_grade_suggestion"::text AS "image_grade_suggestion", ct."image_grade_confidence"::text AS "image_grade_confidence", ct."image_grade_model_version", ct."image_grade_analysis", ct."grade_decision_source"::text AS "grade_decision_source", ct."grade_ai_override_acknowledged", ct."quality"::text AS "quality", ct."photos",
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
      actual_kg: Number(row.actual_kg),
      mass_source: row.mass_source,
      density_factor: row.density_factor === null ? null : Number(row.density_factor),
      grade: row.grade,
      grade_photo_url: row.grade_photo_url,
      grade_note: row.grade_note,
      suspected_adulteration: row.suspected_adulteration,
      image_grade_suggestion: row.image_grade_suggestion,
      image_grade_confidence: row.image_grade_confidence,
      image_grade_model_version: row.image_grade_model_version,
      image_grade_analysis: row.image_grade_analysis,
      grade_decision_source: row.grade_decision_source,
      grade_ai_override_acknowledged: row.grade_ai_override_acknowledged,
      quality: row.quality,
      geo: row.geo_lat === null || row.geo_lng === null ? null : { lat: row.geo_lat, lng: row.geo_lng },
      photos: row.photos,
      collected_at: row.collected_at,
      created_at: row.created_at,
    };
  }
}
