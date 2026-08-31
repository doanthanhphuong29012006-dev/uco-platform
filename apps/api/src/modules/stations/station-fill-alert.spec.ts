import { buildStationFillAlertCandidate } from './station-fill-alert';
import { forecastStationFill, type StationFillForecastResult } from './station-fill-forecast';

const station = { id: 'station-01', name: 'Trạm trung tâm' };

const forecast = (
  currentVolumeLiters: number,
  dailyIncomingLiters: number[],
): StationFillForecastResult =>
  forecastStationFill({
    capacityLiters: 100,
    currentVolumeLiters,
    dailyIncomingLiters,
  });

describe('buildStationFillAlertCandidate', () => {
  it('creates a HIGH alert candidate for FULL', () => {
    const result = buildStationFillAlertCandidate(station, forecast(100, [10, 10, 10]));

    expect(result).toMatchObject({
      severity: 'HIGH',
      forecast_status: 'FULL',
      estimated_days_until_full: 0,
    });
    expect(result?.message).toBe('Trạm Trạm trung tâm đã đầy, cần xử lý ngay.');
  });

  it('creates a HIGH alert candidate for CRITICAL', () => {
    const result = buildStationFillAlertCandidate(station, forecast(40, [20, 20, 20]));

    expect(result).toMatchObject({
      severity: 'HIGH',
      forecast_status: 'CRITICAL',
      estimated_days_until_full: 3,
    });
  });

  it('creates a MEDIUM alert candidate for WATCH', () => {
    const result = buildStationFillAlertCandidate(station, forecast(30, [10, 10, 10, 10]));

    expect(result).toMatchObject({
      severity: 'MEDIUM',
      forecast_status: 'WATCH',
      estimated_days_until_full: 7,
    });
  });

  it('returns null for STABLE', () => {
    expect(buildStationFillAlertCandidate(station, forecast(10, [10, 10, 10, 10]))).toBeNull();
  });

  it('returns null for INSUFFICIENT_DATA', () => {
    expect(buildStationFillAlertCandidate(station, forecast(40, [30, 30]))).toBeNull();
  });

  it('creates a separate storage-age alert even when capacity is stable', () => {
    const source = forecastStationFill({
      capacityLiters: 1_000,
      currentVolumeLiters: 100,
      dailyIncomingLiters: [10, 10, 10],
      oldestStoredAt: new Date('2026-08-17T00:00:00.000Z'),
      now: new Date('2026-08-31T00:00:00.000Z'),
      maxStorageDays: 14,
    });
    const result = buildStationFillAlertCandidate(station, source);
    expect(result).toMatchObject({
      trigger: 'STORAGE_AGE',
      severity: 'HIGH',
      storage_age_days: 14,
      max_storage_days: 14,
    });
    expect(result?.message).toContain('vượt giới hạn 14 ngày');
  });

  it('returns null when fill forecast is missing', () => {
    expect(buildStationFillAlertCandidate(station)).toBeNull();
    expect(buildStationFillAlertCandidate(station, null)).toBeNull();
  });

  it('preserves station identity and forecast data in the candidate', () => {
    const source = forecast(30, [10, 10, 10, 10]);
    const result = buildStationFillAlertCandidate(station, source);

    expect(result).toMatchObject({
      station_id: 'station-01',
      station_name: 'Trạm trung tâm',
      forecast_status: source.status,
      estimated_days_until_full: source.estimatedDaysUntilFull,
      reason_codes: source.reasonCodes,
    });
  });

  it('does not mutate station or forecast inputs', () => {
    const source = forecast(30, [10, 10, 10, 10]);
    const stationBefore = { ...station };
    const forecastBefore = JSON.parse(JSON.stringify(source)) as StationFillForecastResult;

    const result = buildStationFillAlertCandidate(station, source);

    expect(station).toEqual(stationBefore);
    expect(source).toEqual(forecastBefore);
    expect(result?.reason_codes).not.toBe(source.reasonCodes);
  });
});
