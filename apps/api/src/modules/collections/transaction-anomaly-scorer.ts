export type TransactionAnomalyLevel = 'NORMAL' | 'REVIEW' | 'HIGH_RISK';

export type TransactionAnomalyReason =
  | 'DENSITY_OUTLIER'
  | 'MASS_OR_VOLUME_OUTLIER'
  | 'COLLECTION_TIME_OUTLIER'
  | 'FREQUENCY_SPIKE';

export type TransactionAnomalyInput = {
  merchantId?: string | null;
  actualKg?: number | null;
  actualLiters?: number | null;
  collectedAt: Date | string | number;
};

type SignalStatus = 'NOT_EVALUATED' | 'NORMAL' | 'ANOMALOUS';

export type TransactionAnomalySignal = {
  status: SignalStatus;
  value: number | null;
  median: number | null;
  mad: number | null;
  robustZScore: number | null;
  sampleSize: number;
  contribution: number;
  fallback: 'INSUFFICIENT_HISTORY' | 'ZERO_MAD_RELATIVE_DEVIATION' | null;
};

export type TransactionAnomalyResult = {
  score: number;
  level: TransactionAnomalyLevel;
  reasons: TransactionAnomalyReason[];
  explanation: {
    historyCount: number;
    minimumHistoryRequired: number;
    densityKgPerLiter: TransactionAnomalySignal;
    massOrVolume: TransactionAnomalySignal & { metric: 'KG' | 'LITER' | null };
    collectionTime: TransactionAnomalySignal & { valueUnit: 'MINUTE_OF_DAY' };
    frequency: TransactionAnomalySignal & { valueUnit: 'TRANSACTIONS_PER_24H'; windowDays: number };
  };
};

const MIN_HISTORY = 5;
const ROBUST_Z_THRESHOLD = 3.5;
const ROBUST_Z_FULL_SCORE = 8;
const MAD_SCALE = 0.67448975;
const ZERO_MAD_SCORE_CAP_RATIO = 0.4;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const FREQUENCY_WINDOW_DAYS = 14;
const VIETNAM_UTC_OFFSET_MINUTES = 7 * 60;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function medianAbsoluteDeviation(values: number[], center: number): number {
  return median(values.map((value) => Math.abs(value - center)));
}

function emptySignal(sampleSize: number, value: number | null): TransactionAnomalySignal {
  return {
    status: 'NOT_EVALUATED',
    value,
    median: null,
    mad: null,
    robustZScore: null,
    sampleSize,
    contribution: 0,
    fallback: 'INSUFFICIENT_HISTORY',
  };
}

