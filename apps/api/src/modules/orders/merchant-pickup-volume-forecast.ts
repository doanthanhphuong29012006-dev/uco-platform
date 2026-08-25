export type MerchantVolumeHistoryPoint = {
  actual_liters: number | null;
  collected_at: Date | string;
};

export type MerchantPickupVolumeForecastInput = {
  container_capacity_liters: number | null;
  declared_estimated_liters: number | null;
  history: MerchantVolumeHistoryPoint[];
  as_of: Date | string;
};

export type MerchantPickupVolumeConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';

export type MerchantPickupVolumeReasonCode =
  | 'HISTORY_WEIGHTED'
  | 'DECLARED_ESTIMATE_BLEND'
  | 'DECLARED_ESTIMATE_ONLY'
  | 'LIMITED_HISTORY'
  | 'STABLE_HISTORY'
  | 'VOLATILE_HISTORY'
  | 'IGNORED_INVALID_HISTORY'
  | 'INVALID_DECLARED_ESTIMATE'
  | 'INVALID_CAPACITY'
  | 'INVALID_AS_OF'
  | 'PREDICTION_CAPPED_TO_CAPACITY'
  | 'MISSING_HISTORY_AND_ESTIMATE';

export type MerchantPickupVolumeForecastResult = {
  predicted_liters: number | null;
  confidence: MerchantPickupVolumeConfidence;
  sample_size: number;
  reason_codes: MerchantPickupVolumeReasonCode[];
};

type ValidHistoryPoint = {
  actual_liters: number;
  collected_at_ms: number;
  original_index: number;
};

const MAX_HISTORY_SIZE = 5;
const HISTORY_WEIGHTS = [5, 4, 3, 2, 1] as const;
const ROUNDING_FACTOR = 10;

function finiteNonNegative(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseDate(value: Date | string): number | null {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function pushReason(reasons: MerchantPickupVolumeReasonCode[], reason: MerchantPickupVolumeReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function weightedAverage(history: ValidHistoryPoint[]): number {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (let index = 0; index < history.length; index += 1) {
    const weight = HISTORY_WEIGHTS[index] ?? 1;
    weightedTotal += history[index]!.actual_liters * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weightedTotal / totalWeight;
}

function coefficientOfVariation(history: ValidHistoryPoint[]): number {
  if (history.length === 0) return 0;
  const mean = history.reduce((sum, point) => sum + point.actual_liters, 0) / history.length;
  if (mean === 0) return 0;
  const variance = history.reduce((sum, point) => sum + (point.actual_liters - mean) ** 2, 0) / history.length;
  return Math.sqrt(variance) / mean;
}

function confidenceFor(historySize: number, coefficientVariation: number): MerchantPickupVolumeConfidence {
  if (historySize === 0) return 'LOW';
  if (historySize >= 5 && coefficientVariation <= 0.25) return 'HIGH';
  if (historySize >= 3 && coefficientVariation <= 0.5) return 'MEDIUM';
  return 'LOW';
}

function roundOneDecimal(value: number): number {
  return Math.round(value * ROUNDING_FACTOR) / ROUNDING_FACTOR;
}

export function forecastMerchantPickupVolume(
  input: MerchantPickupVolumeForecastInput,
): MerchantPickupVolumeForecastResult {
  const capacity = finiteNonNegative(input.container_capacity_liters);
  if (capacity === null || capacity === 0) {
    return {
      predicted_liters: null,
      confidence: 'INSUFFICIENT_DATA',
      sample_size: 0,
      reason_codes: ['INVALID_CAPACITY'],
    };
  }

  const reasonCodes: MerchantPickupVolumeReasonCode[] = [];
  const asOfMs = parseDate(input.as_of);
  if (asOfMs === null) pushReason(reasonCodes, 'INVALID_AS_OF');

  const validHistory: ValidHistoryPoint[] = [];
  let ignoredHistory = false;
  if (asOfMs !== null) {
    input.history.forEach((point, originalIndex) => {
      const actualLiters = finiteNonNegative(point.actual_liters);
      const collectedAtMs = parseDate(point.collected_at);
      if (actualLiters === null || actualLiters > capacity || collectedAtMs === null || collectedAtMs > asOfMs) {
        ignoredHistory = true;
        return;
      }
      validHistory.push({ actual_liters: actualLiters, collected_at_ms: collectedAtMs, original_index: originalIndex });
    });
  }
  if (ignoredHistory) pushReason(reasonCodes, 'IGNORED_INVALID_HISTORY');

  validHistory.sort((left, right) => right.collected_at_ms - left.collected_at_ms || left.original_index - right.original_index);
  const recentHistory = validHistory.slice(0, MAX_HISTORY_SIZE);
  const sampleSize = recentHistory.length;
  const hasHistory = sampleSize > 0;
  const historyAverage = hasHistory ? weightedAverage(recentHistory) : null;
  if (hasHistory) pushReason(reasonCodes, 'HISTORY_WEIGHTED');

  const rawDeclared = input.declared_estimated_liters;
  const declaredValue = finiteNonNegative(rawDeclared);
  let declared = declaredValue;
  let declaredWasCapped = false;
  if (rawDeclared !== null && declaredValue === null) {
    pushReason(reasonCodes, 'INVALID_DECLARED_ESTIMATE');
  } else if (declared !== null && declared > capacity) {
    declared = capacity;
    declaredWasCapped = true;
  }

  let predicted: number | null = null;
  if (hasHistory && declared !== null) {
    const historyWeight = sampleSize >= 3 ? 0.8 : 0.6;
    const declaredWeight = 1 - historyWeight;
    predicted = historyAverage! * historyWeight + declared * declaredWeight;
    pushReason(reasonCodes, 'DECLARED_ESTIMATE_BLEND');
  } else if (hasHistory) {
    predicted = historyAverage;
  } else if (declared !== null) {
    predicted = declared;
    pushReason(reasonCodes, 'DECLARED_ESTIMATE_ONLY');
  } else {
    pushReason(reasonCodes, 'MISSING_HISTORY_AND_ESTIMATE');
  }

  const coefficientVariation = coefficientOfVariation(recentHistory);
  const confidence = predicted === null ? 'INSUFFICIENT_DATA' : confidenceFor(sampleSize, coefficientVariation);
  if (coefficientVariation <= 0.25 && hasHistory) {
    pushReason(reasonCodes, 'STABLE_HISTORY');
  } else if (coefficientVariation > 0.5 && hasHistory) {
    pushReason(reasonCodes, 'VOLATILE_HISTORY');
  }
  if (sampleSize < 3) pushReason(reasonCodes, 'LIMITED_HISTORY');

  if (declaredWasCapped) pushReason(reasonCodes, 'PREDICTION_CAPPED_TO_CAPACITY');
  let boundedPrediction = predicted;
  if (boundedPrediction !== null) {
    const clampedPrediction = Math.min(Math.max(boundedPrediction, 0), capacity);
    if (clampedPrediction !== boundedPrediction) pushReason(reasonCodes, 'PREDICTION_CAPPED_TO_CAPACITY');
    boundedPrediction = roundOneDecimal(clampedPrediction);
  }

  return {
    predicted_liters: boundedPrediction,
    confidence,
    sample_size: sampleSize,
    reason_codes: reasonCodes,
  };
}
