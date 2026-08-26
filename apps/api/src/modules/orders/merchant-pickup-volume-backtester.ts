import {
  forecastMerchantPickupVolume,
  type MerchantPickupVolumeConfidence,
} from './merchant-pickup-volume-forecast';

export type PickupForecastBacktestObservation = {
  id?: string;
  merchant_id: string;
  merchant_name: string;
  collected_at: Date | string;
  actual_liters: number;
  declared_estimated_liters: number | null;
  container_capacity_liters: number | null;
};

export type PickupForecastBacktestReliability = 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';

export type PickupForecastBacktestPoint = {
  merchant_id: string;
  merchant_name: string;
  collected_at: string;
  predicted_liters: number;
  actual_liters: number;
  absolute_error_liters: number;
  error_percentage_pct: number | null;
  confidence: MerchantPickupVolumeConfidence;
  history_sample_size: number;
  direction: 'HIGHER_THAN_ACTUAL' | 'LOWER_THAN_ACTUAL' | 'MATCH';
};

export type PickupForecastBacktestResult = {
  sample_count: number;
  mae_liters: number | null;
  wape_pct: number | null;
  bias_liters: number | null;
  accuracy_pct: number | null;
  within_10_pct_count: number;
  within_20_pct_count: number;
  reliability: PickupForecastBacktestReliability;
  points: PickupForecastBacktestPoint[];
  explanation: {
    method: 'ROLLING_ORIGIN';
    summary: string;
    data_leakage_prevention: string;
  };
};

type OrderedObservation = PickupForecastBacktestObservation & { original_index: number; collected_at_ms: number };

function parseTimestamp(value: Date | string): number | null {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function finiteNonNegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function reliabilityFor(sampleCount: number): PickupForecastBacktestReliability {
  if (sampleCount < 5) return 'INSUFFICIENT';
  if (sampleCount < 10) return 'LOW';
  if (sampleCount < 20) return 'MEDIUM';
  return 'HIGH';
}

function isWithinRelativeError(absoluteError: number, actual: number, threshold: number): boolean {
  if (actual === 0) return absoluteError === 0;
  return absoluteError / Math.abs(actual) <= threshold;
}

export function evaluatePickupVolumeBacktest(
  observations: PickupForecastBacktestObservation[],
): PickupForecastBacktestResult {
  const ordered = observations
    .map((observation, original_index) => ({
      ...observation,
      original_index,
      collected_at_ms: parseTimestamp(observation.collected_at),
    }))
    .filter((observation): observation is OrderedObservation => observation.collected_at_ms !== null)
    .sort((left, right) => left.collected_at_ms - right.collected_at_ms || left.original_index - right.original_index);

  const points: PickupForecastBacktestPoint[] = [];
  for (const target of ordered) {
    const actual = finiteNonNegative(target.actual_liters);
    if (actual === null) continue;

    const history = ordered
      .filter(
        (candidate) =>
          candidate.merchant_id === target.merchant_id && candidate.collected_at_ms < target.collected_at_ms,
      )
      .map((candidate) => ({ actual_liters: candidate.actual_liters, collected_at: new Date(candidate.collected_at_ms) }));

    const forecast = forecastMerchantPickupVolume({
      container_capacity_liters: target.container_capacity_liters,
      declared_estimated_liters: target.declared_estimated_liters,
      history,
      as_of: new Date(target.collected_at_ms),
    });
    if (forecast.predicted_liters === null || forecast.sample_size === 0 || !Number.isFinite(forecast.predicted_liters)) continue;

    const absoluteError = Math.abs(forecast.predicted_liters - actual);
    const errorPercentage = actual === 0 ? null : (absoluteError / Math.abs(actual)) * 100;
    points.push({
      merchant_id: target.merchant_id,
      merchant_name: target.merchant_name,
      collected_at: new Date(target.collected_at_ms).toISOString(),
      predicted_liters: forecast.predicted_liters,
      actual_liters: actual,
      absolute_error_liters: round(absoluteError),
      error_percentage_pct: errorPercentage === null ? null : round(errorPercentage),
      confidence: forecast.confidence,
      history_sample_size: forecast.sample_size,
      direction:
        forecast.predicted_liters > actual
          ? 'HIGHER_THAN_ACTUAL'
          : forecast.predicted_liters < actual
            ? 'LOWER_THAN_ACTUAL'
            : 'MATCH',
    });
  }

  const totalAbsoluteError = points.reduce((sum, point) => sum + point.absolute_error_liters, 0);
  const totalActual = points.reduce((sum, point) => sum + point.actual_liters, 0);
  const bias = points.reduce((sum, point) => sum + (point.predicted_liters - point.actual_liters), 0);
  const wape = totalActual === 0 ? null : (totalAbsoluteError / totalActual) * 100;

  return {
    sample_count: points.length,
    mae_liters: points.length === 0 ? null : round(totalAbsoluteError / points.length),
    wape_pct: wape === null ? null : round(wape),
    bias_liters: points.length === 0 ? null : round(bias / points.length),
    accuracy_pct: wape === null ? null : round(Math.max(0, 100 - wape)),
    within_10_pct_count: points.filter((point) => isWithinRelativeError(point.absolute_error_liters, point.actual_liters, 0.1)).length,
    within_20_pct_count: points.filter((point) => isWithinRelativeError(point.absolute_error_liters, point.actual_liters, 0.2)).length,
    reliability: reliabilityFor(points.length),
    points: [...points].sort((left, right) => right.collected_at.localeCompare(left.collected_at)).slice(0, 30),
    explanation: {
      method: 'ROLLING_ORIGIN',
      summary: 'Đánh giá backtest chỉ sử dụng dữ liệu có trước mỗi lần thu gom.',
      data_leakage_prevention: 'Mỗi dự báo chỉ nhận các giao dịch cùng quán xảy ra trước thời điểm giao dịch được đánh giá.',
    },
  };
}
