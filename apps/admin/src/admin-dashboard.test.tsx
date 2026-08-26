import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AlertSeverity, AnomalyFeedbackVerdict, OilGrade, Quality, Role, type AuthUser } from '@eco-oil/shared-types';
import { createElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { KpiCards } from './components/kpi-cards';
import { AiAnomalyListItem, AlertListItem, formatAnomalyEvidence } from './components/alerts-view';
import { TransactionAnomalySummary } from './components/reconciliation-view';
import { countStationsByFillForecast, sortStationsByFillForecast, StationForecastStatus, StationsTable } from './components/stations-view';
import { calculateVariancePct, isAdminUser } from './lib/dashboard-utils';
import type { StationFillForecast, StationSummaryWithForecast } from './lib/api';
import { AiAnomalyPerformanceContent, AiPerformanceContent, errorTone, formatAiLiters } from './components/ai-performance-view';
import type { AdminAiAnomalyItem, AdminAiAnomalyPerformanceResponse, AdminPickupForecastPerformanceResponse } from '@eco-oil/shared-types';

afterEach(cleanup);

const user = (role: Role): AuthUser => ({
  id: 'user-1', zalo_id: 'zalo-test', phone: '0900000000', name: 'Test', role, merchantId: null, collectorId: null, merchantApprovalStatus: null, merchantRejectionReason: null,
});

test('guard từ chối tài khoản không phải ADMIN', () => {
  expect(isAdminUser(user(Role.MERCHANT))).toBe(false);
  expect(isAdminUser(user(Role.COLLECTOR))).toBe(false);
  expect(isAdminUser(user(Role.ADMIN))).toBe(true);
});

const aiPerformanceFixture: AdminPickupForecastPerformanceResponse = {
  window_days: 90,
  window_start: '2026-01-01T00:00:00.000Z',
  window_end: '2026-03-31T00:00:00.000Z',
  sample_count: 2,
  mae_liters: 1.2,
  wape_pct: 8.5,
  bias_liters: -0.4,
  accuracy_pct: 91.5,
  within_10_pct_count: 1,
  within_20_pct_count: 2,
  reliability: 'INSUFFICIENT',
  points: [
    { merchant_id: 'merchant-1', merchant_name: 'Quán A', collected_at: '2026-03-01T00:00:00.000Z', predicted_liters: 15, actual_liters: 15, absolute_error_liters: 0, error_percentage_pct: 0, confidence: 'HIGH', history_sample_size: 5, direction: 'MATCH' },
    { merchant_id: 'merchant-1', merchant_name: 'Quán A', collected_at: '2026-03-02T00:00:00.000Z', predicted_liters: 14, actual_liters: 20, absolute_error_liters: 6, error_percentage_pct: 30, confidence: 'LOW', history_sample_size: 1, direction: 'LOWER_THAN_ACTUAL' },
  ],
  explanation: { method: 'ROLLING_ORIGIN', summary: 'Đánh giá được backtest chỉ bằng dữ liệu có trước mỗi lần thu gom.', data_leakage_prevention: 'Chỉ dùng dữ liệu trước thời điểm thu.' },
};

test('hiển thị bảng hiệu quả AI và tô màu sai số theo ngưỡng', () => {
  render(createElement(AiPerformanceContent, { data: aiPerformanceFixture }));
  expect(screen.getByText('Độ chính xác ước tính')).toBeInTheDocument();
  expect(screen.getByText('91,5%')).toBeInTheDocument();
  expect(screen.getAllByText('15 lít')).toHaveLength(2);
  expect(screen.getByText('Đánh giá được backtest chỉ bằng dữ liệu có trước mỗi lần thu gom.')).toBeInTheDocument();
  expect(errorTone(aiPerformanceFixture.points[0]!)).toBe('green');
  expect(errorTone(aiPerformanceFixture.points[1]!)).toBe('red');
  expect(formatAiLiters(null)).toBe('—');
});

test('hiển thị empty state khi không có điểm backtest', () => {
  render(createElement(AiPerformanceContent, { data: { ...aiPerformanceFixture, sample_count: 0, points: [] } }));
  expect(screen.getByText('Chưa có đủ dữ liệu lịch sử để backtest trong khoảng thời gian này.')).toBeInTheDocument();
});

const aiAnomalyFixture: AdminAiAnomalyItem = {
  id: 'anomaly:transaction-1',
  transaction_id: 'transaction-1',
  merchant_id: 'merchant-1',
  merchant_name: 'Quán bất thường',
  collector_name: 'Người thu gom',
  actual_liters: 60,
  actual_kg: 55,
  quality: Quality.PASS,
  grade: OilGrade.A,
  collected_at: '2026-03-02T00:00:00.000Z',
  risk_score: 42,
  risk_level: 'REVIEW',
  explanation_summary: 'Phát hiện tín hiệu cần xem xét.',
  reason_codes: [{ code: 'DENSITY_OUTLIER', label: 'Tỷ lệ kg/lít bất thường', description: 'Lệch lịch sử.', contribution: 35, evidence: { actual_density: 2.5, expected_density: 0.91, relative_deviation_percent: 174.73, mass_source: 'SCALE', source: 'DOMAIN_DENSITY_BASELINE' }, severity: AlertSeverity.HIGH }],
  history_size: 6,
  feedback: null,
};

test('hiển thị giải thích anomaly và gửi feedback từ giao diện', () => {
  const onSave = vi.fn();
  render(createElement(AiAnomalyListItem, { item: aiAnomalyFixture, onSave, saving: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Xem giải thích' }));
  expect(screen.getByText('Tỷ lệ kg/lít bất thường')).toBeInTheDocument();
  expect(screen.getByText('Mật độ thực tế:')).toBeInTheDocument();
  expect(screen.getByText('2,5 kg/lít')).toBeInTheDocument();
  expect(screen.getByText('Mức sai lệch:')).toBeInTheDocument();
  expect(screen.getByText('174,73%')).toBeInTheDocument();
  expect(screen.queryByText(/Bằng chứng:/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'CONFIRMED_ANOMALY' } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Đã đối chiếu' } });
  expect(screen.getByRole('textbox')).toHaveAttribute('spellcheck', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Lưu đánh giá' }));
  expect(onSave).toHaveBeenCalledWith('transaction-1', AnomalyFeedbackVerdict.CONFIRMED_ANOMALY, 'Đã đối chiếu');
});

test('format evidence dùng nhãn tiếng Việt và bỏ qua giá trị không hợp lệ', () => {
  expect(formatAnomalyEvidence({ actual_density: 2.5, expected_density: 0.91, relative_deviation_percent: 174.73, value: Number.NaN })).toEqual([
    { label: 'Mật độ thực tế', value: '2,5 kg/lít' },
    { label: 'Mật độ chuẩn', value: '0,91 kg/lít' },
    { label: 'Mức sai lệch', value: '174,73%' },
  ]);
});

test('hiển thị lỗi lưu và chỉ khóa item đang lưu', () => {
  render(createElement(AiAnomalyListItem, { item: aiAnomalyFixture, onSave: vi.fn(), saving: true, saveError: 'Không thể lưu (FEEDBACK_FAILED)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Xem giải thích' }));
  expect(screen.getByRole('alert')).toHaveTextContent('FEEDBACK_FAILED');
  expect(screen.getByRole('button', { name: 'Đang lưu…' })).toBeDisabled();
});

test('hiển thị hiệu quả phản hồi anomaly và trạng thái mẫu ít', () => {
  const data: AdminAiAnomalyPerformanceResponse = {
    window_days: 90,
    total_alerts: 1,
    reviewed_count: 1,
    unreviewed_count: 0,
    feedback_coverage_percent: 100,
    confirmed_count: 1,
    false_positive_count: 0,
    unsure_count: 0,
    confirmed_rate_percent: 100,
    false_positive_rate_percent: 0,
    breakdown_by_risk_level: [{ risk_level: 'REVIEW', count: 1 }],
    breakdown_by_reason_code: [{ code: 'MASS_OR_VOLUME_OUTLIER', count: 1 }],
    recent_reviewed_items: [{ ...aiAnomalyFixture, feedback: { id: 'feedback-1', verdict: AnomalyFeedbackVerdict.CONFIRMED_ANOMALY, note: null, reviewer_user_id: 'admin-1', risk_score_snapshot: 42, risk_level_snapshot: 'REVIEW', reasons_snapshot: aiAnomalyFixture.reason_codes, created_at: '2026-03-02T00:00:00.000Z', updated_at: '2026-03-02T00:00:00.000Z' } }],
    explanation: 'Các tỷ lệ chỉ được tính trên cảnh báo đã đánh giá.',
  };
  render(createElement(AiAnomalyPerformanceContent, { data }));
  expect(screen.getByText('Phát hiện bất thường')).toBeInTheDocument();
  expect(screen.getByText('Dữ liệu phản hồi còn ít')).toBeInTheDocument();
  expect(screen.getByText('100%')).toBeInTheDocument();
});

test('render đúng các số liệu KPI', () => {
  render(createElement(KpiCards, { values: { liters: 18.5, transactions: 3, merchants: 2, alerts: 1 } }));
  expect(screen.getByText('18,5 lít')).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument();
  expect(screen.getByText('2')).toBeInTheDocument();
  expect(screen.getByText('1')).toBeInTheDocument();
});

test('tính chênh lệch đối soát theo số lít thu gom', () => {
  expect(calculateVariancePct(100, 98)).toBeCloseTo(0.02);
  expect(calculateVariancePct(0, 0)).toBe(0);
  expect(calculateVariancePct(25, 30)).toBeCloseTo(-0.2);
});

const anomaly = (level: 'NORMAL' | 'REVIEW' | 'HIGH_RISK', reasons: string[] = []) => ({
  score: level === 'NORMAL' ? 8 : level === 'REVIEW' ? 42 : 81,
  level,
  reasons,
  explanation: {},
  historySize: 12,
});

test('hiển thị đúng nhãn và màu cho các mức bất thường', () => {
  const { rerender } = render(createElement(TransactionAnomalySummary, { anomaly: anomaly('NORMAL') }));
  expect(screen.getByText('Bình thường')).toHaveClass('bg-emerald-100');
  expect(screen.getByText('Điểm bất thường: 8/100')).toBeInTheDocument();
  expect(screen.getByText('Mẫu lịch sử: 12')).toBeInTheDocument();

  rerender(createElement(TransactionAnomalySummary, { anomaly: anomaly('REVIEW') }));
  expect(screen.getByText('Cần kiểm tra')).toHaveClass('bg-orange-100');

  rerender(createElement(TransactionAnomalySummary, { anomaly: anomaly('HIGH_RISK') }));
  expect(screen.getByText('Rủi ro cao')).toHaveClass('bg-red-100');
});

test('chuyển reason code bất thường thành mô tả tiếng Việt', () => {
  render(
    createElement(TransactionAnomalySummary, {
      anomaly: anomaly('REVIEW', [
        'DENSITY_OUTLIER',
        'MASS_OR_VOLUME_OUTLIER',
        'COLLECTION_TIME_OUTLIER',
        'FREQUENCY_SPIKE',
      ]),
    }),
  );

  expect(screen.getByText('Tỷ lệ kg/lít bất thường')).toBeInTheDocument();
  expect(screen.getByText('Khối lượng hoặc thể tích lệch mạnh so với lịch sử')).toBeInTheDocument();
  expect(screen.getByText('Thời gian thu gom khác thường')).toBeInTheDocument();
  expect(screen.getByText('Tần suất giao dịch tăng đột biến')).toBeInTheDocument();
});

test('không render trạng thái bất thường khi API cũ chưa trả anomaly', () => {
  const { container } = render(createElement(TransactionAnomalySummary, {}));
  expect(container).toBeEmptyDOMElement();
});

const stationAlert = (severity: 'HIGH' | 'MEDIUM', details: unknown = {
  station_id: 'station-01',
  station_name: 'Trạm Hồ Gươm',
  forecast_status: 'CRITICAL',
  estimated_days_until_full: 2,
}) => ({
  id: `station-fill-${severity}`,
  type: 'STATION_FILL_FORECAST' as never,
  severity: severity === 'HIGH' ? AlertSeverity.HIGH : AlertSeverity.MEDIUM,
  message: 'Dự báo trạm cần theo dõi.',
  details,
  created_at: '2026-08-25T10:00:00.000Z',
  resolved_at: null,
});

test('hiển thị cảnh báo dự báo trạm HIGH và MEDIUM bằng nhãn tiếng Việt', () => {
  const { rerender } = render(createElement(AlertListItem, {
    alert: stationAlert('HIGH'),
    resolvePending: false,
    onResolve: () => undefined,
  }));
  expect(screen.getByText('Cần xử lý')).toBeInTheDocument();
  expect(screen.getByText('Dự báo đầy trạm')).toBeInTheDocument();

  rerender(createElement(AlertListItem, {
    alert: stationAlert('MEDIUM', { station_id: 'station-02', forecast_status: 'WATCH', estimated_days_until_full: 0 }),
    resolvePending: false,
    onResolve: () => undefined,
  }));
  expect(screen.getByText('Theo dõi')).toBeInTheDocument();
  expect(screen.getByText('Dự kiến đầy sau: 0 ngày')).toBeInTheDocument();
});

test('cảnh báo cũ vẫn hiển thị và thiếu field forecast không làm crash', () => {
  const oldAlert = {
    id: 'old-alert',
    type: 'GEO_MISMATCH' as never,
    severity: AlertSeverity.HIGH,
    message: 'Vị trí cần kiểm tra.',
    details: null,
    created_at: '2026-08-25T10:00:00.000Z',
    resolved_at: null,
  };
  const { container, rerender } = render(createElement(AlertListItem, {
    alert: oldAlert,
    resolvePending: false,
    onResolve: () => undefined,
  }));
  expect(screen.getByText('Sai vị trí')).toBeInTheDocument();
  expect(screen.getByText('Vị trí cần kiểm tra.')).toBeInTheDocument();

  rerender(createElement(AlertListItem, {
    alert: stationAlert('HIGH', null),
    resolvePending: false,
    onResolve: () => undefined,
  }));
  expect(screen.getByText('Trạm: Trạm chưa xác định')).toBeInTheDocument();
  expect(within(container).queryByText(/Dự kiến đầy sau/)).not.toBeInTheDocument();
});

const stationForecast = (
  status: StationFillForecast['status'],
  days: number | null,
  historySize = 7,
): StationFillForecast => ({
  average_daily_incoming_liters: 20,
  remaining_capacity_liters: 80,
  estimated_days_until_full: days,
  projected_volumes: [],
  status,
  history_size: historySize,
  reason_codes: [],
  explanation: {
    summary: 'Dự báo dựa trên lịch sử nhập dầu gần nhất.',
    used_daily_incoming_liters: [],
    calculation_window_days: historySize,
    formula: 'remaining / average',
  },
});

test('hiển thị dự báo trạm cần theo dõi', () => {
  render(createElement(StationForecastStatus, { forecast: stationForecast('WATCH', 5), fillPct: 40 }));
  expect(screen.getByText('Có thể đầy trong 5 ngày')).toHaveClass('bg-amber-100');
  expect(screen.getByText('Dự báo dựa trên lịch sử nhập dầu gần nhất.')).toBeInTheDocument();
});

test('hiển thị dự báo trạm ổn định và số ngày còn lại', () => {
  render(createElement(StationForecastStatus, { forecast: stationForecast('STABLE', 12), fillPct: 40 }));
  expect(screen.getByText('Ổn định')).toHaveClass('bg-emerald-100');
  expect(screen.getByText('Còn khoảng 12 ngày')).toBeInTheDocument();
});

test('hiển thị số ngày lịch sử khi chưa đủ dữ liệu dự báo trạm', () => {
  render(createElement(StationForecastStatus, { forecast: stationForecast('INSUFFICIENT_DATA', null, 2), fillPct: 40 }));
  expect(screen.getByText('Chưa đủ dữ liệu')).toHaveClass('bg-slate-100');
  expect(screen.getByText('2/3 ngày lịch sử')).toBeInTheDocument();
});

test('fallback về trạng thái mức đầy khi response cũ chưa có fill_forecast', () => {
  render(createElement(StationForecastStatus, { fillPct: 96 }));
  expect(screen.getByText('Gần đầy')).toBeInTheDocument();
});

const station = (
  id: string,
  status?: StationFillForecast['status'],
  days: number | null = null,
): StationSummaryWithForecast => ({
  id,
  name: id,
  address: null,
  current_volume_l: 10,
  capacity_l: 100,
  fill_pct: 10,
  ...(status ? { fill_forecast: stationForecast(status, days) } : {}),
});

test('sắp xếp FULL trước CRITICAL, WATCH, STABLE và INSUFFICIENT_DATA', () => {
  const input = [
    station('insufficient', 'INSUFFICIENT_DATA'),
    station('stable', 'STABLE', 12),
    station('watch', 'WATCH', 6),
    station('critical', 'CRITICAL', 2),
    station('full', 'FULL', 0),
  ];

  expect(sortStationsByFillForecast(input).map(({ id }) => id)).toEqual([
    'full',
    'critical',
    'watch',
    'stable',
    'insufficient',
  ]);
  expect(input.map(({ id }) => id)).toEqual(['insufficient', 'stable', 'watch', 'critical', 'full']);
});

test('sắp xếp CRITICAL có số ngày nhỏ hơn lên trước', () => {
  const result = sortStationsByFillForecast([
    station('critical-3', 'CRITICAL', 3),
    station('critical-1', 'CRITICAL', 1),
    station('critical-2', 'CRITICAL', 2),
  ]);
  expect(result.map(({ id }) => id)).toEqual(['critical-1', 'critical-2', 'critical-3']);
});

test('đặt số ngày null sau số ngày cụ thể trong cùng nhóm forecast', () => {
  const result = sortStationsByFillForecast([
    station('watch-null', 'WATCH'),
    station('watch-5', 'WATCH', 5),
  ]);
  expect(result.map(({ id }) => id)).toEqual(['watch-5', 'watch-null']);
});

test('đặt response cũ thiếu fill_forecast ở cuối danh sách', () => {
  const result = sortStationsByFillForecast([
    station('legacy'),
    station('insufficient', 'INSUFFICIENT_DATA'),
  ]);
  expect(result.map(({ id }) => id)).toEqual(['insufficient', 'legacy']);
});

test('giữ nguyên thứ tự API khi trạm có cùng mức ưu tiên và số ngày', () => {
  const result = sortStationsByFillForecast([
    station('first', 'CRITICAL', 2),
    station('second', 'CRITICAL', 2),
    station('third', 'CRITICAL', 2),
  ]);
  expect(result.map(({ id }) => id)).toEqual(['first', 'second', 'third']);
});

const renderedStationNames = (container: HTMLElement) => within(container).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]?.textContent);

test('bộ lọc mặc định hiển thị tất cả trạm theo thứ tự ưu tiên', () => {
  const { container } = render(createElement(StationsTable, {
    stations: [station('stable', 'STABLE', 10), station('full', 'FULL', 0), station('watch', 'WATCH', 5)],
  }));
  expect(within(container).getByLabelText('Lọc mức độ ưu tiên')).toHaveValue('ALL');
  expect(renderedStationNames(container)).toEqual(['full', 'watch', 'stable']);
});

test('bộ lọc Cần xử lý chỉ hiện FULL và CRITICAL, vẫn đúng thứ tự ưu tiên', () => {
  const { container } = render(createElement(StationsTable, {
    stations: [station('watch', 'WATCH', 4), station('critical', 'CRITICAL', 2), station('full', 'FULL', 0)],
  }));
  fireEvent.change(within(container).getByLabelText('Lọc mức độ ưu tiên'), { target: { value: 'ACTION_REQUIRED' } });
  expect(renderedStationNames(container)).toEqual(['full', 'critical']);
  expect(within(container).queryByText('watch')).not.toBeInTheDocument();
});

test('bộ lọc Chưa đủ dữ liệu nhận forecast thiếu lịch sử và response cũ', () => {
  const { container } = render(createElement(StationsTable, {
    stations: [station('legacy'), station('stable', 'STABLE', 10), station('insufficient', 'INSUFFICIENT_DATA')],
  }));
  fireEvent.change(within(container).getByLabelText('Lọc mức độ ưu tiên'), { target: { value: 'INSUFFICIENT_DATA' } });
  expect(renderedStationNames(container)).toEqual(['insufficient', 'legacy']);
});

test('hiển thị empty state khi không có trạm phù hợp với bộ lọc', () => {
  const { container } = render(createElement(StationsTable, { stations: [station('watch', 'WATCH', 4)] }));
  fireEvent.change(within(container).getByLabelText('Lọc mức độ ưu tiên'), { target: { value: 'STABLE' } });
  expect(within(container).getByText('Không có trạm phù hợp với bộ lọc.')).toBeInTheDocument();
});

const summaryStations = [
  station('full', 'FULL', 0),
  station('critical', 'CRITICAL', 2),
  station('watch', 'WATCH', 5),
  station('stable', 'STABLE', 12),
  station('insufficient', 'INSUFFICIENT_DATA'),
  station('legacy'),
];

test('đếm FULL và CRITICAL vào nhóm Cần xử lý', () => {
  expect(countStationsByFillForecast(summaryStations).actionRequired).toBe(2);
});

test('đếm WATCH vào nhóm Theo dõi', () => {
  expect(countStationsByFillForecast(summaryStations).watch).toBe(1);
});

test('đếm STABLE vào nhóm Ổn định', () => {
  expect(countStationsByFillForecast(summaryStations).stable).toBe(1);
});

test('đếm INSUFFICIENT_DATA và response cũ vào nhóm Chưa đủ dữ liệu', () => {
  expect(countStationsByFillForecast(summaryStations).insufficientData).toBe(2);
});

test('thay đổi bộ lọc không làm thay đổi số lượng tổng theo mức ưu tiên', () => {
  const { container } = render(createElement(StationsTable, { stations: summaryStations }));
  const view = within(container);
  const countTexts = () => [
    view.getByTestId('station-count-action-required').textContent,
    view.getByTestId('station-count-watch').textContent,
    view.getByTestId('station-count-stable').textContent,
    view.getByTestId('station-count-insufficient').textContent,
  ];
  const before = countTexts();
  fireEvent.change(view.getByLabelText('Lọc mức độ ưu tiên'), { target: { value: 'WATCH' } });
  expect(countTexts()).toEqual(before);
  expect(countTexts()).toEqual(['Cần xử lý2', 'Theo dõi1', 'Ổn định1', 'Chưa đủ dữ liệu2']);
});

test('bấm từng ô thống kê cập nhật dropdown, trạng thái active và danh sách', () => {
  const { container } = render(createElement(StationsTable, { stations: summaryStations }));
  const view = within(container);
  const select = view.getByLabelText('Lọc mức độ ưu tiên');
  const cases = [
    { testId: 'station-count-action-required', value: 'ACTION_REQUIRED', stations: ['full', 'critical'] },
    { testId: 'station-count-watch', value: 'WATCH', stations: ['watch'] },
    { testId: 'station-count-stable', value: 'STABLE', stations: ['stable'] },
    { testId: 'station-count-insufficient', value: 'INSUFFICIENT_DATA', stations: ['insufficient', 'legacy'] },
  ];

  for (const item of cases) {
    const card = view.getByTestId(item.testId);
    fireEvent.click(card);
    expect(select).toHaveValue(item.value);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(renderedStationNames(container)).toEqual(item.stations);
  }

  const activeCard = view.getByTestId('station-count-insufficient');
  fireEvent.click(activeCard);
  expect(select).toHaveValue('INSUFFICIENT_DATA');
  expect(activeCard).toHaveAttribute('aria-pressed', 'true');
});

test('đổi dropdown cập nhật ô thống kê active', () => {
  const { container } = render(createElement(StationsTable, { stations: summaryStations }));
  const view = within(container);
  fireEvent.change(view.getByLabelText('Lọc mức độ ưu tiên'), { target: { value: 'WATCH' } });
  expect(view.getByTestId('station-count-watch')).toHaveAttribute('aria-pressed', 'true');
  expect(view.getByTestId('station-count-action-required')).toHaveAttribute('aria-pressed', 'false');
});

test('bấm ô thống kê không làm thay đổi các số tổng', () => {
  const { container } = render(createElement(StationsTable, { stations: summaryStations }));
  const view = within(container);
  const countTexts = () => [
    view.getByTestId('station-count-action-required').textContent,
    view.getByTestId('station-count-watch').textContent,
    view.getByTestId('station-count-stable').textContent,
    view.getByTestId('station-count-insufficient').textContent,
  ];
  const before = countTexts();
  fireEvent.click(view.getByTestId('station-count-action-required'));
  expect(countTexts()).toEqual(before);
});

test('mở và đóng chi tiết dự báo của một trạm', () => {
  const { container } = render(createElement(StationsTable, { stations: [station('watch', 'WATCH', 5)] }));
  const view = within(container);
  const button = view.getByRole('button', { name: 'Xem dự báo' });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(view.getByTestId('station-forecast-details-watch')).toBeInTheDocument();
  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(view.queryByTestId('station-forecast-details-watch')).not.toBeInTheDocument();
});

test('mở trạm thứ hai thì chi tiết trạm thứ nhất đóng', () => {
  const { container } = render(createElement(StationsTable, {
    stations: [station('full', 'FULL', 0), station('watch', 'WATCH', 5)],
  }));
  const view = within(container);
  const buttons = view.getAllByRole('button', { name: 'Xem dự báo' });
  fireEvent.click(buttons[0]!);
  expect(view.getByTestId('station-forecast-details-full')).toBeInTheDocument();
  fireEvent.click(buttons[1]!);
  expect(view.queryByTestId('station-forecast-details-full')).not.toBeInTheDocument();
  expect(view.getByTestId('station-forecast-details-watch')).toBeInTheDocument();
  expect(buttons[0]).toHaveAttribute('aria-expanded', 'false');
  expect(buttons[1]).toHaveAttribute('aria-expanded', 'true');
});

test('hiển thị đầy đủ dữ liệu chi tiết forecast', () => {
  const forecast = {
    ...stationForecast('WATCH', 4, 7),
    remaining_capacity_liters: 80,
    average_daily_incoming_liters: 20,
    projected_volumes: [{ day: 1, volume_liters: 40 }, { day: 2, volume_liters: 60 }],
    explanation: { ...stationForecast('WATCH', 4).explanation, summary: 'Trạm có thể đầy trong bốn ngày.' },
  };
  const item = { ...station('detailed', 'WATCH', 4), fill_forecast: forecast };
  const { container } = render(createElement(StationsTable, { stations: [item] }));
  const view = within(container);
  fireEvent.click(view.getByRole('button', { name: 'Xem dự báo' }));
  const details = within(view.getByTestId('station-forecast-details-detailed'));
  expect(details.getByText('Theo dõi')).toBeInTheDocument();
  expect(details.getByText('4 ngày')).toBeInTheDocument();
  expect(details.getByText('80,0 lít')).toBeInTheDocument();
  expect(details.getByText('20,0 lít')).toBeInTheDocument();
  expect(details.getByText('7 ngày')).toBeInTheDocument();
  expect(details.getByText('Trạm có thể đầy trong bốn ngày.')).toBeInTheDocument();
  expect(details.getByText('Ngày 1: 40,0 lít')).toBeInTheDocument();
  expect(details.getByText('Ngày 2: 60,0 lít')).toBeInTheDocument();
});

test('fallback an toàn khi response cũ thiếu fill_forecast', () => {
  const { container } = render(createElement(StationsTable, { stations: [station('legacy')] }));
  const view = within(container);
  fireEvent.click(view.getByRole('button', { name: 'Xem dự báo' }));
  expect(view.getByText('Chưa đủ dữ liệu để lập dự báo chi tiết.')).toBeInTheDocument();
});
