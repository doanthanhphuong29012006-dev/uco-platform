export type TransactionAnomalyLevel = 'NORMAL' | 'REVIEW' | 'HIGH_RISK';

export type TransactionAnomalyReason =
  | 'DENSITY_OUTLIER'
  | 'MASS_OR_VOLUME_OUTLIER'
  | 'COLLECTION_TIME_OUTLIER'
  | 'FREQUENCY_SPIKE';

export type TransactionAnomalyReasonSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export type TransactionAnomalyReasonDetail = {
  code: TransactionAnomalyReason | 'INSUFFICIENT_HISTORY';
  label: string;
  description: string;
  contribution: number | null;
  evidence: Record<string, unknown>;
  severity: TransactionAnomalyReasonSeverity;
};

export type TransactionAnomalyInput = {
  merchantId?: string | null;
  actualKg?: number | null;
  actualLiters?: number | null;
  massSource?: 'SCALE' | 'ESTIMATED_FROM_VOLUME' | null;
  densityFactor?: number | null;
  expectedDensityKgPerLiter?: number | null;
  collectedAt: Date | string | number;
};

type SignalStatus = 'NOT_EVALUATED' | 'NORMAL' | 'ANOMALOUS';
type SignalFallback =
  | 'INSUFFICIENT_HISTORY'
  | 'ZERO_MAD_RELATIVE_DEVIATION'
  | 'CONFIGURED_DENSITY_BASELINE'
  | null;

export type TransactionAnomalySignal = {
  status: SignalStatus;
  value: number | null;
  median: number | null;
  mad: number | null;
  robustZScore: number | null;
  sampleSize: number;
  contribution: number;
  fallback: SignalFallback;
};

