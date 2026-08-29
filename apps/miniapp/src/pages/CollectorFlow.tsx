import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ContainerState, DEFAULT_DENSITY_KG_PER_LITER, Quality } from '@eco-oil/shared-types';
import type { OilGrade } from '@eco-oil/shared-types';
import type { CollectionCreateRequest, ContainerLookupResponse, CurrentRouteResponse, GeoPoint, OilImageAnalysisPayload, RouteStop } from '@eco-oil/shared-types';
import { ApiError, api } from '../lib/api';
import { formatLiters } from '../lib/formatters';
import { getLatestStationReceipt, retryOutbox, type OutboxRecord, type StoredStationReceipt } from '../lib/outbox-db';
import { useOnlineStatus, useOutboxRows, useOutboxStats } from '../lib/outbox-hooks';
import { loadRouteWithCache, lookupContainerWithCache, prefetchRouteData, type RouteLoadResult } from '../lib/offline-cache';
import { enqueueCollection } from '../lib/outbox-db';
import { startOutboxSyncWorker, syncOutbox } from '../lib/outbox-sync';
import { outboxErrorMessage } from '../lib/outbox-errors';
import { submitContainerCode } from '../lib/container-code';
import { pendingStationDeliveryStorage } from '../lib/storage';
import type { PendingStationDeliveryDraft } from '../lib/storage';
import { isValidGeoPoint, isZaloPermissionDenied, zaloClient } from '../lib/zalo-client';
import type { PhotoAsset } from '../lib/zalo-client';
import { compressImageBlob } from '../lib/zalo-client';
import { pickZaloPhoto } from '../lib/media-picker';
import { analyzeOilImages, type OilImageAnalysis } from '../lib/oil-image-analyzer';
import { StatusView } from '../components/StatusView';
import { OilGradeSelector } from '../components/OilGradeSelector';
import { GradePhotoPicker, isGradePhotoMissing } from '../components/GradePhotoPicker';
import { useAuthStore } from '../stores/auth-store';
import { StationDeliveryFlow } from './StationDeliveryFlow';

type CollectorScreen =
  | { name: 'route' }
  | { name: 'qr'; stop: RouteStop }
  | { name: 'entry'; stop: RouteStop; container: ContainerLookupResponse; containerCode: string }
  | { name: 'summary' }
  | { name: 'station-delivery' }
  | { name: 'receipt-view' }
  | { name: 'outbox' };

export interface CompletedStop {
  liters: number;
  kilograms: number | null;
  clientUuid: string;
  stop: RouteStop;
}

export interface ReconciledRouteProgress {
  completed: Record<string, CompletedStop>;
  completedOrderIds: string[];
  skippedOrderIds: string[];
}

function completedStopFromOutbox(row: OutboxRecord, stop: RouteStop): CompletedStop {
  const payload = row.payload as Partial<CollectionCreateRequest>;
  const kilograms = typeof payload.actual_kg === 'number' && Number.isFinite(payload.actual_kg) ? payload.actual_kg : null;
  const liters = typeof payload.actual_liters === 'number' && Number.isFinite(payload.actual_liters)
    ? payload.actual_liters
    : kilograms === null ? 0 : kilograms / DEFAULT_DENSITY_KG_PER_LITER;
  return { liters, kilograms, clientUuid: row.client_uuid, stop };
}

export function reconcileRouteProgress(
  route: CurrentRouteResponse,
  storedCompleted: Record<string, CompletedStop>,
  storedRouteId: string | undefined,
  outboxRows: OutboxRecord[],
): ReconciledRouteProgress {
  const completed: Record<string, CompletedStop> = {};
  const completedOrderIds = new Set<string>();
  const skippedOrderIds = new Set<string>();
  const canUseStoredCompleted = route.route_id
    ? storedRouteId === route.route_id
    : storedRouteId === undefined;

  for (const stop of route.stops) {
    if (stop.route_stop_status === 'SKIPPED') {
      skippedOrderIds.add(stop.order_id);
      continue;
    }
    if (stop.route_stop_status === 'COLLECTED') {
      completedOrderIds.add(stop.order_id);
    }

    const stored = canUseStoredCompleted ? storedCompleted[stop.order_id] : undefined;
    const outbox = outboxRows.find((row) => {
      if (row.type !== 'collection') return false;
      const payload = row.payload as Partial<CollectionCreateRequest>;
      return payload.order_id === stop.order_id && ['pending', 'syncing', 'synced', 'failed'].includes(row.status);
    });
    if (stored) {
      completed[stop.order_id] = stored;
      completedOrderIds.add(stop.order_id);
    } else if (outbox) {
      completed[stop.order_id] = completedStopFromOutbox(outbox, stop);
      completedOrderIds.add(stop.order_id);
    }
  }

  if (canUseStoredCompleted) {
    for (const [orderId, stored] of Object.entries(storedCompleted)) {
      if (skippedOrderIds.has(orderId) || completed[orderId]) continue;
      completed[orderId] = stored;
      completedOrderIds.add(orderId);
    }
  }

  return { completed, completedOrderIds: [...completedOrderIds], skippedOrderIds: [...skippedOrderIds] };
}

const PICKUP_PRIORITY_LEVELS = {
  URGENT: { label: 'Khẩn cấp', className: 'urgent' },
  HIGH: { label: 'Ưu tiên cao', className: 'high' },
  NORMAL: { label: 'Bình thường', className: 'normal' },
  LOW: { label: 'Ưu tiên thấp', className: 'low' },
  INSUFFICIENT_DATA: { label: 'Chưa đủ dữ liệu', className: 'insufficient' },
} as const;

const PICKUP_PRIORITY_REASONS: Record<string, string> = {
  MISSING_FILL_DATA: 'Thiếu dữ liệu mức đầy',
  NEAR_FULL: 'Can gần đầy',
  HIGH_FILL: 'Mức đầy cao',
  MEDIUM_FILL: 'Mức đầy trung bình',
  MISSING_COLLECTION_HISTORY: 'Chưa có lịch sử thu gom',
  OVERDUE_COLLECTION: 'Đã quá lâu chưa thu',
  WAITING_LONG: 'Đã chờ lâu',
  MISSING_DISTANCE: 'Thiếu dữ liệu khoảng cách',
  NEARBY: 'Điểm thu ở gần',
  ALREADY_SCHEDULED: 'Đã có lịch thu gom',
};

const PICKUP_VOLUME_CONFIDENCE: Record<string, { label: string; className: string }> = {
  HIGH: { label: 'Tin cậy cao', className: 'high' },
  MEDIUM: { label: 'Tin cậy trung bình', className: 'medium' },
  LOW: { label: 'Tin cậy thấp', className: 'low' },
  INSUFFICIENT_DATA: { label: 'Chưa đủ dữ liệu', className: 'insufficient' },
};

const PICKUP_VOLUME_REASONS: Record<string, string> = {
  HISTORY_WEIGHTED: 'Dựa trên lịch sử gần đây',
  DECLARED_ESTIMATE_BLEND: 'Kết hợp số quán khai',
  DECLARED_ESTIMATE_ONLY: 'Tạm tính theo số quán khai',
  LIMITED_HISTORY: 'Ít dữ liệu lịch sử',
  STABLE_HISTORY: 'Sản lượng khá ổn định',
  VOLATILE_HISTORY: 'Sản lượng biến động',
  PREDICTION_CAPPED_TO_CAPACITY: 'Không vượt dung tích can',
};

export function pickupPriorityLevelLabel(level: string): string | null {
  return PICKUP_PRIORITY_LEVELS[level as keyof typeof PICKUP_PRIORITY_LEVELS]?.label ?? null;
}

export function pickupPriorityReasonLabel(reasonCode: string): string {
  return PICKUP_PRIORITY_REASONS[reasonCode] ?? reasonCode;
}

export interface PickupVolumeForecastDisplay {
  predictedLiters: number | null;
  confidenceLabel: string;
  className: string;
  sampleSize: number | null;
  declaredOnly: boolean;
  reasons: string[];
}

