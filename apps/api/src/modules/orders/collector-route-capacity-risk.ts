export type CapacityRiskForecastConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';

export type CapacityRiskStop = {
  declared_liters: number | null;
  predicted_liters: number | null;
  forecast_confidence: CapacityRiskForecastConfidence | null;
  container_capacity_liters: number | null;
};

export type CollectorRouteCapacityRiskInput = {
  vehicle_capacity_liters: number | null;
  stops: CapacityRiskStop[];
};

export type CollectorRouteCapacityRiskLevel =
  | 'OVER_CAPACITY'
  | 'NEAR_CAPACITY'
  | 'BALANCED'
  | 'UNDERUTILIZED'
  | 'INSUFFICIENT_DATA';

export type CollectorRouteCapacityRiskReasonCode =
  | 'FORECAST_HIGH_CONFIDENCE'
  | 'FORECAST_MIXED_CONFIDENCE'
  | 'LOW_CONFIDENCE_FORECAST'
  | 'DECLARED_VOLUME_FALLBACK'
  | 'MISSING_STOP_VOLUME'
  | 'INVALID_STOP_VOLUME'
  | 'INVALID_CONTAINER_CAPACITY'
  | 'INVALID_VEHICLE_CAPACITY'
  | 'NO_STOPS'
  | 'RISK_BUFFER_APPLIED'
  | 'PREDICTED_OVER_CAPACITY'
  | 'PREDICTED_NEAR_CAPACITY'
  | 'PREDICTED_BALANCED'
  | 'PREDICTED_UNDERUTILIZED';

export type CollectorRouteCapacityRiskResult = {
  predicted_total_liters: number | null;
  risk_adjusted_total_liters: number | null;
  risk_adjusted_remaining_liters: number | null;
  risk_utilization_pct: number | null;
  level: CollectorRouteCapacityRiskLevel;
  confidence: CapacityRiskForecastConfidence;
  forecast_coverage_pct: number;
  reason_codes: CollectorRouteCapacityRiskReasonCode[];
};

const RISK_MULTIPLIERS: Record<CapacityRiskForecastConfidence, number> = {
  HIGH: 1.05,
  MEDIUM: 1.1,
  LOW: 1.2,
  INSUFFICIENT_DATA: 1.25,
};

const REASON_ORDER: CollectorRouteCapacityRiskReasonCode[] = [
  'FORECAST_HIGH_CONFIDENCE',
  'FORECAST_MIXED_CONFIDENCE',
  'LOW_CONFIDENCE_FORECAST',
  'DECLARED_VOLUME_FALLBACK',
  'MISSING_STOP_VOLUME',
  'INVALID_STOP_VOLUME',
  'INVALID_CONTAINER_CAPACITY',
  'INVALID_VEHICLE_CAPACITY',
  'NO_STOPS',
  'RISK_BUFFER_APPLIED',
  'PREDICTED_OVER_CAPACITY',
  'PREDICTED_NEAR_CAPACITY',
  'PREDICTED_BALANCED',
  'PREDICTED_UNDERUTILIZED',
];

