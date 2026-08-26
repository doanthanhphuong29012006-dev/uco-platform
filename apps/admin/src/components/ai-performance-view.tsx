'use client';

import { useQuery } from '@tanstack/react-query';
import type { AdminPickupForecastBacktestPoint, AdminPickupForecastPerformanceResponse } from '@eco-oil/shared-types';
import React, { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from '../lib/api';
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

export function AiPerformanceView() {
  const [windowDays, setWindowDays] = useState<30 | 90 | 180>(90);
  const performance = useQuery({ queryKey: ['ai-performance-pickup-forecast', windowDays], queryFn: () => api.pickupForecastPerformance(windowDays) });
  return <AdminShell><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-semibold text-emerald-700">Đo lường dự báo thống kê</p><h2 className="mt-1 text-3xl font-bold">Hiệu quả AI</h2></div><label className="text-sm font-semibold text-slate-600">Khoảng đánh giá<select className="mt-1 block min-h-11 rounded-xl border border-slate-300 bg-white px-3" value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value) as 30 | 90 | 180)}><option value={30}>30 ngày</option><option value={90}>90 ngày</option><option value={180}>180 ngày</option></select></label></div>{performance.isLoading ? <><Skeleton className="mt-6 h-28" /><Skeleton className="mt-5 h-80" /></> : performance.error ? <div className="mt-6"><ErrorState message={performance.error instanceof ApiError ? performance.error.message : 'Không thể tải hiệu quả dự báo.'} /><button type="button" className="mt-3 min-h-11 rounded-xl bg-ink px-4 font-semibold text-white" onClick={() => void performance.refetch()}>Thử lại</button></div> : performance.data ? <div className="mt-6"><AiPerformanceContent data={performance.data} /></div> : <div className="mt-6"><EmptyState message="Chưa có dữ liệu hiệu quả AI." /></div>}</AdminShell>;
}
