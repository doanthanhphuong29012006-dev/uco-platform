import { render, screen } from '@testing-library/react';
import { Role, type AuthUser } from '@eco-oil/shared-types';
import { createElement } from 'react';
import { expect, test } from 'vitest';
import { KpiCards } from './components/kpi-cards';
import { TransactionAnomalySummary } from './components/reconciliation-view';
import { StationForecastStatus } from './components/stations-view';
import { calculateVariancePct, isAdminUser } from './lib/dashboard-utils';
import type { StationFillForecast } from './lib/api';

const user = (role: Role): AuthUser => ({
  id: 'user-1', zalo_id: 'zalo-test', phone: '0900000000', name: 'Test', role, merchantId: null, collectorId: null, merchantApprovalStatus: null, merchantRejectionReason: null,
});

test('guard từ chối tài khoản không phải ADMIN', () => {
  expect(isAdminUser(user(Role.MERCHANT))).toBe(false);
  expect(isAdminUser(user(Role.COLLECTOR))).toBe(false);
  expect(isAdminUser(user(Role.ADMIN))).toBe(true);
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
