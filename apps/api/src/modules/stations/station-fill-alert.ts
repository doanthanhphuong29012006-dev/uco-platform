import type {
  StationFillForecastReasonCode,
  StationFillForecastResult,
  StationFillForecastStatus,
} from './station-fill-forecast';

export type StationFillAlertSeverity = 'HIGH' | 'MEDIUM';

export type StationFillAlertStatus = Extract<
  StationFillForecastStatus,
  'FULL' | 'CRITICAL' | 'WATCH'
>;

export type StationFillAlertCandidate = {
  station_id: string;
  station_name: string;
  severity: StationFillAlertSeverity;
  forecast_status: StationFillAlertStatus;
  estimated_days_until_full: number | null;
  reason_codes: StationFillForecastReasonCode[];
  message: string;
  trigger: 'CAPACITY' | 'STORAGE_AGE';
  storage_age_days: number | null;
  max_storage_days: number;
};

export type StationFillAlertStation = {
  id: string;
  name: string;
};

function alertMessage(
  stationName: string,
  status: StationFillAlertStatus,
  estimatedDaysUntilFull: number | null,
): string {
  if (status === 'FULL') return `Trạm ${stationName} đã đầy, cần xử lý ngay.`;
  if (estimatedDaysUntilFull === null) {
    return status === 'CRITICAL'
      ? `Trạm ${stationName} đang ở mức nguy cấp, cần xử lý sớm.`
      : `Trạm ${stationName} cần được theo dõi sức chứa.`;
  }
  return status === 'CRITICAL'
    ? `Trạm ${stationName} có thể đầy trong ${estimatedDaysUntilFull} ngày, cần xử lý sớm.`
    : `Trạm ${stationName} có thể đầy trong ${estimatedDaysUntilFull} ngày.`;
}

export function buildStationFillAlertCandidate(
  station: StationFillAlertStation,
  forecast?: StationFillForecastResult | null,
): StationFillAlertCandidate | null {
  if (!forecast) return null;
  const capacityNeedsAction = ['FULL', 'CRITICAL', 'WATCH'].includes(forecast.status);
  const ageNeedsAction = ['WATCH', 'CRITICAL', 'OVERDUE'].includes(forecast.storageAgeStatus);
  if (!capacityNeedsAction && !ageNeedsAction) return null;

  const trigger = capacityNeedsAction ? 'CAPACITY' : 'STORAGE_AGE';
  const forecastStatus = capacityNeedsAction
    ? (forecast.status as StationFillAlertStatus)
    : forecast.storageAgeStatus === 'WATCH'
      ? 'WATCH'
      : 'CRITICAL';
  const ageMessage =
    forecast.storageAgeStatus === 'OVERDUE'
      ? `Trạm ${station.name} có mẻ dầu đã lưu ${forecast.storageAgeDays} ngày, vượt giới hạn ${forecast.maxStorageDays} ngày.`
      : `Trạm ${station.name} có mẻ dầu đã lưu ${forecast.storageAgeDays} ngày, cần xử lý trước giới hạn ${forecast.maxStorageDays} ngày.`;
  return {
    station_id: station.id,
    station_name: station.name,
    severity: forecastStatus === 'WATCH' ? 'MEDIUM' : 'HIGH',
    forecast_status: forecastStatus,
    estimated_days_until_full: forecast.estimatedDaysUntilFull,
    reason_codes: [...forecast.reasonCodes],
    message:
      trigger === 'CAPACITY'
        ? alertMessage(station.name, forecastStatus, forecast.estimatedDaysUntilFull)
        : ageMessage,
    trigger,
    storage_age_days: forecast.storageAgeDays,
    max_storage_days: forecast.maxStorageDays,
  };
}