export type TransactionAnomalyResult = {
  score: number;
  level: TransactionAnomalyLevel;
  reasons: TransactionAnomalyReason[];
  reasonDetails: TransactionAnomalyReasonDetail[];
  explanationSummary: string;
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
const DENSITY_MAX_CONTRIBUTION = 35;
const DENSITY_CONFIG_DEVIATION_THRESHOLD = 0.2;
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
  zeroMadScoreCapRatio = ZERO_MAD_SCORE_CAP_RATIO,
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
  const fallbackCap = maximumContribution * zeroMadScoreCapRatio;
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

function evaluateConfiguredDensitySignal(
  value: number | null,
  expectedDensity: number | null,
  sampleSize: number,
): TransactionAnomalySignal {
  if (
    value === null ||
    expectedDensity === null ||
    !Number.isFinite(value) ||
    !Number.isFinite(expectedDensity) ||
    expectedDensity <= 0
  ) {
    return emptySignal(sampleSize, value);
  }

  const relativeDeviation = Math.abs(value - expectedDensity) / expectedDensity;
  const excessRatio = Math.max(
    0,
    (relativeDeviation - DENSITY_CONFIG_DEVIATION_THRESHOLD) / (1 - DENSITY_CONFIG_DEVIATION_THRESHOLD),
  );
  const contribution = Math.min(DENSITY_MAX_CONTRIBUTION, excessRatio * DENSITY_MAX_CONTRIBUTION);
  return {
    status: contribution > 0 ? 'ANOMALOUS' : 'NORMAL',
    value,
    median: expectedDensity,
    mad: null,
    robustZScore: null,
    sampleSize,
    contribution,
    fallback: 'CONFIGURED_DENSITY_BASELINE',
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

const REASON_PRESENTATION: Record<TransactionAnomalyReason, Omit<TransactionAnomalyReasonDetail, 'contribution' | 'evidence'>> = {
  DENSITY_OUTLIER: {
    code: 'DENSITY_OUTLIER',
    label: 'Tỷ lệ kg/lít bất thường',
    description: 'Mật độ khối lượng trên thể tích lệch khỏi lịch sử của quán.',
    severity: 'HIGH',
  },
  MASS_OR_VOLUME_OUTLIER: {
    code: 'MASS_OR_VOLUME_OUTLIER',
    label: 'Khối lượng hoặc thể tích bất thường',
    description: 'Khối lượng hoặc thể tích lệch mạnh khỏi lịch sử của quán.',
    severity: 'HIGH',
  },
  COLLECTION_TIME_OUTLIER: {
    code: 'COLLECTION_TIME_OUTLIER',
    label: 'Thời gian thu gom khác thường',
    description: 'Thời điểm thu gom khác đáng kể so với lịch sử.',
    severity: 'MEDIUM',
  },
  FREQUENCY_SPIKE: {
    code: 'FREQUENCY_SPIKE',
    label: 'Tần suất giao dịch tăng đột biến',
    description: 'Tần suất giao dịch gần đây cao hơn mức lịch sử.',
    severity: 'MEDIUM',
  },
};

function signalEvidence(signal: TransactionAnomalySignal): Record<string, unknown> {
  return {
    value: signal.value,
    median: signal.median,
    mad: signal.mad,
    robust_z_score: signal.robustZScore,
    sample_size: signal.sampleSize,
    fallback: signal.fallback,
  };
}

function densityEvidence(
  signal: TransactionAnomalySignal,
  transaction: TransactionAnomalyInput,
): Record<string, unknown> {
  const actualDensity = signal.value;
  const expectedDensity = signal.median;
  const relativeDeviationPercent =
    actualDensity !== null && expectedDensity !== null && expectedDensity > 0
      ? Number(((Math.abs(actualDensity - expectedDensity) / expectedDensity) * 100).toFixed(2))
      : null;
  return {
    ...signalEvidence(signal),
    actual_density: rounded(actualDensity),
    expected_density: rounded(expectedDensity),
    relative_deviation_percent: relativeDeviationPercent,
    mass_source: transaction.massSource ?? null,
    density_factor: transaction.densityFactor ?? null,
    source: signal.fallback === 'CONFIGURED_DENSITY_BASELINE'
      ? 'DOMAIN_DENSITY_BASELINE'
      : 'SCALE_HISTORY_BASELINE',
  };
}

function reasonSeverity(signal: TransactionAnomalySignal, fallback: TransactionAnomalyReasonSeverity): TransactionAnomalyReasonSeverity {
  if (signal.contribution >= 20) return 'HIGH';
  if (signal.contribution >= 10) return 'MEDIUM';
  return fallback;
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
  const targetDensity = transaction.massSource === 'SCALE' && targetKg !== null && targetLiters !== null
    ? targetKg / targetLiters
    : null;
  const scaleDensitySamples = historyWithTime
    .filter(({ item }) => item.massSource === 'SCALE')
    .map(({ item }) => {
      const kilograms = positiveNumber(item.actualKg);
      const liters = positiveNumber(item.actualLiters);
      return kilograms !== null && liters !== null ? kilograms / liters : null;
    })
    .filter((value): value is number => value !== null);
  const density = targetDensity === null
    ? emptySignal(scaleDensitySamples.length, null)
    : scaleDensitySamples.length >= MIN_HISTORY
      ? evaluateSignal(targetDensity, scaleDensitySamples, DENSITY_MAX_CONTRIBUTION, 0.15, 1)
      : evaluateConfiguredDensitySignal(
          targetDensity,
          positiveNumber(transaction.expectedDensityKgPerLiter),
          scaleDensitySamples.length,
        );

  const kilograms = historyWithTime
    .filter(({ item }) => item.massSource === 'SCALE')
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
  const signalByReason = new Map<TransactionAnomalyReason, TransactionAnomalySignal>(signalReasons);
  const reasonDetails: TransactionAnomalyReasonDetail[] = reasons.map((reason) => {
    const signal = signalByReason.get(reason)!;
    const presentation = REASON_PRESENTATION[reason];
    return {
      ...presentation,
      contribution: signal.contribution > 0 ? rounded(signal.contribution) : null,
      evidence: reason === 'DENSITY_OUTLIER' ? densityEvidence(signal, transaction) : signalEvidence(signal),
      severity: reasonSeverity(signal, presentation.severity),
    };
  });
  if (scopedHistory.length < MIN_HISTORY) {
    reasonDetails.push({
      code: 'INSUFFICIENT_HISTORY',
      label: 'Chưa đủ lịch sử',
      description: 'Chưa đủ dữ liệu lịch sử để kết luận tín hiệu bất thường.',
      contribution: null,
      evidence: { history_count: scopedHistory.length, minimum_history_required: MIN_HISTORY },
      severity: 'LOW',
    });
  }
  const explanationSummary =
    reasonDetails.length === 0
      ? 'Không phát hiện tín hiệu bất thường từ các dữ liệu hiện có.'
      : reasonDetails.some((reason) => reason.code !== 'INSUFFICIENT_HISTORY')
        ? `Phát hiện ${reasons.length} tín hiệu cần xem xét dựa trên dữ liệu lịch sử của quán.`
        : 'Chưa đủ lịch sử để kết luận giao dịch bất thường.';

  return {
    score,
    level,
    reasons,
    reasonDetails,
    explanationSummary,
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
