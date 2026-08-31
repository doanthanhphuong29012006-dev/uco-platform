import {
  forecastStationFill,
  StationFillForecastInputError,
  type StationFillForecastInput,
} from './station-fill-forecast';

describe('forecastStationFill', () => {
  it('returns insufficient data without escalating when history has fewer than three days', () => {
    const result = forecastStationFill({
      capacityLiters: 100,
      currentVolumeLiters: 40,
      dailyIncomingLiters: [30, 30],
    });

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.historySize).toBe(2);
    expect(result.reasonCodes).toContain('HISTORY_BELOW_MINIMUM');
    expect(result.status).not.toBe('CRITICAL');
  });

  it('reports a station that is already full', () => {
    const result = forecastStationFill({
      capacityLiters: 100,
      currentVolumeLiters: 105,
      dailyIncomingLiters: [10, 12, 11],
    });

    expect(result.status).toBe('FULL');
    expect(result.remainingCapacityLiters).toBe(0);
    expect(result.estimatedDaysUntilFull).toBe(0);
    expect(result.projectedVolumes.every((projection) => projection.volumeLiters === 100)).toBe(
      true,
    );
  });

  it('returns null days until full when there is no incoming oil', () => {
    const result = forecastStationFill({
      capacityLiters: 100,
      currentVolumeLiters: 25,
      dailyIncomingLiters: [0, 0, 0, 0],
    });

    expect(result.averageDailyIncomingLiters).toBe(0);
    expect(result.estimatedDaysUntilFull).toBeNull();
    expect(result.status).toBe('STABLE');
    expect(result.reasonCodes).toContain('NO_INCOMING_FLOW');
  });

  it('marks a station expected to fill within three days as critical', () => {
    const result = forecastStationFill({
      capacityLiters: 100,
      currentVolumeLiters: 40,
      dailyIncomingLiters: [20, 20, 20],
    });

    expect(result.estimatedDaysUntilFull).toBe(3);
    expect(result.status).toBe('CRITICAL');
    expect(result.reasonCodes).toContain('FULL_WITHIN_3_DAYS');
  });

  it('marks a station expected to fill within seven days for watching', () => {
    const result = forecastStationFill({
      capacityLiters: 100,
      currentVolumeLiters: 30,
      dailyIncomingLiters: [10, 10, 10, 10],
    });

    expect(result.estimatedDaysUntilFull).toBe(7);
    expect(result.status).toBe('WATCH');
    expect(result.reasonCodes).toContain('FULL_WITHIN_7_DAYS');
  });

  it('keeps a station with more than seven days of capacity stable', () => {
    const result = forecastStationFill({
      capacityLiters: 100,
      currentVolumeLiters: 10,
      dailyIncomingLiters: [10, 10, 10, 10, 10],
    });

    expect(result.estimatedDaysUntilFull).toBe(9);
    expect(result.status).toBe('STABLE');
    expect(result.reasonCodes).toContain('CAPACITY_AVAILABLE_BEYOND_7_DAYS');
  });

  it.each<{
    input: StationFillForecastInput;
    code: StationFillForecastInputError['code'];
  }>([
    {
      input: { capacityLiters: 0, currentVolumeLiters: 0, dailyIncomingLiters: [] },
      code: 'INVALID_CAPACITY',
    },
    {
      input: {
        capacityLiters: 100,
        currentVolumeLiters: Number.POSITIVE_INFINITY,
        dailyIncomingLiters: [],
      },
      code: 'INVALID_CURRENT_VOLUME',
    },
    {
      input: {
        capacityLiters: 100,
        currentVolumeLiters: 0,
        dailyIncomingLiters: [10, Number.NaN, 12],
      },
      code: 'INVALID_DAILY_INCOMING',
    },
  ])('rejects invalid input with code $code', ({ input, code }) => {
    try {
      forecastStationFill(input);
      throw new Error('Expected forecastStationFill to reject invalid input');
    } catch (error) {
      expect(error).toBeInstanceOf(StationFillForecastInputError);
      expect((error as StationFillForecastInputError).code).toBe(code);
    }
  });

  it('uses only the latest seven days and never projects beyond capacity', () => {
    const result = forecastStationFill({
      capacityLiters: 100,
      currentVolumeLiters: 50,
      dailyIncomingLiters: [1_000, 1_000, 10, 10, 10, 10, 10, 10, 10],
    });

    expect(result.historySize).toBe(7);
    expect(result.averageDailyIncomingLiters).toBe(10);
    expect(result.reasonCodes).toContain('HISTORY_TRUNCATED_TO_7_DAYS');
    expect(result.projectedVolumes).toHaveLength(7);
    expect(result.projectedVolumes.map((projection) => projection.volumeLiters)).toEqual([
      60, 70, 80, 90, 100, 100, 100,
    ]);
    expect(result.projectedVolumes.every((projection) => projection.volumeLiters <= 100)).toBe(
      true,
    );
  });

  it('keeps capacity forecast separate from the seven-day oil-age warning', () => {
    const result = forecastStationFill({
      capacityLiters: 1_000,
      currentVolumeLiters: 100,
      dailyIncomingLiters: [10, 10, 10],
      oldestStoredAt: new Date('2026-08-24T00:00:00.000Z'),
      now: new Date('2026-08-31T00:00:00.000Z'),
      maxStorageDays: 14,
    });
    expect(result.estimatedDaysUntilFull).toBe(90);
    expect(result.storageAgeDays).toBe(7);
    expect(result.storageAgeStatus).toBe('WATCH');
    expect(result.effectiveHandlingDays).toBe(7);
  });

  it('marks the oldest unprocessed batch overdue at the configured limit', () => {
    const result = forecastStationFill({
      capacityLiters: 1_000,
      currentVolumeLiters: 100,
      dailyIncomingLiters: [],
      oldestStoredAt: new Date('2026-08-17T00:00:00.000Z'),
      now: new Date('2026-08-31T00:00:00.000Z'),
      maxStorageDays: 14,
    });
    expect(result.storageAgeStatus).toBe('OVERDUE');
    expect(result.daysUntilStorageLimit).toBe(0);
    expect(result.effectiveHandlingDays).toBe(0);
  });

  it('states that age data is insufficient when only capacity history is available', () => {
    const result = forecastStationFill({
      capacityLiters: 100,
      currentVolumeLiters: 50,
      dailyIncomingLiters: [7, 7, 7],
    });
    expect(result.storageAgeStatus).toBe('INSUFFICIENT_DATA');
    expect(result.storageAgeDays).toBeNull();
    expect(result.explanation.summary).toContain('chỉ dựa trên sức chứa');
    expect(result.estimatedDaysUntilFull).toBe(7.1);
  });
});
