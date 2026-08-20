export type StationFillForecastStatus = 'INSUFFICIENT_DATA' | 'FULL' | 'CRITICAL' | 'WATCH' | 'STABLE';

export type StationFillForecastReasonCode =
  | 'HISTORY_BELOW_MINIMUM'
  | 'HISTORY_TRUNCATED_TO_7_DAYS'
  | 'STATION_ALREADY_FULL'
  | 'NO_INCOMING_FLOW'
  | 'FULL_WITHIN_3_DAYS'
  | 'FULL_WITHIN_7_DAYS'
  | 'CAPACITY_AVAILABLE_BEYOND_7_DAYS';

export type StationFillForecastInput = {
  capacityLiters: number;
  currentVolumeLiters: number;
  dailyIncomingLiters: readonly number[];
};

export type StationFillForecastResult = {
  averageDailyIncomingLiters: number;
  remainingCapacityLiters: number;
  estimatedDaysUntilFull: number | null;
  projectedVolumes: Array<{ day: number; volumeLiters: number }>;
  status: StationFillForecastStatus;
  historySize: number;
  reasonCodes: StationFillForecastReasonCode[];
  explanation: {
    summary: string;
    usedDailyIncomingLiters: number[];
    calculationWindowDays: number;
    formula: string;
  };
};

export type StationFillForecastInputErrorCode =
  | 'INVALID_CAPACITY'
  | 'INVALID_CURRENT_VOLUME'
  | 'INVALID_DAILY_INCOMING';

export class StationFillForecastInputError extends RangeError {
  constructor(
    readonly code: StationFillForecastInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StationFillForecastInputError';
  }
}

const MAX_HISTORY_DAYS = 7;
const MIN_HISTORY_DAYS = 3;
const PROJECTION_DAYS = 7;

function round(value: number, decimals = 3): number {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function validateInput(input: StationFillForecastInput): void {
  if (!Number.isFinite(input.capacityLiters) || input.capacityLiters <= 0) {
    throw new StationFillForecastInputError(
      'INVALID_CAPACITY',
      'Sức chứa tối đa của trạm phải là một số hữu hạn lớn hơn 0.',
    );
  }
  if (!Number.isFinite(input.currentVolumeLiters) || input.currentVolumeLiters < 0) {
    throw new StationFillForecastInputError(
      'INVALID_CURRENT_VOLUME',
      'Lượng dầu hiện có phải là một số hữu hạn không âm.',
    );
  }
  if (input.dailyIncomingLiters.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new StationFillForecastInputError(
      'INVALID_DAILY_INCOMING',
      'Lịch sử dầu nhập theo ngày chỉ được chứa các số hữu hạn không âm.',
    );
  }
}

function summaryFor(status: StationFillForecastStatus): string {
  switch (status) {
    case 'FULL':
      return 'Trạm đã đạt hoặc vượt sức chứa tối đa.';
    case 'CRITICAL':
      return 'Theo tốc độ nhập gần đây, trạm có thể đầy trong tối đa 3 ngày.';
    case 'WATCH':
      return 'Theo tốc độ nhập gần đây, trạm có thể đầy trong tối đa 7 ngày.';
    case 'INSUFFICIENT_DATA':
      return 'Chưa đủ 3 ngày lịch sử để kết luận mức cảnh báo.';
    case 'STABLE':
      return 'Trạm còn sức chứa trên 7 ngày hoặc chưa ghi nhận dòng dầu vào.';
  }
}

export function forecastStationFill(input: StationFillForecastInput): StationFillForecastResult {
  validateInput(input);

  const recentHistory = input.dailyIncomingLiters.slice(-MAX_HISTORY_DAYS);
  const historySize = recentHistory.length;
  const averageDailyIncomingLiters =
    historySize === 0 ? 0 : round(recentHistory.reduce((total, value) => total + value, 0) / historySize);
  const boundedCurrentVolume = Math.min(input.currentVolumeLiters, input.capacityLiters);
  const remainingCapacityLiters = round(Math.max(0, input.capacityLiters - boundedCurrentVolume));
  const alreadyFull = input.currentVolumeLiters >= input.capacityLiters;
  const estimatedDaysUntilFull = alreadyFull
    ? 0
    : averageDailyIncomingLiters > 0
      ? round(remainingCapacityLiters / averageDailyIncomingLiters)
      : null;
  const projectedVolumes = Array.from({ length: PROJECTION_DAYS }, (_, index) => ({
    day: index + 1,
    volumeLiters: round(
      Math.min(input.capacityLiters, Math.max(0, boundedCurrentVolume + averageDailyIncomingLiters * (index + 1))),
    ),
  }));

  const reasonCodes: StationFillForecastReasonCode[] = [];
  if (input.dailyIncomingLiters.length > MAX_HISTORY_DAYS) reasonCodes.push('HISTORY_TRUNCATED_TO_7_DAYS');

  let status: StationFillForecastStatus;
  if (alreadyFull) {
    status = 'FULL';
    reasonCodes.push('STATION_ALREADY_FULL');
  } else if (historySize < MIN_HISTORY_DAYS) {
    status = 'INSUFFICIENT_DATA';
    reasonCodes.push('HISTORY_BELOW_MINIMUM');
    if (averageDailyIncomingLiters === 0) reasonCodes.push('NO_INCOMING_FLOW');
  } else if (estimatedDaysUntilFull === null) {
    status = 'STABLE';
    reasonCodes.push('NO_INCOMING_FLOW');
  } else if (estimatedDaysUntilFull <= 3) {
    status = 'CRITICAL';
    reasonCodes.push('FULL_WITHIN_3_DAYS');
  } else if (estimatedDaysUntilFull <= 7) {
    status = 'WATCH';
    reasonCodes.push('FULL_WITHIN_7_DAYS');
  } else {
    status = 'STABLE';
    reasonCodes.push('CAPACITY_AVAILABLE_BEYOND_7_DAYS');
  }

  return {
    averageDailyIncomingLiters,
    remainingCapacityLiters,
    estimatedDaysUntilFull,
    projectedVolumes,
    status,
    historySize,
    reasonCodes,
    explanation: {
      summary: summaryFor(status),
      usedDailyIncomingLiters: [...recentHistory],
      calculationWindowDays: historySize,
      formula: 'Số ngày đến khi đầy = sức chứa còn lại / lượng dầu nhập trung bình mỗi ngày.',
    },
  };
}
