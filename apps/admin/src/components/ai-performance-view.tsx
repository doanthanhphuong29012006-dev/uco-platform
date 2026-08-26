'use client';

import { useQuery } from '@tanstack/react-query';
import type { AdminAiAnomalyPerformanceResponse, AdminImageGradingPerformanceResponse, AdminPickupForecastBacktestPoint, AdminPickupForecastPerformanceResponse } from '@eco-oil/shared-types';
import React, { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

const confidenceLabels = {
  HIGH: 'Cao',
  MEDIUM: 'Trung bình',
  LOW: 'Thấp',
  INSUFFICIENT_DATA: 'Chưa đủ dữ liệu',
} as const;

const reliabilityLabels = {
  INSUFFICIENT: 'Chưa đủ dữ liệu',
  LOW: 'Thấp',
  MEDIUM: 'Trung bình',
  HIGH: 'Cao',
} as const;

export function formatAiLiters(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} lít` : '—';
}

export function errorTone(point: AdminPickupForecastBacktestPoint): 'green' | 'yellow' | 'red' | 'slate' {
  if (point.error_percentage_pct === null || !Number.isFinite(point.error_percentage_pct)) return 'slate';
  if (point.error_percentage_pct <= 10) return 'green';
  if (point.error_percentage_pct <= 20) return 'yellow';
  return 'red';
}

function metric(value: number | null, suffix = ''): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}${suffix}`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('vi-VN') : '—';
}

function Chart({ points }: { points: AdminPickupForecastBacktestPoint[] }) {
  if (typeof ResizeObserver === 'undefined') return null;
  const chartData = [...points].reverse().map((point) => ({
    date: dateLabel(point.collected_at),
    'Dự báo': point.predicted_liters,
    'Thực tế': point.actual_liters,
  }));
  return <div className="h-72 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} /><Tooltip /><Line type="monotone" dataKey="Dự báo" stroke="#047857" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="Thực tế" stroke="#0f172a" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div>;
}

export function AiPerformanceContent({ data }: { data: AdminPickupForecastPerformanceResponse }) {
  if (data.sample_count === 0) return <EmptyState message="Chưa có đủ dữ liệu lịch sử để backtest trong khoảng thời gian này." />;
  return <>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><article className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-sm text-slate-600">Độ chính xác ước tính</p><p className="mt-2 text-2xl font-bold text-emerald-800">{metric(data.accuracy_pct, '%')}</p></article><article className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-sm text-slate-500">MAE</p><p className="mt-2 text-2xl font-bold">{formatAiLiters(data.mae_liters)}</p></article><article className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-sm text-slate-500">WAPE</p><p className="mt-2 text-2xl font-bold">{metric(data.wape_pct, '%')}</p></article><article className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-sm text-slate-500">Bias</p><p className="mt-2 text-2xl font-bold">{formatAiLiters(data.bias_liters)}</p></article></div>
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-600"><Badge tone={data.reliability === 'HIGH' ? 'green' : data.reliability === 'INSUFFICIENT' ? 'slate' : 'orange'}>Độ tin cậy: {reliabilityLabels[data.reliability]}</Badge><span>{data.sample_count} điểm backtest</span><span>Trong ±10%: {data.within_10_pct_count}</span><span>Trong ±20%: {data.within_20_pct_count}</span></div>
    <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">Dự báo và thực tế</h3><p className="mt-1 text-sm text-slate-500">{data.explanation.summary}</p><Chart points={data.points} /></section>
    <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">30 dự báo gần nhất</h3><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Thời điểm</th><th className="pb-3">Quán</th><th className="pb-3">Dự báo</th><th className="pb-3">Thực tế</th><th className="pb-3">Sai số</th><th className="pb-3">Độ tin cậy</th><th className="pb-3">Mẫu lịch sử</th></tr></thead><tbody>{data.points.map((point) => { const tone = errorTone(point); const toneClass = tone === 'green' ? 'bg-emerald-100 text-emerald-800' : tone === 'yellow' ? 'bg-amber-100 text-amber-800' : tone === 'red' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'; return <tr key={`${point.merchant_id}-${point.collected_at}`} className="border-b last:border-0"><td className="py-3">{dateLabel(point.collected_at)}</td><td className="py-3 font-semibold">{point.merchant_name}</td><td className="py-3">{formatAiLiters(point.predicted_liters)}</td><td className="py-3">{formatAiLiters(point.actual_liters)}</td><td className="py-3"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${toneClass}`}>{formatAiLiters(point.absolute_error_liters)}{point.error_percentage_pct === null ? '' : ` · ${point.error_percentage_pct.toLocaleString('vi-VN')}%`}</span></td><td className="py-3">{confidenceLabels[point.confidence]}</td><td className="py-3">{point.history_sample_size}</td></tr>; })}</tbody></table></div></section>
  </>;
}