function evaluateSignal(
  value: number | null,
  samples: number[],
  maximumContribution: number,
  zeroMadRelativeThreshold: number,
): TransactionAnomalySignal {
  if (value === null || !Number.isFinite(value) || samples.length < MIN_HISTORY) {
    return emptySignal(samples.length, value);
  }

  const center = median(samples);
  const mad = medianAbsoluteDeviation(samples, center);
  if (mad > Number.EPSILON) {
    const robustZScore = (MAD_SCALE * Math.abs(value - center)) / mad;
    const contribution =
      robustZScore <= ROBUST_Z_THRESHOLD
        ? 0
        : Math.min(
            maximumContribution,
            ((robustZScore - ROBUST_Z_THRESHOLD) / (ROBUST_Z_FULL_SCORE - ROBUST_Z_THRESHOLD)) *
              maximumContribution,
          );
    return {
      status: contribution > 0 ? 'ANOMALOUS' : 'NORMAL',
      value,
      median: center,
      mad,
      robustZScore,
      sampleSize: samples.length,
      contribution,
      fallback: null,
    };
  }

  const relativeDeviation =
    Math.abs(center) > Number.EPSILON ? Math.abs(value - center) / Math.abs(center) : Math.abs(value - center);
  const fallbackCap = maximumContribution * ZERO_MAD_SCORE_CAP_RATIO;
  const contribution =
    relativeDeviation <= zeroMadRelativeThreshold
      ? 0
      : Math.min(fallbackCap, ((relativeDeviation - zeroMadRelativeThreshold) / zeroMadRelativeThreshold) * fallbackCap);
  return {
    status: contribution > 0 ? 'ANOMALOUS' : 'NORMAL',
    value,
    median: center,
    mad: 0,
    robustZScore: null,
    sampleSize: samples.length,
    contribution,
    fallback: 'ZERO_MAD_RELATIVE_DEVIATION',
  };
}

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function toTimestamp(value: Date | string | number): number | null {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function minuteOfVietnamDay(timestamp: number): number {
  const shifted = new Date(timestamp + VIETNAM_UTC_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function frequencySamples(historyTimestamps: number[], targetTimestamp: number): { current: number; samples: number[] } {
  const current =
    1 +
    historyTimestamps.filter(
      (timestamp) => timestamp < targetTimestamp && timestamp >= targetTimestamp - MILLISECONDS_PER_DAY,
    ).length;
  const samples = Array.from({ length: FREQUENCY_WINDOW_DAYS }, (_, index) => {
    const end = targetTimestamp - (index + 1) * MILLISECONDS_PER_DAY;
    const start = end - MILLISECONDS_PER_DAY;
    return historyTimestamps.filter((timestamp) => timestamp >= start && timestamp < end).length;
  });
  return { current, samples };
}

function rounded(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(4));
}

function roundSignal(signal: TransactionAnomalySignal): TransactionAnomalySignal {
  return {
    ...signal,
    value: rounded(signal.value),
    median: rounded(signal.median),
    mad: rounded(signal.mad),
    robustZScore: rounded(signal.robustZScore),
    contribution: rounded(signal.contribution) ?? 0,
  };
}

export function scoreTransactionAnomaly(
  history: readonly TransactionAnomalyInput[],
  transaction: TransactionAnomalyInput,
): TransactionAnomalyResult {
  const scopedHistory = transaction.merchantId
    ? history.filter((item) => item.merchantId === transaction.merchantId)
    : [...history];
  const targetTimestamp = toTimestamp(transaction.collectedAt);
  const historyWithTime = scopedHistory
    .map((item) => ({ item, timestamp: toTimestamp(item.collectedAt) }))
    .filter((entry): entry is { item: TransactionAnomalyInput; timestamp: number } => entry.timestamp !== null);

  const targetKg = positiveNumber(transaction.actualKg);
  const targetLiters = positiveNumber(transaction.actualLiters);
  const targetDensity = targetKg !== null && targetLiters !== null ? targetKg / targetLiters : null;
  const densitySamples = historyWithTime
    .map(({ item }) => {
      const kilograms = positiveNumber(item.actualKg);
      const liters = positiveNumber(item.actualLiters);
      return kilograms !== null && liters !== null ? kilograms / liters : null;
    })
    .filter((value): value is number => value !== null);
  const density = evaluateSignal(targetDensity, densitySamples, 35, 0.15);

  const kilograms = historyWithTime
    .map(({ item }) => positiveNumber(item.actualKg))
    .filter((value): value is number => value !== null);
  const liters = historyWithTime
    .map(({ item }) => positiveNumber(item.actualLiters))
    .filter((value): value is number => value !== null);
  const massMetric = targetKg !== null && kilograms.length >= MIN_HISTORY ? 'KG' : targetLiters !== null ? 'LITER' : null;
  const massOrVolume = evaluateSignal(
    massMetric === 'KG' ? targetKg : massMetric === 'LITER' ? targetLiters : null,
    massMetric === 'KG' ? kilograms : massMetric === 'LITER' ? liters : [],
    35,
    0.5,
  );

  const targetMinute = targetTimestamp === null ? null : minuteOfVietnamDay(targetTimestamp);
  const timeSamples = historyWithTime.map(({ timestamp }) => minuteOfVietnamDay(timestamp));
  const collectionTime = evaluateSignal(targetMinute, timeSamples, 15, 0.25);

  const frequencyData =
    targetTimestamp === null
      ? { current: null, samples: [] as number[] }
      : frequencySamples(
          historyWithTime.map(({ timestamp }) => timestamp),
          targetTimestamp,
        );
  const frequency =
    scopedHistory.length < MIN_HISTORY
      ? emptySignal(scopedHistory.length, frequencyData.current)
      : evaluateSignal(frequencyData.current, frequencyData.samples, 15, 1);

  const signalReasons: Array<[TransactionAnomalyReason, TransactionAnomalySignal]> = [
    ['DENSITY_OUTLIER', density],
    ['MASS_OR_VOLUME_OUTLIER', massOrVolume],
    ['COLLECTION_TIME_OUTLIER', collectionTime],
    ['FREQUENCY_SPIKE', frequency],
  ];
  const reasons = signalReasons.filter(([, signal]) => signal.status === 'ANOMALOUS').map(([reason]) => reason);
  const rawScore = signalReasons.reduce((total, [, signal]) => total + signal.contribution, 0);
  const onlyZeroMadEvidence = signalReasons.every(
    ([, signal]) => signal.contribution === 0 || signal.fallback === 'ZERO_MAD_RELATIVE_DEVIATION',
  );
  const score = Math.round(Math.max(0, Math.min(onlyZeroMadEvidence ? 49 : 100, rawScore)));
  const level: TransactionAnomalyLevel = score >= 60 ? 'HIGH_RISK' : score >= 30 ? 'REVIEW' : 'NORMAL';

  return {
    score,
    level,
    reasons,
    explanation: {
      historyCount: scopedHistory.length,
      minimumHistoryRequired: MIN_HISTORY,
      densityKgPerLiter: roundSignal(density),
      massOrVolume: { ...roundSignal(massOrVolume), metric: massMetric },
      collectionTime: { ...roundSignal(collectionTime), valueUnit: 'MINUTE_OF_DAY' },
      frequency: {
        ...roundSignal(frequency),
        valueUnit: 'TRANSACTIONS_PER_24H',
        windowDays: FREQUENCY_WINDOW_DAYS,
      },
    },
  };
}