function validNonNegative(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validPositive(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function safeAdd(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function safeMultiply(value: number, multiplier: number): number {
  if (value === 0) return 0;
  if (value > Number.MAX_VALUE / multiplier) return Number.MAX_VALUE;
  return value * multiplier;
}

function roundLiters(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Number.isFinite(rounded) ? rounded : value;
}

function roundPercent(value: number): number {
  const percent = value * 100;
  return Number.isFinite(percent) ? Math.round(percent) : Number.MAX_VALUE;
}

function normalizeConfidence(value: CapacityRiskForecastConfidence | null): CapacityRiskForecastConfidence {
  return value === 'HIGH' || value === 'MEDIUM' || value === 'LOW' || value === 'INSUFFICIENT_DATA'
    ? value
    : 'INSUFFICIENT_DATA';
}

function finishReasons(flags: Set<CollectorRouteCapacityRiskReasonCode>): CollectorRouteCapacityRiskReasonCode[] {
  return REASON_ORDER.filter((reason) => flags.has(reason));
}

export function assessCollectorRouteCapacityRisk(
  input: CollectorRouteCapacityRiskInput,
): CollectorRouteCapacityRiskResult {
  const vehicleCapacity = input.vehicle_capacity_liters;
  if (!validPositive(vehicleCapacity)) {
    return {
      predicted_total_liters: null,
      risk_adjusted_total_liters: null,
      risk_adjusted_remaining_liters: null,
      risk_utilization_pct: null,
      level: 'INSUFFICIENT_DATA',
      confidence: 'INSUFFICIENT_DATA',
      forecast_coverage_pct: 0,
      reason_codes: ['INVALID_VEHICLE_CAPACITY'],
    };
  }

  if (input.stops.length === 0) {
    return {
      predicted_total_liters: 0,
      risk_adjusted_total_liters: 0,
      risk_adjusted_remaining_liters: roundLiters(vehicleCapacity),
      risk_utilization_pct: 0,
      level: 'INSUFFICIENT_DATA',
      confidence: 'INSUFFICIENT_DATA',
      forecast_coverage_pct: 0,
      reason_codes: ['NO_STOPS'],
    };
  }

  const reasons = new Set<CollectorRouteCapacityRiskReasonCode>();
  let predictedTotal = 0;
  let riskAdjustedTotal = 0;
  let forecastCount = 0;
  let usableStopCount = 0;
  let fallbackUsed = false;
  let invalidVolumeFound = false;
  let invalidContainerFound = false;
  const confidences: CapacityRiskForecastConfidence[] = [];

  for (const stop of input.stops) {
    const predictionValid = validNonNegative(stop.predicted_liters);
    const declaredValid = validNonNegative(stop.declared_liters);
    const containerCapacity = stop.container_capacity_liters;
    const containerCapacityValid = containerCapacity === null || validPositive(containerCapacity);
    if (!containerCapacityValid) invalidContainerFound = true;
    if ((stop.predicted_liters !== null && !predictionValid) || (stop.declared_liters !== null && !declaredValid)) {
      invalidVolumeFound = true;
    }
    if (predictionValid) forecastCount += 1;

    let baseVolume: number | null = null;
    let confidence = normalizeConfidence(stop.forecast_confidence);
    if (predictionValid) {
      baseVolume = stop.predicted_liters;
    } else if (declaredValid) {
      baseVolume = stop.declared_liters;
      fallbackUsed = true;
      confidence = 'INSUFFICIENT_DATA';
    } else {
      if (stop.predicted_liters !== null || stop.declared_liters !== null) invalidVolumeFound = true;
      continue;
    }
    if (baseVolume === null) continue;

    if (containerCapacityValid && containerCapacity !== null && baseVolume > containerCapacity) {
      baseVolume = containerCapacity;
    }

    usableStopCount += 1;
    confidences.push(confidence);
    predictedTotal = safeAdd(predictedTotal, baseVolume);
    const multiplier = RISK_MULTIPLIERS[confidence];
    let riskVolume = safeMultiply(baseVolume, multiplier);
    if (containerCapacityValid && containerCapacity !== null && riskVolume > containerCapacity) {
      riskVolume = containerCapacity;
    }
    riskAdjustedTotal = safeAdd(riskAdjustedTotal, riskVolume);
  }

  if (fallbackUsed) reasons.add('DECLARED_VOLUME_FALLBACK');
  if (invalidVolumeFound) reasons.add('INVALID_STOP_VOLUME');
  if (input.stops.some((stop) => stop.predicted_liters === null && stop.declared_liters === null)) reasons.add('MISSING_STOP_VOLUME');
  if (invalidContainerFound) reasons.add('INVALID_CONTAINER_CAPACITY');

  const forecastCoverage = Math.round((forecastCount / input.stops.length) * 100);
  let confidence: CapacityRiskForecastConfidence;
  if (usableStopCount === 0) {
    confidence = 'INSUFFICIENT_DATA';
  } else {
    const uniqueConfidences = new Set(confidences);
    const allHigh = forecastCoverage === 100 && confidences.every((item) => item === 'HIGH');
    const allMediumEligible = forecastCoverage === 100
      && !confidences.some((item) => item === 'LOW' || item === 'INSUFFICIENT_DATA')
      && confidences.some((item) => item === 'MEDIUM');
    confidence = allHigh ? 'HIGH' : allMediumEligible ? 'MEDIUM' : 'LOW';
    if (allHigh) reasons.add('FORECAST_HIGH_CONFIDENCE');
    if (allMediumEligible || uniqueConfidences.size > 1) reasons.add('FORECAST_MIXED_CONFIDENCE');
    if (confidence === 'LOW') reasons.add('LOW_CONFIDENCE_FORECAST');
  }

  if (usableStopCount > 0) reasons.add('RISK_BUFFER_APPLIED');
  const riskUtilization = riskAdjustedTotal / vehicleCapacity;
  const riskUtilizationPct = roundPercent(riskUtilization);
  let level: CollectorRouteCapacityRiskLevel;
  if (usableStopCount === 0) {
    level = 'INSUFFICIENT_DATA';
  } else if (riskUtilizationPct > 100) {
    level = 'OVER_CAPACITY';
    reasons.add('PREDICTED_OVER_CAPACITY');
  } else if (riskUtilizationPct >= 85) {
    level = 'NEAR_CAPACITY';
    reasons.add('PREDICTED_NEAR_CAPACITY');
  } else if (riskUtilizationPct >= 60) {
    level = 'BALANCED';
    reasons.add('PREDICTED_BALANCED');
  } else {
    level = 'UNDERUTILIZED';
    reasons.add('PREDICTED_UNDERUTILIZED');
  }

  return {
    predicted_total_liters: roundLiters(predictedTotal),
    risk_adjusted_total_liters: roundLiters(riskAdjustedTotal),
    risk_adjusted_remaining_liters: roundLiters(vehicleCapacity - riskAdjustedTotal),
    risk_utilization_pct: riskUtilizationPct,
    level,
    confidence,
    forecast_coverage_pct: forecastCoverage,
    reason_codes: finishReasons(reasons),
  };
}