const anomalyPerformanceLabels = {
  CONFIRMED: 'Xác nhận bất thường',
  FALSE_POSITIVE: 'Cảnh báo nhầm',
  UNSURE: 'Chưa chắc chắn',
} as const;

export function AiAnomalyPerformanceContent({ data }: { data: AdminAiAnomalyPerformanceResponse }) {
  if (data.total_alerts === 0) return <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">Phát hiện bất thường</h3><p className="mt-2 text-sm text-slate-600">Chưa có cảnh báo bất thường trong khoảng thời gian này.</p></section>;
  return <section className="mt-6 rounded-2xl border border-violet-200 bg-violet-50/40 p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold text-violet-700">Explainability và phản hồi Admin</p><h3 className="mt-1 text-lg font-bold">Phát hiện bất thường</h3></div>{data.total_alerts < 5 && <Badge tone="orange">Dữ liệu phản hồi còn ít</Badge>}</div><p className="mt-2 text-sm text-slate-600">{data.explanation}</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><article className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Tổng cảnh báo</p><p className="mt-1 text-2xl font-bold">{data.total_alerts}</p></article><article className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Đã đánh giá</p><p className="mt-1 text-2xl font-bold">{data.reviewed_count}</p></article><article className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Độ phủ phản hồi</p><p className="mt-1 text-2xl font-bold">{data.feedback_coverage_percent.toLocaleString('vi-VN')}%</p></article><article className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Cảnh báo nhầm</p><p className="mt-1 text-2xl font-bold">{data.false_positive_count}</p></article></div><div className="mt-4 flex flex-wrap gap-3 text-sm text-slate-700"><span>{data.confirmed_count} xác nhận</span><span>{data.unsure_count} chưa chắc chắn</span><span>Tỷ lệ xác nhận trên mẫu đã đánh giá: {data.confirmed_rate_percent === null ? '—' : `${data.confirmed_rate_percent.toLocaleString('vi-VN')}%`}</span><span>Tỷ lệ nhầm: {data.false_positive_rate_percent === null ? '—' : `${data.false_positive_rate_percent.toLocaleString('vi-VN')}%`}</span></div><div className="mt-4 grid gap-4 lg:grid-cols-2"><div className="rounded-xl bg-white p-4"><h4 className="font-semibold">Theo mức rủi ro</h4><ul className="mt-2 space-y-1 text-sm">{data.breakdown_by_risk_level.filter((item) => item.count > 0).map((item) => <li key={item.risk_level}>{item.risk_level}: {item.count}</li>)}</ul></div><div className="rounded-xl bg-white p-4"><h4 className="font-semibold">Theo nguyên nhân</h4><ul className="mt-2 space-y-1 text-sm">{data.breakdown_by_reason_code.slice(0, 8).map((item) => <li key={item.code}>{item.code}: {item.count}</li>)}</ul></div></div><div className="mt-4 rounded-xl bg-white p-4"><h4 className="font-semibold">Phản hồi gần nhất</h4>{data.recent_reviewed_items.length === 0 ? <p className="mt-2 text-sm text-slate-500">Chưa có phản hồi.</p> : <ul className="mt-2 space-y-2 text-sm">{data.recent_reviewed_items.map((item) => <li key={item.id} className="flex flex-wrap justify-between gap-2 border-b pb-2 last:border-0"><span>{item.merchant_name} · {item.feedback ? anomalyPerformanceLabels[item.feedback.verdict === 'CONFIRMED_ANOMALY' ? 'CONFIRMED' : item.feedback.verdict === 'FALSE_POSITIVE' ? 'FALSE_POSITIVE' : 'UNSURE'] : 'Chưa đánh giá'}</span><span className="text-slate-500">{formatDate(item.collected_at)}</span></li>)}</ul>}</div></section>;
}