function isValidForecastLiters(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validSampleSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function formatPickupVolumeLiters(value: unknown): string | null {
  if (!isValidForecastLiters(value)) return null;
  return `${value.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} lít`;
}

export function getPickupVolumeForecastDisplay(stop: RouteStop): PickupVolumeForecastDisplay | null {
  const candidate = (stop as RouteStop & { pickup_volume_forecast?: unknown }).pickup_volume_forecast;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;

  const metadata = candidate as {
    predicted_liters?: unknown;
    confidence?: unknown;
    sample_size?: unknown;
    reason_codes?: unknown;
  };
  const declaredOnly = Array.isArray(metadata.reason_codes) && metadata.reason_codes.includes('DECLARED_ESTIMATE_ONLY');
  const confidence = declaredOnly ? PICKUP_VOLUME_CONFIDENCE.LOW : PICKUP_VOLUME_CONFIDENCE[String(metadata.confidence)] ?? PICKUP_VOLUME_CONFIDENCE.INSUFFICIENT_DATA;
  const reasons = Array.isArray(metadata.reason_codes)
    ? [...new Set(metadata.reason_codes.filter((reason): reason is string => typeof reason === 'string').map((reason) => PICKUP_VOLUME_REASONS[reason]).filter((reason): reason is string => Boolean(reason)))].slice(0, 2)
    : [];

  return {
    predictedLiters: isValidForecastLiters(metadata.predicted_liters) ? metadata.predicted_liters : null,
    confidenceLabel: confidence.label,
    className: confidence.className,
    sampleSize: validSampleSize(metadata.sample_size),
    declaredOnly,
    reasons,
  };
}

export type PickupVolumeDeviationLevel = 'NORMAL' | 'REVIEW' | 'HIGH';

export type PickupVolumeDeviationResult = {
  level: PickupVolumeDeviationLevel;
  predicted_liters: number;
  actual_liters: number;
  deviation_liters: number;
  deviation_pct: number;
};

export function evaluatePickupVolumeDeviation(stop: RouteStop, actualLiters: unknown): PickupVolumeDeviationResult | null {
  const candidate = (stop as RouteStop & { pickup_volume_forecast?: unknown }).pickup_volume_forecast;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const metadata = candidate as { predicted_liters?: unknown; confidence?: unknown; reason_codes?: unknown };
  const predictedLiters = metadata.predicted_liters;
  const confidence = metadata.confidence;
  const reasonCodes = Array.isArray(metadata.reason_codes) ? metadata.reason_codes : [];
  if (!isValidForecastLiters(predictedLiters) || predictedLiters <= 0) return null;
  if (!isValidForecastLiters(actualLiters)) return null;
  if (confidence !== 'HIGH' && confidence !== 'MEDIUM') return null;
  if (reasonCodes.includes('DECLARED_ESTIMATE_ONLY')) return null;

  const deviationLiters = actualLiters - predictedLiters;
  const deviationPct = Math.abs(deviationLiters) / predictedLiters;
  if (!Number.isFinite(deviationLiters) || !Number.isFinite(deviationPct)) return null;
  const level: PickupVolumeDeviationLevel = deviationPct <= 0.2 ? 'NORMAL' : deviationPct <= 0.35 ? 'REVIEW' : 'HIGH';
  return {
    level,
    predicted_liters: predictedLiters,
    actual_liters: actualLiters,
    deviation_liters: deviationLiters,
    deviation_pct: deviationPct,
  };
}

function formatDeviationPercent(value: number): string {
  return `${(value * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
}

function formatSignedDeviationLiters(value: number): string {
  const formatted = Math.abs(value).toLocaleString('vi-VN', { maximumFractionDigits: 1 });
  return `${value >= 0 ? '+' : '-'}${formatted} lít`;
}

export function getPickupVolumeDeviationKey(deviation: PickupVolumeDeviationResult | null): string | null {
  return deviation?.level === 'HIGH'
    ? `${deviation.predicted_liters}:${deviation.actual_liters}:${deviation.deviation_pct}`
    : null;
}

export function requiresPickupVolumeAcknowledgement(
  deviation: PickupVolumeDeviationResult | null,
  acknowledgementKey: string | null,
): boolean {
  const key = getPickupVolumeDeviationKey(deviation);
  return key !== null && key !== acknowledgementKey;
}

const IMAGE_GRADE_CONFIDENCE_LABELS: Record<OilImageAnalysis['confidence'], string> = {
  HIGH: 'Tin cậy cao',
  MEDIUM: 'Tin cậy trung bình',
  LOW: 'Tin cậy thấp',
};

const IMAGE_GRADE_LABELS: Record<'A' | 'B' | 'C', string> = {
  A: 'Hạng A',
  B: 'Hạng B',
  C: 'Hạng C',
};

const IMAGE_GRADE_REASON_LABELS: Partial<Record<string, string>> = {
  LIGHT_CLEAR_APPEARANCE: 'Màu sáng và khá trong',
  MEDIUM_BROWN_APPEARANCE: 'Màu nâu trung bình',
  DARK_APPEARANCE: 'Màu sẫm',
  HIGH_TEXTURE_OR_SEDIMENT: 'Kết cấu/cặn nổi bật',
  LOW_TEXTURE: 'Ít kết cấu nhìn thấy',
  IMAGE_TOO_DARK: 'Ảnh quá tối',
  IMAGE_OVEREXPOSED: 'Ảnh quá sáng',
  IMAGE_TOO_BLURRY: 'Ảnh có thể bị mờ',
  IMAGE_TOO_SMALL: 'Ảnh quá nhỏ',
  MULTIPLE_IMAGES_DISAGREE: 'Các ảnh cho tín hiệu khác nhau',
  INSUFFICIENT_IMAGE_SIGNAL: 'Tín hiệu hình ảnh chưa đủ',
};

export interface ImageGradeAnalysisDisplay {
  suggestedGrade: string | null;
  confidenceLabel: string;
  qualityLabel: string;
  reasons: string[];
  summary: string;
  canUseSuggestion: boolean;
}

export function getImageGradeAnalysisDisplay(analysis: OilImageAnalysis | null | undefined): ImageGradeAnalysisDisplay | null {
  if (!analysis) return null;
  const reasons = [...new Set(analysis.reason_codes.map((code) => IMAGE_GRADE_REASON_LABELS[code]).filter((label): label is string => Boolean(label)))].slice(0, 3);
  return {
    suggestedGrade: analysis.suggested_grade ? IMAGE_GRADE_LABELS[analysis.suggested_grade] : null,
    confidenceLabel: IMAGE_GRADE_CONFIDENCE_LABELS[analysis.confidence],
    qualityLabel: analysis.quality_status === 'USABLE' ? 'Ảnh có thể dùng' : analysis.quality_status === 'RETAKE_RECOMMENDED' ? 'Nên chụp lại nếu có thể' : 'Chưa hỗ trợ phân tích ảnh này',
    reasons,
    summary: analysis.summary,
    canUseSuggestion: analysis.suggested_grade !== null && analysis.quality_status !== 'UNSUPPORTED',
  };
}

type RouteOptimizationMetadata = NonNullable<CurrentRouteResponse['route_optimization']>;

export interface RouteOptimizationDisplay {
  title: string;
  message: string;
  detail: string | null;
  tone: 'success' | 'neutral' | 'warning';
}

function isSafeDistance(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function formatRouteOptimizationDistance(value: unknown): string | null {
  if (!isSafeDistance(value)) return null;
  if (value < 1_000) return `${Math.round(value).toLocaleString('vi-VN')} m`;
  return `${(value / 1_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} km`;
}

export function getRouteOptimizationDisplay(metadata: RouteOptimizationMetadata | null | undefined): RouteOptimizationDisplay | null {
  if (!metadata || metadata.reason_codes.includes('INSUFFICIENT_STOPS')) return null;

  const hasInvalidCoordinates = metadata.reason_codes.includes('INVALID_STOP_COORDINATES') || metadata.reason_codes.includes('INVALID_ORIGIN');
  if (hasInvalidCoordinates) {
    return {
      title: 'Đã ưu tiên điểm thu gom',
      message: 'Chưa thể ước tính đầy đủ quãng đường',
      detail: null,
      tone: 'warning',
    };
  }

  if (metadata.reason_codes.includes('ALREADY_OPTIMAL')) {
    return {
      title: 'Tuyến hiện tại đã tối ưu',
      message: 'Không cần thay đổi thứ tự điểm',
      detail: null,
      tone: 'success',
    };
  }

  if (!metadata.optimization_applied) return null;
  const savedDistance = formatRouteOptimizationDistance(metadata.saved_distance_m);
  const before = formatRouteOptimizationDistance(metadata.estimated_distance_before_m);
  const after = formatRouteOptimizationDistance(metadata.estimated_distance_after_m);
  if (isSafeDistance(metadata.saved_distance_m) && metadata.saved_distance_m > 0 && savedDistance) {
    return {
      title: 'AI đã tối ưu tuyến',
      message: `Tiết kiệm khoảng ${savedDistance}`,
      detail: before && after ? `${before} → ${after}` : null,
      tone: 'success',
    };
  }

  return {
    title: 'AI đã sắp xếp lại tuyến',
    message: 'Thứ tự điểm đã được tối ưu theo mức ưu tiên',
    detail: before && after ? `${before} → ${after}` : null,
    tone: 'success',
  };
}

type RouteCapacityRiskLevel = 'OVER_CAPACITY' | 'NEAR_CAPACITY' | 'BALANCED' | 'UNDERUTILIZED' | 'INSUFFICIENT_DATA';
type RouteCapacityRiskConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';

const ROUTE_CAPACITY_RISK_LEVELS: Record<RouteCapacityRiskLevel, { title: string; tone: 'danger' | 'warning' | 'success' | 'neutral' | 'insufficient' }> = {
  OVER_CAPACITY: { title: 'Nguy cơ quá tải', tone: 'danger' },
  NEAR_CAPACITY: { title: 'Xe có thể gần đầy', tone: 'warning' },
  BALANCED: { title: 'Tải xe hợp lý', tone: 'success' },
  UNDERUTILIZED: { title: 'Xe còn nhiều chỗ trống', tone: 'neutral' },
  INSUFFICIENT_DATA: { title: 'Chưa đủ dữ liệu đánh giá tải xe', tone: 'insufficient' },
};

const ROUTE_CAPACITY_RISK_CONFIDENCE: Record<RouteCapacityRiskConfidence, string> = {
  HIGH: 'Tin cậy cao',
  MEDIUM: 'Tin cậy trung bình',
  LOW: 'Tin cậy thấp',
  INSUFFICIENT_DATA: 'Chưa đủ dữ liệu',
};

export interface RouteCapacityRiskDisplay {
  level: RouteCapacityRiskLevel;
  title: string;
  tone: 'danger' | 'warning' | 'success' | 'neutral' | 'insufficient';
  utilizationPct: number | null;
  riskAdjustedTotalLiters: number | null;
  riskAdjustedRemainingLiters: number | null;
  vehicleCapacityLiters: number | null;
  confidenceLabel: string;
  coveragePct: number | null;
  message: string | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function formatRouteCapacityRiskLiters(value: unknown): string | null {
  if (!isNonNegativeFinite(value)) return null;
  return `${value.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} lít`;
}

export function getRouteCapacityRiskDisplay(
  metadata: CurrentRouteResponse['route_capacity_risk'] | null | undefined,
  vehicleCapacityLiters: unknown,
): RouteCapacityRiskDisplay | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const reasonCodes = Array.isArray(metadata.reason_codes) ? metadata.reason_codes : [];
  if (reasonCodes.includes('NO_STOPS')) return null;

  const rawLevel = metadata.level as RouteCapacityRiskLevel;
  const level = Object.prototype.hasOwnProperty.call(ROUTE_CAPACITY_RISK_LEVELS, rawLevel) ? rawLevel : 'INSUFFICIENT_DATA';
  const levelDisplay = ROUTE_CAPACITY_RISK_LEVELS[level];
  const confidence = metadata.confidence as RouteCapacityRiskConfidence;
  const confidenceLabel = ROUTE_CAPACITY_RISK_CONFIDENCE[confidence] ?? ROUTE_CAPACITY_RISK_CONFIDENCE.INSUFFICIENT_DATA;
  const coveragePct = isNonNegativeFinite(metadata.forecast_coverage_pct) && metadata.forecast_coverage_pct <= 100
    ? Math.round(metadata.forecast_coverage_pct)
    : null;
  const validVehicleCapacity = isFiniteNumber(vehicleCapacityLiters) && vehicleCapacityLiters > 0 ? vehicleCapacityLiters : null;
  const validRiskTotal = isNonNegativeFinite(metadata.risk_adjusted_total_liters) ? metadata.risk_adjusted_total_liters : null;
  const validRiskRemaining = isFiniteNumber(metadata.risk_adjusted_remaining_liters) ? metadata.risk_adjusted_remaining_liters : null;
  const validUtilization = isNonNegativeFinite(metadata.risk_utilization_pct) ? Math.round(metadata.risk_utilization_pct) : null;
  const hasValidMetrics = validVehicleCapacity !== null && validRiskTotal !== null && validRiskRemaining !== null && validUtilization !== null;

  if (level !== 'INSUFFICIENT_DATA' && !hasValidMetrics) {
    return {
      level: 'INSUFFICIENT_DATA',
      title: ROUTE_CAPACITY_RISK_LEVELS.INSUFFICIENT_DATA.title,
      tone: ROUTE_CAPACITY_RISK_LEVELS.INSUFFICIENT_DATA.tone,
      utilizationPct: null,
      riskAdjustedTotalLiters: null,
      riskAdjustedRemainingLiters: null,
      vehicleCapacityLiters: null,
      confidenceLabel: ROUTE_CAPACITY_RISK_CONFIDENCE.INSUFFICIENT_DATA,
      coveragePct,
      message: null,
    };
  }

  let message: string | null = null;
  if (level === 'OVER_CAPACITY' && validRiskRemaining !== null && validRiskRemaining < 0) {
    message = `Có thể vượt tải khoảng ${formatRouteCapacityRiskLiters(Math.abs(validRiskRemaining))}`;
  } else if (level === 'NEAR_CAPACITY' && validRiskRemaining !== null && validRiskRemaining >= 0) {
    message = `Còn khoảng ${formatRouteCapacityRiskLiters(validRiskRemaining)} dự phòng`;
  } else if (level === 'BALANCED') {
    message = 'Tuyến đang sử dụng sức chứa ở mức phù hợp';
  } else if (level === 'UNDERUTILIZED' && validRiskRemaining !== null && validRiskRemaining >= 0) {
    message = `Còn khoảng ${formatRouteCapacityRiskLiters(validRiskRemaining)} sức chứa`;
  }

  return {
    level,
    title: levelDisplay.title,
    tone: levelDisplay.tone,
    utilizationPct: validUtilization,
    riskAdjustedTotalLiters: validRiskTotal,
    riskAdjustedRemainingLiters: validRiskRemaining,
    vehicleCapacityLiters: validVehicleCapacity,
    confidenceLabel,
    coveragePct,
    message,
  };
}

export interface RouteRefreshNotice {
  kind: 'success' | 'cache' | 'warning' | 'error';
  message: string;
}

export interface RouteRefreshResult {
  data?: RouteLoadResult;
  error?: unknown;
  gpsFallback?: boolean;
  gpsUpdated?: boolean;
}

export function getRouteRefreshNotice(
  result: RouteRefreshResult,
  updatedAt: Date = new Date(),
): RouteRefreshNotice {
  if (result.error || !result.data) {
    return { kind: 'error', message: 'Không thể tải lại tuyến. Vui lòng kiểm tra mạng và thử lại.' };
  }
  if (result.gpsFallback) {
    return { kind: 'warning', message: 'Chưa lấy được GPS, tuyến đang dùng vị trí trung tâm phường.' };
  }
  if (result.data.fromCache) {
    return { kind: 'cache', message: 'Không kết nối được máy chủ, đang dùng tuyến đã lưu.' };
  }
  if (result.gpsUpdated) {
    return { kind: 'success', message: `Đã cập nhật GPS và tuyến lúc ${formatTime(updatedAt.toISOString())}` };
  }
  return { kind: 'success', message: `Đã cập nhật tuyến lúc ${formatTime(updatedAt.toISOString())}` };
}

export interface LocationAttemptResult {
  point: GeoPoint | null;
  failed: boolean;
  error?: unknown;
}

export interface CollectionLocationResult {
  point: GeoPoint | null;
  usedFallback: boolean;
}

export const COLLECTION_LOCATION_TIMEOUT_MS = 2_500;

export async function resolveCollectionLocation(
  getLocation: () => Promise<GeoPoint | null>,
  fallback: GeoPoint | null,
  timeoutMs = COLLECTION_LOCATION_TIMEOUT_MS,
): Promise<CollectionLocationResult> {
  const point = await new Promise<GeoPoint | null>((resolve) => {
    let settled = false;
    const finish = (value: GeoPoint | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value && isValidGeoPoint(value) ? value : null);
    };
    const timer = globalThis.setTimeout(() => finish(null), timeoutMs);
    void getLocation().then(finish, () => finish(null));
  });

  if (point) return { point, usedFallback: false };
  const safeFallback = fallback && isValidGeoPoint(fallback) ? fallback : null;
  return { point: safeFallback, usedFallback: safeFallback !== null };
}

export function createLocationAttemptRunner(
  getLocation: () => Promise<GeoPoint | null>,
  onError: (error: unknown) => void = logLocationFailure,
): () => Promise<LocationAttemptResult> {
  let inFlight: Promise<LocationAttemptResult> | null = null;

  async function attempt(): Promise<LocationAttemptResult> {
    if (inFlight) return inFlight;
    const request = (async () => {
      try {
        const point = await getLocation();
        return { point, failed: point === null };
      } catch (error) {
        onError(error);
        return { point: null, failed: true, error };
      } finally {
        inFlight = null;
      }
    })();
    inFlight = request;
    return request;
  }

  return attempt;
}

function logLocationFailure(error: unknown): void {
  const details: { code?: string; api?: string; message?: string } = { api: 'zalo.location' };
  if (error instanceof ApiError) {
    details.code = error.code;
    details.message = error.message;
  } else if (error instanceof Error) {
    details.message = error.message;
  } else if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; api?: unknown; message?: unknown };
    if (typeof candidate.code === 'string') details.code = candidate.code;
    if (typeof candidate.api === 'string') details.api = candidate.api;
    if (typeof candidate.message === 'string') details.message = candidate.message;
  }
  console.warn('[zalo] Không lấy được vị trí', details);
}

export interface LocationAwareRouteRefreshResult extends RouteRefreshResult {
  point: GeoPoint | null;
}

export async function refreshRouteWithLocation(
  getLocation: () => Promise<GeoPoint | null>,
  loadRoute: (location?: GeoPoint) => Promise<RouteLoadResult>,
  fallback: GeoPoint | null,
): Promise<LocationAwareRouteRefreshResult> {
  let point: GeoPoint | null = null;
  let gpsFallback = false;
  try {
    point = await getLocation();
    if (!point) gpsFallback = true;
  } catch {
    gpsFallback = true;
  }
  if (gpsFallback) point = fallback;

  try {
    return { point, gpsFallback, gpsUpdated: !gpsFallback, data: await loadRoute(point ?? undefined) };
  } catch (error) {
    return { point, gpsFallback, gpsUpdated: !gpsFallback, error };
  }
}

interface RouteRefreshState {
  busy: boolean;
  notice: RouteRefreshNotice | null;
}

export function createRouteRefreshRunner(
  refetch: () => Promise<RouteRefreshResult>,
  onStateChange: (state: RouteRefreshState) => void,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;

  async function refreshRoute(): Promise<void> {
    if (inFlight) return inFlight;
    const request = (async () => {
      onStateChange({ busy: true, notice: null });
      try {
        const result = await refetch();
        onStateChange({ busy: false, notice: getRouteRefreshNotice(result) });
      } catch (error) {
        onStateChange({ busy: false, notice: getRouteRefreshNotice({ error }) });
      } finally {
        inFlight = null;
      }
    })();
    inFlight = request;
    return request;
  }

  return refreshRoute;
}

export function getPickupPriorityDisplay(stop: RouteStop): {
  level: keyof typeof PICKUP_PRIORITY_LEVELS;
  label: string;
  className: string;
  score: number;
  reasons: string[];
} | null {
  const aiStop = stop as RouteStop & {
    pickup_priority_score?: unknown;
    pickup_priority_level?: unknown;
    pickup_priority_reason_codes?: unknown;
  };
  const level = typeof aiStop.pickup_priority_level === 'string' ? aiStop.pickup_priority_level : null;
  const display = level ? PICKUP_PRIORITY_LEVELS[level as keyof typeof PICKUP_PRIORITY_LEVELS] : undefined;
  if (!display || typeof aiStop.pickup_priority_score !== 'number' || !Number.isFinite(aiStop.pickup_priority_score)) {
    return null;
  }

  const reasons = Array.isArray(aiStop.pickup_priority_reason_codes)
    ? aiStop.pickup_priority_reason_codes.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0).map(pickupPriorityReasonLabel)
    : [];
  return { level: level as keyof typeof PICKUP_PRIORITY_LEVELS, ...display, score: aiStop.pickup_priority_score, reasons };
}

export function isValidPhone(phone: unknown): phone is string {
  return typeof phone === 'string' && phone.trim().length > 0;
}

export async function runCollectorAction(
  action: () => Promise<void>,
  errorMessage: string,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
): Promise<boolean> {
  setBusy(true);
  setError(null);
  try {
    await action();
    return true;
  } catch {
    setError(errorMessage);
    return false;
  } finally {
    setBusy(false);
  }
}

export function CollectorFlow() {
  const queryClient = useQueryClient();
  const collectorStorageId = useAuthStore((state) => state.user?.collectorId ?? state.user?.id ?? null);
  const [restoredShift] = useState(() => collectorStorageId ? pendingStationDeliveryStorage.load(collectorStorageId) : null);
  const restoredRouteId = restoredShift?.routeId ?? restoredShift?.activeRoute?.route_id ?? undefined;
  const [screen, setScreen] = useState<CollectorScreen>(() => restoredRouteId && Object.keys(restoredShift?.completed ?? {}).length > 0 ? { name: 'summary' } : { name: 'route' });
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [locationDenied, setLocationDenied] = useState(false);
  const [completed, setCompleted] = useState<Record<string, CompletedStop>>(restoredShift?.completed ?? {});
  const [pendingDelivery, setPendingDelivery] = useState<PendingStationDeliveryDraft | null>(restoredShift?.pendingDelivery ?? null);
  const [initialStopCount, setInitialStopCount] = useState<number | null>(restoredShift?.totalStops ?? null);
  const [routeClientUuid] = useState(() => restoredShift?.routeClientUuid ?? crypto.randomUUID());
  const [shiftStarted, setShiftStarted] = useState(() => Boolean(restoredShift?.activeRoute?.persisted));
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<StoredStationReceipt | null>(null);
  const [prefetching, setPrefetching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<RouteRefreshNotice | null>(null);
  const refreshRunner = useRef<(() => Promise<void>) | null>(null);
  const locationRunner = useRef<(() => Promise<LocationAttemptResult>) | null>(null);
  const online = useOnlineStatus();
  const outboxStats = useOutboxStats();
  const outboxRows = useOutboxRows();

  if (locationRunner.current === null) {
    locationRunner.current = createLocationAttemptRunner(() => zaloClient.getLocation());
  }

  useEffect(() => {
    void startOutboxSyncWorker();
    let active = true;
    void locationRunner.current?.().then(({ point, failed }) => {
      if (!active) return;
      setLocation(point);
      setLocationDenied(failed);
    });
    return () => {
      active = false;
    };
  }, []);

  const route = useQuery<RouteLoadResult>({
    queryKey: ['collector-route', collectorStorageId, location],
    queryFn: async () => {
      try {
        return await loadRouteWithCache(location ?? undefined, collectorStorageId);
      } catch (error) {
        if (restoredShift?.activeRoute) {
          return { route: restoredShift.activeRoute, fromCache: true, cachedAt: restoredShift.savedAt };
        }
        throw error;
      }
    },
    staleTime: 15_000,
  });
  const routeProgress = route.data
    ? reconcileRouteProgress(route.data.route, completed, route.data.route.route_id ?? restoredRouteId, outboxRows)
    : { completed, completedOrderIds: Object.keys(completed), skippedOrderIds: [] };

  useEffect(() => {
    const loadedRouteId = route.data?.route.route_id;
    if (!loadedRouteId || !restoredRouteId || loadedRouteId === restoredRouteId) return;
    setCompleted({});
    setPendingDelivery(null);
    setInitialStopCount(route.data?.route.stops.length ?? 0);
    setShiftStarted(Boolean(route.data?.route.persisted));
    setScreen({ name: 'route' });
  }, [restoredRouteId, route.data?.route.route_id, route.data?.route.persisted, route.data?.route.stops.length]);

  useEffect(() => {
    let active = true;
    if (!collectorStorageId) {
      setLastReceipt(null);
      return () => {
        active = false;
      };
    }
    void getLatestStationReceipt(collectorStorageId).then((receipt) => {
      if (active) setLastReceipt(receipt);
    }).catch(() => {
      if (active) setLastReceipt(null);
    });
    return () => {
      active = false;
    };
  }, [collectorStorageId]);

  if (refreshRunner.current === null) {
    refreshRunner.current = createRouteRefreshRunner(
      async () => {
        const fallback = route.data?.route.stops.find((stop) => stop.ward_center)?.ward_center ?? location;
        const attempt = locationRunner.current;
        const refreshed = await refreshRouteWithLocation(
          async () => {
            const result = await attempt?.() ?? { point: null, failed: true };
            if (result.failed) throw result.error ?? new Error('Không lấy được GPS');
            return result.point;
          },
          (point) => loadRouteWithCache(point, collectorStorageId),
          fallback,
        );
        if (refreshed.point) {
          setLocation(refreshed.point);
        }
        setLocationDenied(refreshed.gpsFallback ?? false);
        if (refreshed.data) {
          queryClient.setQueryData(['collector-route', collectorStorageId, refreshed.point], refreshed.data);
        }
        return refreshed;
      },
      ({ busy, notice }) => {
        setRefreshing(busy);
        setRefreshNotice(notice);
      },
    );
  }
  const refreshRoute = refreshRunner.current;

  useEffect(() => {
    const wardCenter = route.data?.route.stops.find((stop) => stop.ward_center)?.ward_center;
    if (!location && wardCenter) {
      setLocation(wardCenter);
      setLocationDenied(true);
    }
  }, [location, route.data]);

  useEffect(() => {
    if (route.data && initialStopCount === null) {
      setInitialStopCount(route.data.route.stops.length);
    }
  }, [initialStopCount, route.data]);

  useEffect(() => {
    const activeRoute = route.data?.route;
    if (!activeRoute?.persisted || !collectorStorageId) return;
    setShiftStarted(true);
    pendingStationDeliveryStorage.save(collectorStorageId, {
      completed,
      totalStops: initialStopCount ?? activeRoute.stops.length,
      savedAt: new Date().toISOString(),
      activeRoute,
      routeId: activeRoute.route_id ?? undefined,
      routeClientUuid: activeRoute.client_uuid ?? routeClientUuid,
      pendingDelivery: pendingDelivery ?? undefined,
    });
  }, [collectorStorageId, completed, initialStopCount, pendingDelivery, route.data?.route, routeClientUuid]);

  async function startShift(): Promise<void> {
    if (!route.data || prefetching) {
      return;
    }
    if (!online) {
      setShiftError('Cần kết nối mạng một lần để bắt đầu ca và giữ tuyến.');
      return;
    }
    setPrefetching(true);
    setShiftError(null);
    try {
      const startedRoute = route.data.route.persisted
        ? route.data.route
        : await api.startRoute(routeClientUuid, location ?? undefined);
      await prefetchRouteData(startedRoute, location, collectorStorageId);
      queryClient.setQueryData(['collector-route', collectorStorageId, location], { route: startedRoute, fromCache: false, cachedAt: null });
      if (collectorStorageId) {
        pendingStationDeliveryStorage.save(collectorStorageId, {
          completed,
          totalStops: initialStopCount ?? startedRoute.stops.length,
          savedAt: new Date().toISOString(),
          activeRoute: startedRoute,
          routeId: startedRoute.route_id ?? undefined,
          routeClientUuid: startedRoute.client_uuid ?? routeClientUuid,
          pendingDelivery: pendingDelivery ?? undefined,
        });
      }
      setShiftStarted(true);
    } catch (error) {
      setShiftError(error instanceof ApiError ? error.message : 'Không thể bắt đầu ca. Vui lòng thử lại.');
    } finally {
      setPrefetching(false);
    }
  }

  async function cancelShift(): Promise<void> {
    if (!shiftStarted || Object.keys(completed).length > 0 || prefetching) return;
    if (typeof window !== 'undefined' && !window.confirm('Bạn có chắc muốn hủy ca thu gom này không?')) return;
    setPrefetching(true);
    setShiftError(null);
    try {
      await api.cancelCurrentRoute();
      if (collectorStorageId) pendingStationDeliveryStorage.clear(collectorStorageId);
      setShiftStarted(false);
      await queryClient.invalidateQueries({ queryKey: ['collector-route'] });
    } catch (error) {
      setShiftError(error instanceof ApiError ? error.message : 'Không thể hủy ca. Vui lòng thử lại.');
    } finally {
      setPrefetching(false);
    }
  }

  function onCollectionSaved(stop: RouteStop, liters: number, kilograms: number | null, clientUuid: string): void {
    const nextCompleted = { ...completed, [stop.order_id]: { liters, kilograms, clientUuid, stop } };
    const totalStops = Math.max(initialStopCount ?? route.data?.route.stops.length ?? 0, Object.keys(nextCompleted).length);
    setCompleted(nextCompleted);
    setInitialStopCount(totalStops);
    if (collectorStorageId) {
      pendingStationDeliveryStorage.save(collectorStorageId, {
        completed: nextCompleted,
        totalStops,
        savedAt: new Date().toISOString(),
        activeRoute: route.data?.route.persisted ? route.data.route : undefined,
        routeId: route.data?.route.route_id ?? restoredRouteId,
        routeClientUuid: route.data?.route.client_uuid ?? routeClientUuid,
        pendingDelivery: pendingDelivery ?? undefined,
      });
    }
    setScreen({ name: 'route' });
    void queryClient.invalidateQueries({ queryKey: ['collector-route'] });
  }

  function clearPersistedShift(): void {
    if (collectorStorageId) pendingStationDeliveryStorage.clear(collectorStorageId);
    setPendingDelivery(null);
  }

  async function finishShift(): Promise<boolean> {
    if (finishing) return false;
    setFinishing(true);
    setShiftError(null);
    try {
      if (route.data?.route.persisted && online) {
        await api.completeCurrentRoute();
      }
    } catch (error) {
      setShiftError(error instanceof ApiError ? error.message : 'Không thể kết ca. Vui lòng thử lại.');
      return false;
    } finally {
      setFinishing(false);
    }
    clearPersistedShift();
    setCompleted({});
    setInitialStopCount(route.data?.route.stops.length ?? 0);
    setShiftStarted(false);
    setScreen({ name: 'route' });
    return true;
  }

  let content: ReactNode;
  if (screen.name === 'outbox') {
    content = <OutboxQueueScreen onBack={() => setScreen({ name: 'route' })} />;
  } else if (screen.name === 'receipt-view' && lastReceipt) {
    content = <SavedStationReceiptView receipt={lastReceipt} onBack={() => setScreen({ name: 'route' })} />;
  } else if (screen.name === 'qr') {
     content = <CollectorQrScreen stop={screen.stop} onBack={() => setScreen({ name: 'route' })} onContinue={(container, containerCode) => setScreen({ name: 'entry', stop: screen.stop, container, containerCode })} />;
  } else if (screen.name === 'entry') {
    content = (
      <CollectorEntryScreen
        stop={screen.stop}
        container={screen.container}
        containerCode={screen.containerCode}
        onBack={() => setScreen({ name: 'qr', stop: screen.stop })}
        onSuccess={(liters, kilograms, clientUuid) => onCollectionSaved(screen.stop, liters, kilograms, clientUuid)}
      />
    );
  } else if (screen.name === 'summary') {
    content = <CollectorSummaryScreen route={route.data?.route} completed={routeProgress.completed} completedCount={routeProgress.completedOrderIds.length} totalStops={initialStopCount ?? route.data?.route.stops.length ?? 0} onBack={() => setScreen({ name: 'route' })} onOpenDelivery={() => setScreen({ name: 'station-delivery' })} />;
  } else if (screen.name === 'station-delivery') {
    content = <StationDeliveryFlow completed={routeProgress.completed} pendingDelivery={pendingDelivery} collectorId={collectorStorageId} routeId={route.data?.route.route_id ?? restoredRouteId} onPendingDelivery={(draft) => setPendingDelivery(draft)} onReceiptSaved={setLastReceipt} onBack={() => setScreen({ name: 'summary' })} onFinish={finishShift} />;
  } else if (route.isPending && !route.data) {
    content = <StatusView title="Đang tải tuyến hôm nay…" />;
  } else if (route.isError && !route.data) {
    content = <StatusView title="Chưa tải được tuyến" message="Chưa có dữ liệu tuyến trên máy. Kiểm tra kết nối rồi thử lại." action={{ label: 'Thử lại', onClick: () => { void route.refetch(); } }} />;
  } else if (route.data) {
    const activeStopIds = new Set(routeProgress.completedOrderIds);
    const skippedStopIds = new Set(routeProgress.skippedOrderIds);
    const activeStops = route.data.route.stops.filter((stop) => {
      if (skippedStopIds.has(stop.order_id) || stop.route_stop_status === 'COLLECTED') return false;
      const localRecord = findRowForStop(outboxRows, stop);
      return !activeStopIds.has(stop.order_id) || localRecord?.status === 'pending' || localRecord?.status === 'syncing' || localRecord?.status === 'failed';
    });
    content = (
      <CollectorRouteScreen
        stops={activeStops}
        route={route.data}
        location={location}
        locationDenied={locationDenied}
        completed={routeProgress.completed}
        totalStops={initialStopCount ?? route.data.route.stops.length}
        outboxRows={outboxRows}
        outboxStats={outboxStats}
        shiftStarted={shiftStarted}
        shiftError={shiftError}
        prefetching={prefetching}
        onStartShift={() => { void startShift(); }}
        onCancelShift={() => { void cancelShift(); }}
        onOpenQr={(stop) => setScreen({ name: 'qr', stop })}
        onOpenSummary={() => setScreen({ name: 'summary' })}
        onOpenOutbox={() => setScreen({ name: 'outbox' })}
        refreshing={refreshing}
        refreshNotice={refreshNotice}
        onRefresh={() => { void refreshRoute(); }}
        lastReceipt={lastReceipt}
        onOpenLastReceipt={() => setScreen({ name: 'receipt-view' })}
      />
    );
  } else {
    content = <StatusView title="Chưa tải được tuyến" message="Chưa có dữ liệu tuyến trên máy. Kiểm tra kết nối rồi thử lại." />;
  }

  return (
    <div className="collector-flow-root">
      {!online ? <div className="offline-banner">Đang ngoại tuyến — dữ liệu vẫn được lưu an toàn trên máy.</div> : null}
      {content}
    </div>
  );
}

interface CollectorRouteScreenProps {
  stops: RouteStop[];
  route: RouteLoadResult;
  location: GeoPoint | null;
  locationDenied: boolean;
  completed: Record<string, CompletedStop>;
  totalStops: number;
  outboxRows: OutboxRecord[];
  outboxStats: ReturnType<typeof useOutboxStats>;
  shiftStarted: boolean;
  shiftError: string | null;
  prefetching: boolean;
  refreshing: boolean;
  refreshNotice: RouteRefreshNotice | null;
  lastReceipt: StoredStationReceipt | null;
  onStartShift: () => void;
  onCancelShift: () => void;
  onOpenQr: (stop: RouteStop) => void;
  onOpenSummary: () => void;
  onOpenOutbox: () => void;
  onRefresh: () => void;
  onOpenLastReceipt: () => void;
}

function CollectorRouteScreen({ stops, route, location, locationDenied, completed, totalStops, outboxRows, outboxStats, shiftStarted, shiftError, prefetching, refreshing, refreshNotice, lastReceipt, onStartShift, onCancelShift, onOpenQr, onOpenSummary, onOpenOutbox, onRefresh, onOpenLastReceipt }: CollectorRouteScreenProps) {
  const vehicleCapacity = route.route.total_expected_liters + route.route.remaining_capacity_l;
  const routeFill = vehicleCapacity > 0 ? Math.min(100, Math.round((route.route.total_expected_liters / vehicleCapacity) * 100)) : 0;
  const completedLiters = Object.values(completed).reduce((sum, item) => sum + item.liters, 0);
  const routeOptimization = getRouteOptimizationDisplay(route.route.route_optimization);
  const routeCapacityRisk = getRouteCapacityRiskDisplay(route.route.route_capacity_risk, vehicleCapacity);

  return (
    <div className="page-content collector-content">
      <header className="page-header collector-page-header">
        <div><p className="eyebrow">CA HÔM NAY</p><h1>Tuyến thu gom</h1></div>
        <div className="collector-header-actions">
          <OutboxBadge stats={outboxStats} onClick={onOpenOutbox} />
          <button type="button" className={`round-action ${refreshing ? 'round-action-loading' : ''}`} onClick={onRefresh} disabled={refreshing} aria-busy={refreshing ? 'true' : 'false'}>{refreshing ? 'Đang tải' : 'Tải lại'}</button>
        </div>
      </header>
      {refreshNotice ? <div className={`route-refresh-notice route-refresh-notice-${refreshNotice.kind}`} role={refreshNotice.kind === 'error' ? 'alert' : 'status'}>{refreshNotice.message}</div> : null}
      {!location && !locationDenied ? <div className="location-banner">Đang xin quyền vị trí để tính tuyến gần nhất…</div> : null}
      {locationDenied ? <div className="location-banner">Không lấy được vị trí GPS, đang dùng vị trí trung tâm phường. Giao dịch có thể bị đánh dấu cần kiểm tra.</div> : null}
      {route.fromCache ? <div className="offline-cache-banner">Đang dùng dữ liệu lúc {formatTime(route.cachedAt)}</div> : null}
      {lastReceipt ? <section className="receipt-saved-banner" role="status"><strong>Đã lưu biên nhận trên máy</strong><span>Mã phiếu: {lastReceipt.receipt_id}</span><button className="text-button" onClick={onOpenLastReceipt}>Xem lại biên nhận</button></section> : null}
      <OutboxIssueNotice rows={outboxRows} stats={outboxStats} onOpen={onOpenOutbox} />
      {!shiftStarted ? <button className="start-shift-button" onClick={onStartShift} disabled={prefetching}>{prefetching ? 'Đang lưu tuyến và mã QR…' : 'Bắt đầu ca, lưu tuyến để dùng ngoại tuyến'}</button> : <div className="shift-ready-note"><strong>Tuyến đã sẵn sàng khi mất sóng.</strong>{route.route.started_at ? ` Bắt đầu lúc ${formatTime(route.route.started_at)}.` : ''} <button className="text-button" onClick={onCancelShift} disabled={prefetching || Object.keys(completed).length > 0}>Hủy ca</button></div>}
      {shiftError ? <p className="error-text" role="alert">{shiftError}</p> : null}
      <section className="route-capacity-card">
        <div className="route-capacity-top"><span>Tổng lít dự kiến</span><strong>{formatLiters(route.route.total_expected_liters)} / {formatLiters(vehicleCapacity)}</strong></div>
        <div className="route-progress"><span className={routeFill >= 80 ? 'route-progress-high' : ''} style={{ width: `${routeFill}%` }} /></div>
        <div className="route-capacity-bottom"><span>{routeFill}% dung tích xe</span><span>{formatLiters(route.route.remaining_capacity_l)} còn trống</span></div>
      </section>
      {routeCapacityRisk ? (
        <section className={`route-capacity-risk-card route-capacity-risk-${routeCapacityRisk.tone}`} aria-label="Cảnh báo AI sức chứa">
          <div className="route-capacity-risk-heading"><span className="route-capacity-risk-ai">AI</span><strong>{routeCapacityRisk.title}</strong></div>
          {routeCapacityRisk.utilizationPct !== null ? <p className="route-capacity-risk-utilization">AI dự kiến xe đạt {routeCapacityRisk.utilizationPct}%</p> : null}
          {routeCapacityRisk.riskAdjustedTotalLiters !== null && routeCapacityRisk.vehicleCapacityLiters !== null ? <p className="route-capacity-risk-metrics">Sau biên an toàn: {formatRouteCapacityRiskLiters(routeCapacityRisk.riskAdjustedTotalLiters)} / {formatRouteCapacityRiskLiters(routeCapacityRisk.vehicleCapacityLiters)}</p> : null}
          <div className="route-capacity-risk-meta"><span>{routeCapacityRisk.confidenceLabel}</span>{routeCapacityRisk.coveragePct !== null ? <span>Độ phủ dự báo: {routeCapacityRisk.coveragePct}%</span> : null}</div>
          {routeCapacityRisk.message ? <small>{routeCapacityRisk.message}</small> : null}
        </section>
      ) : null}
      {routeOptimization ? (
        <section className={`route-optimization-card route-optimization-${routeOptimization.tone}`} aria-label="Tóm tắt tối ưu tuyến">
          <div className="route-optimization-heading"><span className="route-optimization-ai">AI</span><strong>{routeOptimization.title}</strong></div>
          <p>{routeOptimization.message}</p>
          {routeOptimization.detail ? <small>{routeOptimization.detail}</small> : null}
        </section>
      ) : null}
      <div className="route-summary-line"><strong>{Object.keys(completed).length} / {Math.max(totalStops, Object.keys(completed).length)} điểm đã thu</strong><button className="text-button" onClick={onOpenSummary}>Tóm tắt ca</button></div>
      {stops.length === 0 ? (
        <StatusView title="Đã hoàn thành tuyến" message={completedLiters > 0 ? `Đã thu ${formatLiters(completedLiters)}. Bạn có thể xem lại tóm tắt ca.` : 'Hiện chưa có điểm READY trong phường.'} action={{ label: 'Xem tóm tắt ca', onClick: onOpenSummary }} />
      ) : (
        <section className="collector-stop-list">
          {stops.map((stop) => <CollectorStopCard key={stop.order_id} stop={stop} outboxRow={findRowForStop(outboxRows, stop)} onOpenQr={() => onOpenQr(stop)} />)}
        </section>
      )}
    </div>
  );
}

function OutboxBadge({ stats, onClick }: { stats: ReturnType<typeof useOutboxStats>; onClick: () => void }) {
  const waiting = stats.pending + stats.syncing + stats.failed;
  const label = waiting > 0 ? `${waiting} giao dịch chưa đồng bộ` : 'Đã đồng bộ hết';
  return <button className={`outbox-badge ${stats.failed > 0 ? 'outbox-badge-failed' : ''}`} onClick={onClick}>{label}</button>;
}

function OutboxIssueNotice({ rows, stats, onOpen }: { rows: OutboxRecord[]; stats: ReturnType<typeof useOutboxStats>; onOpen?: () => void }) {
  const unsynced = stats.pending + stats.syncing + stats.failed;
  const latestError = rows.find((row) => row.last_error)?.last_error ?? null;
  if (unsynced === 0 && !latestError) return null;
  return (
    <div className="outbox-issue-banner" role="alert">
      <strong>{unsynced} giao dịch chưa đồng bộ</strong>
      <span>{latestError ? outboxErrorMessage(latestError) : 'Đang gửi dữ liệu, vui lòng giữ mạng và không xoá hàng chờ.'}</span>
      {onOpen ? <button className="text-button" onClick={onOpen}>Xem hàng chờ đồng bộ</button> : null}
    </div>
  );
}

function CollectorStopCard({ stop, outboxRow, onOpenQr }: { stop: RouteStop; outboxRow: OutboxRecord | undefined; onOpenQr: () => void }) {
  const status = outboxRow?.status;
  const pickupPriority = getPickupPriorityDisplay(stop);
  const pickupVolumeForecast = getPickupVolumeForecastDisplay(stop);
  const [actionBusy, setActionBusy] = useState<'phone' | 'directions' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const phone = isValidPhone(stop.merchant.phone) ? stop.merchant.phone.trim() : '';
  const canCall = phone.length > 0;
  const canOpenDirections = isValidGeoPoint(stop.merchant);

  function openPhone(): void {
    if (!canCall || actionBusy) return;
    void runCollectorAction(
      () => zaloClient.openPhone(phone),
      'Không thể mở cuộc gọi. Vui lòng thử lại.',
      (busy) => setActionBusy(busy ? 'phone' : null),
      setActionError,
    );
  }

  function openDirections(): void {
    if (!canOpenDirections || actionBusy) return;
    void runCollectorAction(
      () => zaloClient.openDirections({ lat: stop.merchant.lat, lng: stop.merchant.lng }),
      'Không thể mở chỉ đường. Vui lòng thử lại.',
      (busy) => setActionBusy(busy ? 'directions' : null),
      setActionError,
    );
  }

  return (
    <article className="collector-stop-card">
      <div className={`stop-number ${status ? `stop-number-${status}` : ''}`}>{stop.seq}</div>
      <div className="stop-body">
        <div className="stop-title-row"><h2>{stop.merchant.name}</h2><span className="distance-label">{formatDistance(stop.distance_m)}</span></div>
        <p className="stop-address">{stop.merchant.address ?? 'Chưa có địa chỉ'}</p>
        <strong className="stop-liters">{formatLiters(stop.expected_liters)} dự kiến</strong>
        {pickupVolumeForecast ? (
          <section className={`pickup-volume-forecast pickup-volume-forecast-${pickupVolumeForecast.className}`} aria-label="Dự báo AI sản lượng">
            <div className="pickup-volume-forecast-heading"><span className="pickup-volume-ai-label">Dự báo AI</span><span>{pickupVolumeForecast.confidenceLabel}</span></div>
            {pickupVolumeForecast.predictedLiters === null ? <strong>Chưa đủ dữ liệu để dự báo sản lượng</strong> : <strong>Khoảng {formatPickupVolumeLiters(pickupVolumeForecast.predictedLiters)}</strong>}
            {pickupVolumeForecast.declaredOnly ? <small>Tạm tính theo số quán khai</small> : pickupVolumeForecast.sampleSize !== null ? <small>Dựa trên {pickupVolumeForecast.sampleSize} lần thu gần nhất</small> : null}
            {pickupVolumeForecast.reasons.length > 0 ? <div className="pickup-volume-forecast-reasons">{pickupVolumeForecast.reasons.map((reason, index) => <span className="pickup-volume-forecast-reason" key={`${reason}-${index}`}>{reason}</span>)}</div> : null}
          </section>
        ) : null}
        {pickupPriority ? (
          <section className={`pickup-priority pickup-priority-${pickupPriority.className}`} aria-label={`Mức ưu tiên: ${pickupPriority.label}`}>
            <div className="pickup-priority-heading"><strong>{pickupPriority.label}</strong><span>Điểm ưu tiên: {pickupPriority.score}</span></div>
            {pickupPriority.reasons.length > 0 ? <div className="pickup-priority-reasons">{pickupPriority.reasons.map((reason, index) => <span className="pickup-priority-reason" key={`${reason}-${index}`}>{reason}</span>)}</div> : null}
          </section>
        ) : null}
        {status ? <p className={`transaction-status transaction-status-${status}`}>{statusLabel(status)}</p> : null}
        <div className="stop-actions">
          <button type="button" className={`call-action ${!canCall ? 'disabled-action' : ''}`} onClick={openPhone} disabled={!canCall || actionBusy !== null}>{actionBusy === 'phone' ? 'Đang mở…' : 'Gọi quán'}</button>
          <button type="button" className={`map-action ${!canOpenDirections ? 'disabled-action' : ''}`} onClick={openDirections} disabled={!canOpenDirections || actionBusy !== null}>{actionBusy === 'directions' ? 'Đang mở…' : 'Chỉ đường'}</button>
          <button className="collect-action" onClick={onOpenQr} disabled={status === 'pending' || status === 'syncing'}>{status === 'synced' ? 'Đã thu' : 'Thu gom'}</button>
        </div>
        {actionError ? <p className="action-error" role="alert">{actionError}</p> : null}
      </div>
    </article>
  );
}

function CollectorQrScreen({ stop, onBack, onContinue }: { stop: RouteStop; onBack: () => void; onContinue: (container: ContainerLookupResponse, containerCode: string) => void }) {
  const [code, setCode] = useState(stop.container_code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [container, setContainer] = useState<ContainerLookupResponse | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  async function lookup(inputCode: string): Promise<void> {
    setMismatch(false);
    setContainer(null);
    setCachedAt(null);
    await submitContainerCode(
      inputCode,
      lookupContainerWithCache,
      {
        setBusy,
        setError,
        onResolved: (found, normalized) => {
          setCode(normalized);
          if (found.container.qr_code !== stop.container_code) {
            setMismatch(true);
            return;
          }
          setCachedAt(found.cachedAt);
          setContainer(found.container);
        },
      },
      (requestError) => requestError instanceof ApiError && requestError.code === 'NOT_FOUND' ? 'Không tìm thấy can này.' : 'Chưa tra được mã can, thử lại nhé.',
    );
  }

  async function scan(): Promise<void> {
    setBusy(true);
    setError(null);
      try {
        const scannedCode = await zaloClient.scanQRCode();
        if (!scannedCode.trim()) {
          setError('Chưa quét được mã can. Bạn có thể nhập tay mã can bên dưới.');
          return;
        }
        await lookup(scannedCode);
      } catch (scanError) {
        setError(isZaloPermissionDenied(scanError)
          ? 'Zalo chưa có quyền dùng camera để quét QR. Hãy bật quyền Camera trong Zalo hoặc nhập tay mã can.'
          : 'Không quét được mã. Bạn có thể nhập tay mã can.');
      } finally {
        setBusy(false);
      }
  }

  return (
    <div className="page-content collector-content">
      <button className="back-button" onClick={onBack}>Quay lại tuyến</button>
      <header className="collector-screen-heading"><p className="eyebrow">ĐIỂM {stop.seq}</p><h1>Quét mã can</h1><p>{stop.merchant.name}</p></header>
      <section className="qr-target-card"><span>Can cần thu</span><strong>{stop.container_code}</strong><small>{stop.merchant.address ?? ''}</small></section>
      <button className="scan-button" onClick={() => { void scan(); }} disabled={busy}>{busy ? 'Đang kiểm tra…' : 'Quét QR bằng camera'}</button>
      <section className="manual-qr-card">
        <p className="section-label">Nhập mã can</p>
        <label htmlFor="manual-qr">Bạn có thể nhập hoặc sửa mã can</label>
        <input id="manual-qr" value={code} onChange={(event) => setCode(event.target.value)} placeholder="ECO-UCO-Q3P7-001" />
        <button className="secondary-button" onClick={() => { void lookup(code); }} disabled={busy}>Kiểm tra mã can</button>
      </section>
      {error ? <div className="error-panel">{error}</div> : null}
      {mismatch ? <div className="warning-panel"><strong>Đây không phải can của điểm này</strong><span>Kiểm tra lại mã QR. Không thể ghi nhận nhầm can.</span></div> : null}
      {container ? (
        <section className="verified-container-card">
          <span className="verified-badge">Đã đối chiếu</span>
          {cachedAt ? <p className="offline-cache-note">Dữ liệu lúc {formatTime(cachedAt)}</p> : null}
          <h2>{container.merchant.name}</h2>
          <p>{container.qr_code} · {formatLiters(container.capacity_liters)} · {container.state === ContainerState.AT_MERCHANT ? 'Đang ở quán' : container.state}</p>
          <button className="primary-button" onClick={() => onContinue(container, code.trim())}>Tiếp tục nhập giao dịch</button>
        </section>
      ) : null}
    </div>
  );
}

function CollectorEntryScreen({ stop, container, containerCode, onBack, onSuccess }: { stop: RouteStop; container: ContainerLookupResponse; containerCode: string; onBack: () => void; onSuccess: (liters: number, kilograms: number | null, clientUuid: string) => void }) {
  const [liters, setLiters] = useState(stop.expected_liters > 0 ? stop.expected_liters.toFixed(1) : '');
  const [kilograms, setKilograms] = useState('');
  const [quality, setQuality] = useState<Quality>(Quality.PASS);
  const [grade, setGrade] = useState<OilGrade | null>(null);
  const [suspectedAdulteration, setSuspectedAdulteration] = useState(false);
  const [gradeNote, setGradeNote] = useState('');
  const [photos, setPhotos] = useState<PhotoAsset[]>([]);
  const [imageAnalysis, setImageAnalysis] = useState<OilImageAnalysis | null>(null);
  const [analyzingImages, setAnalyzingImages] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false);
  const [gradeConfirmed, setGradeConfirmed] = useState(false);
  const [geo, setGeo] = useState<GeoPoint | null>(null);
  const [saving, setSaving] = useState(false);
  const [takingPhoto, setTakingPhoto] = useState(false);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [locationFallback, setLocationFallback] = useState(false);
  const [clientUuid] = useState(() => crypto.randomUUID());
  const [highDeviationAcknowledgement, setHighDeviationAcknowledgement] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const mediaPickerInFlightRef = useRef(false);
  const analysisRunRef = useRef(0);
  useEffect(() => () => {
    mountedRef.current = false;
    analysisRunRef.current += 1;
    zaloClient.cancelMediaPicker?.();
  }, []);
  const capacity = Number(container.capacity_liters ?? 0);
  const enteredLiters = liters.trim() === '' ? null : Number(liters);
  const actualKg = kilograms.trim() === '' ? null : Number(kilograms);
  const hasLiters = enteredLiters !== null && Number.isFinite(enteredLiters) && enteredLiters > 0;
  const hasKilograms = actualKg !== null && Number.isFinite(actualKg) && actualKg > 0;
  const litersDerivedFromKilograms = !hasLiters && hasKilograms;
  const actualLiters = litersDerivedFromKilograms ? (actualKg as number) / DEFAULT_DENSITY_KG_PER_LITER : enteredLiters ?? 0;
  const maxLiters = capacity * 1.1;
  const invalidLiters = actualLiters > maxLiters || (hasLiters && (!Number.isFinite(actualLiters) || actualLiters <= 0));
  const invalidKg = actualKg !== null && (!Number.isFinite(actualKg) || actualKg < 0);
  const invalidMass = (!hasLiters && !hasKilograms) || invalidLiters || invalidKg;
  const pickupVolumeForecast = getPickupVolumeForecastDisplay(stop);
  const pickupVolumeDeviation = evaluatePickupVolumeDeviation(stop, actualLiters);
  const highDeviationKey = getPickupVolumeDeviationKey(pickupVolumeDeviation);
  useEffect(() => {
    setHighDeviationAcknowledgement(null);
  }, [highDeviationKey]);
  const highDeviationNeedsAcknowledgement = requiresPickupVolumeAcknowledgement(pickupVolumeDeviation, highDeviationAcknowledgement);
  const gradePhotoMissing = isGradePhotoMissing(grade, suspectedAdulteration, photos.length);
  const imageGradeDisplay = getImageGradeAnalysisDisplay(imageAnalysis);
  const suggestedGrade = imageAnalysis?.suggested_grade ?? null;
  const needsImageGradeOverrideAcknowledgement = Boolean(
    grade && suggestedGrade && grade !== suggestedGrade && (imageAnalysis?.confidence === 'HIGH' || imageAnalysis?.confidence === 'MEDIUM'),
  );
  const imageGradeDecisionBlocked = needsImageGradeOverrideAcknowledgement && !overrideAcknowledged;
  const submitBlockReason = grade === null
    ? 'Vui lòng chọn phân hạng dầu trước khi xác nhận.'
    : !gradeConfirmed
      ? 'Vui lòng xác nhận hạng cuối trước khi lưu giao dịch.'
    : analyzingImages
      ? 'Vui lòng chờ phân tích ảnh hoàn tất trước khi lưu giao dịch.'
    : invalidMass
      ? (!hasLiters && !hasKilograms ? 'Vui lòng nhập số kg hoặc số lít lớn hơn 0.' : litersDerivedFromKilograms && invalidLiters ? `Số lít suy ra từ khối lượng (${actualLiters.toFixed(2)} lít) vượt dung tích cho phép ${maxLiters.toFixed(1)} lít.` : `Số lít phải lớn hơn 0 và không vượt ${maxLiters.toFixed(1)} lít.`)
      : gradePhotoMissing
        ? 'Hạng B, hạng C hoặc nghi ngờ pha lẫn cần ít nhất 1 ảnh trước khi gửi.'
        : quality === Quality.FLAG && photos.length === 0
          ? 'Giao dịch cần kiểm tra bắt buộc có ít nhất 1 ảnh.'
          : highDeviationNeedsAcknowledgement
            ? 'Vui lòng kiểm tra lại số lít và xác nhận tiếp tục.'
            : imageGradeDecisionBlocked
              ? 'Gợi ý AI khác hạng đã chọn. Vui lòng xác nhận bạn muốn giữ hạng này.'
            : null;

  function adjustLiters(amount: number): void {
    const next = Math.max(0, (Number(liters) || 0) + amount);
    setLiters(next.toFixed(1));
  }

  function adjustKilograms(amount: number): void {
    const next = Math.max(0, (Number(kilograms) || 0) + amount);
    setKilograms(next.toFixed(1));
  }

  async function analyzePhotos(nextPhotos: PhotoAsset[]): Promise<void> {
    const run = ++analysisRunRef.current;
    if (nextPhotos.length === 0) {
      if (mountedRef.current) {
        setImageAnalysis(null);
        setAnalysisError(null);
        setAnalyzingImages(false);
      }
      return;
    }
    setAnalyzingImages(true);
    setAnalysisError(null);
    setImageAnalysis(null);
    try {
      const result = await analyzeOilImages(nextPhotos.map((item) => item.url));
      if (mountedRef.current && run === analysisRunRef.current) setImageAnalysis(result);
    } catch {
      if (mountedRef.current && run === analysisRunRef.current) {
        setAnalysisError('Không phân tích được ảnh. Bạn có thể thử lại hoặc chọn/chụp ảnh khác.');
        setImageAnalysis(null);
      }
    } finally {
      if (mountedRef.current && run === analysisRunRef.current) setAnalyzingImages(false);
    }
  }

  function addPhoto(photo: PhotoAsset): void {
    if (!photo.url.trim()) {
      throw new Error('Ảnh không hợp lệ');
    }
    const nextPhotos = [...photos, photo];
    setPhotos(nextPhotos);
    setOverrideAcknowledged(false);
    setGradeConfirmed(false);
    void analyzePhotos(nextPhotos);
  }

  async function takePhoto(): Promise<void> {
    if (mediaPickerInFlightRef.current) return;
    mediaPickerInFlightRef.current = true;
    setTakingPhoto(true);
    setError(null);
    setPhotoNotice(null);
    try {
      const result = await pickZaloPhoto('camera');
      if (!mountedRef.current) return;
      if (result.kind === 'selected') addPhoto(result.photo);
      else if (result.kind === 'cancelled') setPhotoNotice('Bạn chưa chọn ảnh. Bạn có thể thử lại hoặc chọn ảnh từ thư viện/file dự phòng.');
      else if (result.kind === 'permission-denied') setError('Zalo chưa có quyền Camera. Hãy bật quyền Camera hoặc dùng ảnh từ thư viện/file dự phòng.');
      else setError('Không mở được camera. Hãy dùng ảnh từ thư viện hoặc file dự phòng.');
    } finally {
      mediaPickerInFlightRef.current = false;
      if (mountedRef.current) setTakingPhoto(false);
    }
  }

  async function chooseAlbumPhoto(): Promise<void> {
    if (mediaPickerInFlightRef.current) return;
    mediaPickerInFlightRef.current = true;
    setTakingPhoto(true);
    setError(null);
    setPhotoNotice(null);
    try {
      const result = await pickZaloPhoto('album');
      if (!mountedRef.current) return;
      if (result.kind === 'selected') addPhoto(result.photo);
      else if (result.kind === 'cancelled') setPhotoNotice('Bạn chưa chọn ảnh. Bạn có thể thử lại hoặc chọn ảnh từ camera/file dự phòng.');
      else if (result.kind === 'permission-denied') setError('Zalo chưa được phép chọn ảnh. Hãy kiểm tra quyền hoặc dùng file dự phòng.');
      else setError('Không chọn được ảnh từ thư viện Zalo. Hãy dùng file dự phòng.');
    } finally {
      mediaPickerInFlightRef.current = false;
      if (mountedRef.current) setTakingPhoto(false);
    }
  }

  async function choosePhotoFile(file: File): Promise<void> {
    if (mediaPickerInFlightRef.current) return;
    mediaPickerInFlightRef.current = true;
    setTakingPhoto(true);
    setError(null);
    setPhotoNotice(null);
    try {
      const photo = await compressImageBlob(file);
      if (mountedRef.current) addPhoto(photo);
    } catch {
      if (mountedRef.current) setError('Không đọc được ảnh. Hãy chọn một ảnh khác.');
    } finally {
      mediaPickerInFlightRef.current = false;
      if (mountedRef.current) setTakingPhoto(false);
    }
  }

  function removePhoto(index: number): void {
    const nextPhotos = photos.filter((_, photoIndex) => photoIndex !== index);
    setPhotos(nextPhotos);
    setOverrideAcknowledged(false);
    setGradeConfirmed(false);
    void analyzePhotos(nextPhotos);
  }

  async function submit(): Promise<void> {
    if (grade === null) {
      setError('Vui lòng chọn phân hạng dầu trước khi xác nhận.');
      return;
    }
    if (!gradeConfirmed) {
      setError('Vui lòng xác nhận hạng cuối trước khi lưu giao dịch.');
      return;
    }
    if (invalidMass) {
      setError(!hasLiters && !hasKilograms ? 'Vui lòng nhập số kg hoặc số lít lớn hơn 0.' : litersDerivedFromKilograms && invalidLiters ? `Số lít suy ra từ khối lượng (${actualLiters.toFixed(2)} lít) vượt dung tích cho phép ${maxLiters.toFixed(1)} lít.` : `Số lít phải lớn hơn 0 và không vượt ${maxLiters.toFixed(1)} lít.`);
      return;
    }
    if (quality === Quality.FLAG && photos.length === 0) {
      setError('Chất lượng cần kiểm tra bắt buộc có ít nhất 1 ảnh.');
      return;
    }
    if (highDeviationNeedsAcknowledgement) {
      setError('Vui lòng kiểm tra lại số lít và xác nhận tiếp tục.');
      return;
    }
    if (imageGradeDecisionBlocked) {
      setError('Gợi ý AI khác hạng đã chọn. Vui lòng xác nhận bạn muốn giữ hạng này.');
      return;
    }
    if (saving || success) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let currentGeo = geo;
      if (!currentGeo) {
        const resolvedLocation = await resolveCollectionLocation(
          () => zaloClient.getLocation(stop.ward_center ?? null),
          stop.ward_center ?? null,
        );
        currentGeo = resolvedLocation.point;
        if (!currentGeo) {
          throw new Error('Không xác định được vị trí hiện tại hoặc tâm phường. Vui lòng bật GPS rồi thử lại.');
        }
        if (mountedRef.current) setLocationFallback(resolvedLocation.usedFallback);
        if (mountedRef.current) setGeo(currentGeo);
      }
      const payload: CollectionCreateRequest & {
      image_grade_suggestion: OilGrade | null;
      image_grade_confidence: OilImageAnalysis['confidence'] | null;
      image_grade_model_version: OilImageAnalysis['model_version'] | null;
      image_grade_analysis: OilImageAnalysisPayload | null;
      grade_decision_source: 'MANUAL' | 'AI_SUGGESTION_ACCEPTED' | 'MANUAL_OVERRIDE_AI';
      grade_ai_override_acknowledged: boolean;
      } = {
      client_uuid: clientUuid,
      order_id: stop.order_id,
       container_code: containerCode,
      ...(hasLiters ? { actual_liters: actualLiters } : {}),
      ...(actualKg === null ? {} : { actual_kg: actualKg }),
      quality,
      grade,
      // The API derives grade_photo_url from photos[0]; do not duplicate a Base64 image in JSON.
      ...(gradeNote.trim() ? { grade_note: gradeNote.trim() } : {}),
      suspected_adulteration: suspectedAdulteration,
      image_grade_suggestion: (imageAnalysis?.suggested_grade as OilGrade | null | undefined) ?? null,
      ai_suggested_grade: (imageAnalysis?.suggested_grade as OilGrade | null | undefined) ?? null,
      collector_selected_grade: grade,
      collector_grade_confirmed: true,
      image_grade_confidence: imageAnalysis?.confidence ?? null,
      image_grade_model_version: imageAnalysis?.model_version ?? null,
      image_grade_analysis: imageAnalysis
        ? { ...imageAnalysis, suggested_grade: imageAnalysis.suggested_grade as OilGrade | null }
        : null,
      grade_decision_source: imageAnalysis?.suggested_grade && grade === imageAnalysis.suggested_grade
        ? 'AI_SUGGESTION_ACCEPTED'
        : imageAnalysis?.suggested_grade && grade !== imageAnalysis.suggested_grade
          ? 'MANUAL_OVERRIDE_AI'
          : 'MANUAL',
      grade_ai_override_acknowledged: overrideAcknowledged,
      geo: currentGeo,
      photos: photos.map((photo) => photo.url),
      collected_at: new Date().toISOString(),
      };
      await enqueueCollection(payload);
      if (mountedRef.current) {
        setSuccess(true);
        void syncOutbox();
        window.setTimeout(() => {
          if (mountedRef.current) onSuccess(actualLiters, actualKg, clientUuid);
        }, 450);
      }
    } catch (submitError) {
      if (mountedRef.current) {
        setError(submitError instanceof Error && submitError.message.startsWith('Không xác định được vị trí')
          ? submitError.message
          : 'Không lưu được giao dịch trên máy. Dữ liệu chưa được ghi, vui lòng thử lại.');
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  if (success) {
    return <div className="success-screen"><div className="status-label">Đã ghi nhận</div><h1>Đã lưu an toàn</h1><p>{formatLiters(actualLiters)} {actualKg === null ? `(~${(actualLiters * DEFAULT_DENSITY_KG_PER_LITER).toFixed(1)} kg ước lượng)` : `· ${actualKg.toFixed(1)} kg đã cân`} · Giao dịch sẽ tự đồng bộ khi có mạng.</p></div>;
  }

  return (
    <div className="page-content collector-content">
      <button className="back-button" onClick={onBack} disabled={saving}>Quay lại quét mã</button>
       <header className="collector-screen-heading"><p className="eyebrow">GHI NHẬN THU GOM</p><h1>{container.merchant.name}</h1><p>{containerCode}</p></header>
      <section className="entry-target-card"><span>Số lít quán khai</span><strong>{formatLiters(stop.expected_liters)}</strong>{pickupVolumeForecast ? <div className="entry-volume-forecast"><strong>{pickupVolumeForecast.predictedLiters === null ? 'AI chưa đủ dữ liệu để dự báo sản lượng.' : `AI dự báo: khoảng ${formatPickupVolumeLiters(pickupVolumeForecast.predictedLiters)}`}</strong><small>{pickupVolumeForecast.confidenceLabel}</small>{pickupVolumeForecast.declaredOnly ? <small>AI chưa có đủ lịch sử riêng cho quán này.</small> : null}</div> : null}<small>Mã giao dịch: {clientUuid.slice(0, 8)}…</small>{locationFallback ? <p className="location-banner">Không lấy được vị trí GPS, đang dùng vị trí trung tâm phường. Giao dịch có thể bị đánh dấu cần kiểm tra.</p> : null}</section>
      <section className="quality-card">
        <p className="section-label">Phân hạng dầu</p>
        <OilGradeSelector value={grade} disabled={saving} onChange={(nextGrade) => { setGrade(nextGrade); setOverrideAcknowledged(false); setGradeConfirmed(false); }} />
        <label className="toggle-row grade-confirmation-row"><input type="checkbox" checked={gradeConfirmed} onChange={(event) => setGradeConfirmed(event.target.checked)} disabled={saving || grade === null} /><span>Tôi xác nhận hạng cuối: {grade ? `hạng ${grade}` : 'chưa chọn'}</span></label>
        <label className="toggle-row"><input type="checkbox" checked={suspectedAdulteration} onChange={(event) => setSuspectedAdulteration(event.target.checked)} disabled={saving} /><span>Nghi ngờ pha lẫn</span></label>
        <p className="field-help">Bật nếu thấy có nước, dầu nhớt hoặc mùi lạ không phải dầu ăn.</p>
        <label className="grade-note-label" htmlFor="grade-note">Ghi chú phân hạng (không bắt buộc)</label>
        <textarea className="grade-note-input" id="grade-note" value={gradeNote} onChange={(event) => setGradeNote(event.target.value)} disabled={saving} placeholder="Ghi chú thêm nếu cần" />
      </section>
      <section className="liter-entry-card">
        <label htmlFor="actual-kilograms">Khối lượng (kg đã cân)</label>
        <div className="large-number-input"><button onClick={() => adjustKilograms(-0.5)} disabled={saving}>−</button><input id="actual-kilograms" type="number" inputMode="decimal" step="0.5" min="0" value={kilograms} onChange={(event) => setKilograms(event.target.value)} placeholder="0.0" /><span>kg</span><button onClick={() => adjustKilograms(0.5)} disabled={saving}>+</button></div>
        <p className={invalidKg ? 'error-text' : 'field-help'}>{actualKg === null ? 'Không có số cân? Hệ thống sẽ ước lượng kg từ số lít bên dưới.' : 'SCALE — số kg này là số cân thực tế.'}</p>
        <label htmlFor="actual-liters">Số lít thực tế</label>
        <div className="large-number-input"><button onClick={() => adjustLiters(-0.5)} disabled={saving}>−</button><input id="actual-liters" type="number" inputMode="decimal" step="0.5" min="0" value={liters} onChange={(event) => setLiters(event.target.value)} placeholder="0.0" /><span>lít</span><button onClick={() => adjustLiters(0.5)} disabled={saving}>+</button></div>
        <p className={invalidLiters && (liters || litersDerivedFromKilograms) ? 'error-text' : 'field-help'}>{litersDerivedFromKilograms ? `Số lít ước tính từ khối lượng: ${actualLiters.toFixed(2)} lít · dung tích tối đa ${maxLiters.toFixed(1)} lít` : `Dung tích ${formatLiters(capacity)} · tối đa ${maxLiters.toFixed(1)} lít`}</p>
        {pickupVolumeDeviation?.level === 'NORMAL' ? <p className="pickup-volume-deviation pickup-volume-deviation-normal">Sản lượng nằm gần mức AI dự báo.</p> : null}
        {pickupVolumeDeviation?.level === 'REVIEW' ? <p className="pickup-volume-deviation pickup-volume-deviation-review">Số lít đang chênh {formatDeviationPercent(pickupVolumeDeviation.deviation_pct)} so với AI dự báo. Hãy kiểm tra lại số nhập và mức dầu trong can.</p> : null}
        {pickupVolumeDeviation?.level === 'HIGH' ? <div className="pickup-volume-deviation pickup-volume-deviation-high"><strong>Chênh lệch rất cao so với AI dự báo.</strong><span>AI dự báo {formatPickupVolumeLiters(pickupVolumeDeviation.predicted_liters)}</span><span>Thực tế nhập {formatPickupVolumeLiters(pickupVolumeDeviation.actual_liters)}</span><span>Chênh lệch {formatSignedDeviationLiters(pickupVolumeDeviation.deviation_liters)} ({formatDeviationPercent(pickupVolumeDeviation.deviation_pct)})</span><label className="pickup-volume-ack"><input type="checkbox" checked={highDeviationAcknowledgement === highDeviationKey} onChange={(event) => setHighDeviationAcknowledgement(event.target.checked ? highDeviationKey : null)} disabled={saving} /><span>Tôi đã kiểm tra lại số lít và xác nhận tiếp tục.</span></label></div> : null}
      </section>
      <section className="quality-card"><p className="section-label">Chất lượng dầu</p><div className="quality-options"><button className={quality === Quality.PASS ? 'quality-option selected' : 'quality-option'} onClick={() => setQuality(Quality.PASS)} disabled={saving}>Đạt</button><button className={quality === Quality.FLAG ? 'quality-option selected flag-selected' : 'quality-option'} onClick={() => setQuality(Quality.FLAG)} disabled={saving}>Cần kiểm tra</button></div></section>
      <GradePhotoPicker photos={photos} busy={takingPhoto} disabled={saving} message={photoNotice} onTakePhoto={() => { void takePhoto(); }} onChooseAlbum={() => { void chooseAlbumPhoto(); }} onChooseFile={(file) => { void choosePhotoFile(file); }} onRemovePhoto={removePhoto} />
      {analysisError ? <section className="image-grade-analysis image-grade-analysis-error" role="alert"><span>{analysisError}</span><button type="button" className="secondary-button" onClick={() => { void analyzePhotos(photos); }} disabled={analyzingImages || saving}>Thử phân tích lại</button></section> : null}
      {analyzingImages ? <section className="image-grade-analysis image-grade-analysis-neutral" aria-live="polite"><strong>AI hỗ trợ phân hạng</strong><span>Đang phân tích ảnh…</span></section> : null}
      {imageGradeDisplay && !analyzingImages ? (
        <section className={`image-grade-analysis image-grade-analysis-${imageAnalysis?.confidence.toLowerCase() ?? 'low'}`} aria-label="AI hỗ trợ phân hạng">
          <div className="image-grade-analysis-heading"><span className="image-grade-ai-label">AI hỗ trợ</span><strong>Phân tích hình ảnh thử nghiệm</strong></div>
          {imageGradeDisplay.suggestedGrade ? <p><strong>Gợi ý: {imageGradeDisplay.suggestedGrade}</strong> · {imageGradeDisplay.confidenceLabel}</p> : <p><strong>Chưa có gợi ý phân hạng</strong> · {imageGradeDisplay.confidenceLabel}</p>}
          <small>{imageGradeDisplay.qualityLabel} · provider: {imageAnalysis?.provider ?? 'on-device-heuristic'} · model: {imageAnalysis?.model_version ?? 'unknown'}</small>
          <small>{imageGradeDisplay.summary}</small>
          {imageGradeDisplay.reasons.length > 0 ? <div className="image-grade-reasons">{imageGradeDisplay.reasons.map((reason, index) => <span key={`${reason}-${index}`}>{reason}</span>)}</div> : null}
          {suggestedGrade && grade && suggestedGrade !== grade ? <p className="image-grade-disagreement" role="status"><strong>Khác gợi ý:</strong> bạn chọn hạng {grade}, AI gợi ý hạng {suggestedGrade}. Lý do AI: {imageGradeDisplay.reasons.join(', ') || 'tín hiệu hình ảnh hạn chế'}.</p> : null}
          {imageGradeDisplay.canUseSuggestion && imageAnalysis?.suggested_grade ? <button type="button" className="secondary-button image-grade-use-button" onClick={() => { setGrade(imageAnalysis.suggested_grade as OilGrade); setOverrideAcknowledged(false); setGradeConfirmed(false); }} disabled={saving}>Dùng gợi ý này</button> : null}
          {needsImageGradeOverrideAcknowledgement ? <label className="image-grade-override"><input type="checkbox" checked={overrideAcknowledged} onChange={(event) => setOverrideAcknowledged(event.target.checked)} disabled={saving} /><span>Tôi đã kiểm tra và xác nhận giữ phân hạng đã chọn.</span></label> : null}
        </section>
      ) : null}
      {error ? <div className="error-panel">{error}</div> : null}
      {submitBlockReason ? <p className="error-text submit-block-reason">{submitBlockReason}</p> : null}
      <button className="submit-collection-button" onClick={() => { void submit(); }} disabled={saving || Boolean(submitBlockReason)}>{saving ? 'Đang lưu trên máy…' : 'Xác nhận thu gom'}</button>
    </div>
  );
}

function SavedStationReceiptView({ receipt, onBack }: { receipt: StoredStationReceipt; onBack: () => void }) {
  return (
    <div className="page-content collector-content station-page receipt-page">
      <button className="back-button" onClick={onBack}>Về tuyến hôm nay</button>
      <header className="collector-screen-heading"><p className="eyebrow">BIÊN NHẬN ĐÃ LƯU</p><h1>{receipt.station_name}</h1><p>Mã phiếu: {receipt.receipt_id}</p></header>
      <section className="receipt-card">
        <dl>
          <div><dt>Trạm</dt><dd>{receipt.station_id} · {receipt.station_name}</dd></div>
          <div><dt>Người thu gom</dt><dd>{receipt.collector_id}</dd></div>
          <div><dt>Tổng server đối soát</dt><dd>{formatLiters(receipt.expected_liters)}</dd></div>
          <div><dt>Thực tế đổ</dt><dd>{receipt.actual_liters === null ? 'Không có dữ liệu' : formatLiters(receipt.actual_liters)}</dd></div>
          <div><dt>Chênh lệch</dt><dd>{receipt.variance_liters === null ? 'Không có dữ liệu' : `${receipt.variance_liters.toFixed(1)} ${receipt.units.volume}`}</dd></div>
          <div><dt>Thời gian</dt><dd>{formatTime(receipt.created_at)}</dd></div>
        </dl>
      </section>
      <section className="delivery-transactions-card"><h2>Danh sách giao dịch ({receipt.transactions.length})</h2>{receipt.transactions.map((transaction) => <div className="delivery-transaction-row" key={transaction.transaction_id}><div><strong>{transaction.merchant_name}</strong><span>{transaction.transaction_id}</span></div><b>{formatLiters(transaction.liters)} · {(transaction.kilograms ?? 0).toFixed(1)} {receipt.units.mass}</b></div>)}</section>
    </div>
  );
}

function CollectorSummaryScreen({ route, completed, completedCount, totalStops, onBack, onOpenDelivery }: { route: CurrentRouteResponse | undefined; completed: Record<string, CompletedStop>; completedCount: number; totalStops: number; onBack: () => void; onOpenDelivery: () => void }) {
  const totalCollected = Object.values(completed).reduce((sum, item) => sum + item.liters, 0);
  const totalCollectedKg = Object.values(completed).reduce((sum, item) => sum + (item.kilograms ?? item.liters * DEFAULT_DENSITY_KG_PER_LITER), 0);
  const displayedTotalStops = Math.max(totalStops, completedCount);
  const vehicleCapacity = route ? route.total_expected_liters + route.remaining_capacity_l : 0;
  return (
    <div className="page-content collector-content summary-page">
      <button className="back-button" onClick={onBack}>Về tuyến hôm nay</button>
      <header className="collector-screen-heading"><p className="eyebrow">KẾT QUẢ CA</p><h1>Tóm tắt thu gom</h1></header>
      <div className="summary-hero"><span>Đã thu hôm nay</span><strong>{formatLiters(totalCollected)} (~{totalCollectedKg.toFixed(1)} kg)</strong></div>
      <section className="summary-grid"><div><span>Điểm đã thu</span><strong>{completedCount} / {displayedTotalStops}</strong></div><div><span>Dung tích còn lại</span><strong>{formatLiters(Math.max(vehicleCapacity - totalCollected, 0))}</strong></div></section>
      <button className="station-button" onClick={onOpenDelivery} disabled={completedCount === 0}>Đi nộp trạm <small>{completedCount === 0 ? 'Chưa có giao dịch' : 'Đối soát và chọn trạm'}</small></button>
    </div>
  );
}

function OutboxQueueScreen({ onBack }: { onBack: () => void }) {
  const rows = useOutboxRows();
  const stats = useOutboxStats();
  const [retrying, setRetrying] = useState<string | null>(null);

  async function retry(clientUuid: string): Promise<void> {
    setRetrying(clientUuid);
    try {
      await retryOutbox(clientUuid);
      await syncOutbox();
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className="page-content collector-content outbox-page">
      <button className="back-button" onClick={onBack}>Về tuyến hôm nay</button>
      <header className="collector-screen-heading"><p className="eyebrow">AN TOÀN DỮ LIỆU</p><h1>Hàng chờ đồng bộ</h1><p>{formatBytes(stats.bytes)} đang lưu trên máy</p></header>
      <OutboxIssueNotice rows={rows} stats={stats} />
      {stats.over_limit ? <div className="warning-panel"><strong>Hàng chờ đang vượt 50MB</strong><span>Hãy bật mạng để đồng bộ bớt dữ liệu ảnh.</span></div> : null}
      {rows.length === 0 ? <StatusView title="Hàng chờ đang trống" message="Mọi giao dịch đã được đồng bộ hoặc chưa phát sinh." /> : <section className="outbox-list">{rows.map((row) => <OutboxRow key={row.client_uuid} row={row} retrying={retrying === row.client_uuid} onRetry={() => { void retry(row.client_uuid); }} />)}</section>}
    </div>
  );
}

function OutboxRow({ row, retrying, onRetry }: { row: OutboxRecord; retrying: boolean; onRetry: () => void }) {
  const payload = row.payload as Partial<CollectionCreateRequest>;
  return (
    <article className="outbox-row">
      <div className="outbox-row-top"><span className={`outbox-dot outbox-dot-${row.status}`} /><strong>{formatLiters(Number(payload.actual_liters ?? Number(payload.actual_kg ?? 0) / DEFAULT_DENSITY_KG_PER_LITER))} · {statusLabel(row.status)}</strong></div>
      <p>UUID: {row.client_uuid}</p>
      <p>Tạo lúc {formatTime(row.created_at)} · Lần thử {row.attempts}</p>
      {row.last_error ? <div className="outbox-error">{outboxErrorMessage(row.last_error)}</div> : null}
      {row.status === 'failed' ? <button className="secondary-button" onClick={onRetry} disabled={retrying}>{retrying ? 'Đang thử lại…' : 'Thử lại thủ công'}</button> : null}
    </article>
  );
}

function findRowForStop(rows: OutboxRecord[], stop: RouteStop): OutboxRecord | undefined {
  return rows.find((row) => row.type === 'collection' && (row.payload as Partial<CollectionCreateRequest>).order_id === stop.order_id);
}

function statusLabel(status: OutboxRecord['status']): string {
  switch (status) {
    case 'pending': return 'Đang chờ đồng bộ';
    case 'syncing': return 'Đang đồng bộ';
    case 'synced': return 'Đã đồng bộ';
    case 'failed': return 'Giao dịch lỗi';
  }
}

function formatDistance(distanceM: number): string {
  return distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(1)} km`;
}

function formatTime(value: string | null): string {
  if (!value) return '--:--';
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