function ImageGradingPerformanceContent({ data }: { data: AdminImageGradingPerformanceResponse }) {
  if (data.analyzed_count === 0) return <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">Phân hạng dầu qua ảnh</h3><p className="mt-2 text-sm text-slate-600">Chưa có dữ liệu phân tích ảnh trong khoảng thời gian này.</p></section>;
  return <section className="mt-6 rounded-2xl border border-sky-200 bg-sky-50/40 p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold text-sky-700">Phân tích hình ảnh thử nghiệm</p><h3 className="mt-1 text-lg font-bold">Phân hạng dầu qua ảnh</h3></div>{data.reliability === 'INSUFFICIENT' ? <Badge tone="orange">Dữ liệu đánh giá còn ít</Badge> : null}</div><p className="mt-2 text-sm text-slate-600">{data.explanation}</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><article className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Đã phân tích</p><p className="mt-1 text-2xl font-bold">{data.analyzed_count}</p></article><article className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Đồng thuận</p><p className="mt-1 text-2xl font-bold">{data.agreement_rate_percent === null ? '—' : `${data.agreement_rate_percent.toLocaleString('vi-VN')}%`}</p></article><article className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Giữ gợi ý AI</p><p className="mt-1 text-2xl font-bold">{data.accepted_count}</p></article><article className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Ghi đè gợi ý</p><p className="mt-1 text-2xl font-bold">{data.override_count}</p></article></div><div className="mt-4 flex flex-wrap gap-3 text-sm text-slate-700"><span>Độ tin cậy dữ liệu: {data.reliability}</span><span>Ảnh độ tin cậy thấp: {data.low_confidence_count}</span><span>Nên chụp lại: {data.retake_recommended_count}</span></div><div className="mt-4 rounded-xl bg-white p-4"><h4 className="font-semibold">Các lần người thu gom chọn khác gợi ý</h4>{data.recent_disagreements.length === 0 ? <p className="mt-2 text-sm text-slate-500">Chưa có trường hợp khác gợi ý.</p> : <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-2">Thời điểm</th><th className="pb-2">Quán</th><th className="pb-2">AI gợi ý</th><th className="pb-2">Đã chọn</th><th className="pb-2">Tin cậy</th></tr></thead><tbody>{data.recent_disagreements.map((item) => <tr key={item.transaction_id} className="border-b last:border-0"><td className="py-2">{dateLabel(item.collected_at)}</td><td className="py-2 font-semibold">{item.merchant_name}</td><td className="py-2">{item.suggested_grade ?? '—'}</td><td className="py-2">{item.selected_grade ?? '—'}</td><td className="py-2">{item.confidence ?? '—'}</td></tr>)}</tbody></table></div>}</div></section>;
}

export function AiPerformanceView() {
  const [windowDays, setWindowDays] = useState<30 | 90 | 180>(90);
  const performance = useQuery({ queryKey: ['ai-performance-pickup-forecast', windowDays], queryFn: () => api.pickupForecastPerformance(windowDays) });
  const anomalyPerformance = useQuery({ queryKey: ['ai-anomaly-performance', windowDays], queryFn: () => api.aiAnomalyPerformance(windowDays) });
  const imageGradingPerformance = useQuery({ queryKey: ['ai-performance-image-grading', windowDays], queryFn: () => api.imageGradingPerformance(windowDays) });
  return <AdminShell><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-semibold text-emerald-700">Đo lường dự báo thống kê</p><h2 className="mt-1 text-3xl font-bold">Hiệu quả AI</h2></div><label className="text-sm font-semibold text-slate-600">Khoảng đánh giá<select className="mt-1 block min-h-11 rounded-xl border border-slate-300 bg-white px-3" value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value) as 30 | 90 | 180)}><option value={30}>30 ngày</option><option value={90}>90 ngày</option><option value={180}>180 ngày</option></select></label></div>{performance.isLoading ? <><Skeleton className="mt-6 h-28" /><Skeleton className="mt-5 h-80" /></> : performance.error ? <div className="mt-6"><ErrorState message={performance.error instanceof ApiError ? performance.error.message : 'Không thể tải hiệu quả dự báo.'} /><button type="button" className="mt-3 min-h-11 rounded-xl bg-ink px-4 font-semibold text-white" onClick={() => void performance.refetch()}>Thử lại</button></div> : performance.data ? <div className="mt-6"><AiPerformanceContent data={performance.data} /></div> : <div className="mt-6"><EmptyState message="Chưa có dữ liệu hiệu quả AI." /></div>}{anomalyPerformance.isLoading ? <Skeleton className="mt-6 h-80" /> : anomalyPerformance.error ? <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">Không thể tải hiệu quả phát hiện bất thường. <button type="button" className="font-semibold underline" onClick={() => void anomalyPerformance.refetch()}>Thử lại</button></div> : anomalyPerformance.data ? <AiAnomalyPerformanceContent data={anomalyPerformance.data} /> : null}{imageGradingPerformance.isLoading ? <Skeleton className="mt-6 h-72" /> : imageGradingPerformance.error ? <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">Không thể tải hiệu quả phân hạng ảnh. <button type="button" className="font-semibold underline" onClick={() => void imageGradingPerformance.refetch()}>Thử lại</button></div> : imageGradingPerformance.data ? <ImageGradingPerformanceContent data={imageGradingPerformance.data} /> : null}</AdminShell>;
}
