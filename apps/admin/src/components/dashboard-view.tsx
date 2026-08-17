'use client';

import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from '../lib/api';
import { formatDate, formatLiters, todayIso } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { EmptyState, ErrorState, Skeleton, Badge } from './ui';
import { KpiCards } from './kpi-cards';

function dateDaysAgo(days: number) { const date = new Date(); date.setUTCDate(date.getUTCDate() - days); return date.toISOString().slice(0, 10); }

export function DashboardView() {
  const today = todayIso();
  const overview = useQuery({ queryKey: ['overview', '30d'], queryFn: () => api.overview() });
  const todayOverview = useQuery({ queryKey: ['overview', today], queryFn: () => api.overview(today, today) });
  const merchants = useQuery({ queryKey: ['admin-merchants', 'dashboard'], queryFn: () => api.merchants({}) });
  const loading = overview.isLoading || todayOverview.isLoading || merchants.isLoading;
  if (loading) return <AdminShell><Skeleton className="h-10 w-56" /><div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-32" />)}</div><Skeleton className="mt-6 h-80" /></AdminShell>;
  if (overview.error || todayOverview.error || merchants.error) return <AdminShell><ErrorState message={overview.error instanceof ApiError ? overview.error.message : 'Không thể tải tổng quan vận hành.'} /></AdminShell>;
  if (!overview.data || !todayOverview.data || !merchants.data) return <AdminShell><EmptyState /></AdminShell>;
  const chartData = overview.data.daily_liters.slice(-14);
  return <AdminShell>
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-semibold text-emerald-700">Tổng quan hôm nay</p><h2 className="mt-1 text-3xl font-bold">Vận hành Eco-Oil</h2></div><p className="text-sm text-slate-500">Cập nhật tự động mỗi 30 giây</p></div>
    <div className="mt-6"><KpiCards values={{ liters: todayOverview.data.totals.liters, transactions: todayOverview.data.totals.transactions, merchants: todayOverview.data.totals.active_merchants, alerts: todayOverview.data.alerts_open }} /></div>
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><div><h3 className="text-lg font-bold">Lít thu gom 14 ngày gần nhất</h3><p className="text-sm text-slate-500">Ngày không có giao dịch vẫn hiển thị 0.</p></div><span className="text-sm text-slate-500">{formatLiters(chartData.reduce((sum, item) => sum + item.liters, 0))}</span></div><div className="mt-5 h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} /><YAxis /><Tooltip formatter={(value: number) => formatLiters(value)} /><Bar dataKey="liters" fill="#2d6a4f" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div></section>
    <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_1fr]">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">10 giao dịch gần nhất</h3>{overview.data.recent_transactions.length === 0 ? <div className="mt-4"><EmptyState message="Chưa có giao dịch thu gom." /></div> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[860px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Quán</th><th className="pb-3">Người thu</th><th className="pb-3">Số lít</th><th className="pb-3">Số kg</th><th className="pb-3">Nguồn khối lượng</th><th className="pb-3">Hạng</th><th className="pb-3">Chất lượng</th><th className="pb-3">Thời gian</th></tr></thead><tbody>{overview.data.recent_transactions.map((transaction) => <tr key={transaction.id} className={`border-b last:border-0 ${transaction.suspected_adulteration ? 'bg-red-50' : ''}`}><td className="py-3 font-semibold">{transaction.merchant_name}</td><td className="py-3">{transaction.collector_name ?? '—'}</td><td className="py-3">{formatLiters(transaction.actual_liters)}</td><td className="py-3">{transaction.actual_kg === null ? '—' : `${transaction.actual_kg.toFixed(2)} kg`}</td><td className="py-3">{transaction.mass_source === 'SCALE' ? 'Đã cân' : 'Ước lượng'}</td><td className="py-3 font-bold">{transaction.grade ?? '—'}{transaction.suspected_adulteration ? ' · Nghi ngờ pha lẫn' : ''}</td><td className="py-3"><Badge tone={transaction.quality === 'FLAG' ? 'red' : 'green'}>{transaction.quality}</Badge></td><td className="py-3 text-slate-500">{formatDate(transaction.collected_at)}</td></tr>)}</tbody></table></div>}</section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">Quán trong khu vực</h3>{merchants.data.data.length === 0 ? <div className="mt-4"><EmptyState message="Chưa có quán." /></div> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[500px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Quán</th><th className="pb-3">Toạ độ</th><th className="pb-3">Cách trạm</th></tr></thead><tbody>{merchants.data.data.slice(0, 8).map((merchant) => <tr key={merchant.id} className="border-b last:border-0"><td className="py-3 font-semibold">{merchant.name}</td><td className="py-3 text-slate-500">{merchant.lat?.toFixed(4) ?? '—'}, {merchant.lng?.toFixed(4) ?? '—'}</td><td className="py-3">{merchant.distance_m === null ? '—' : `${(merchant.distance_m / 1000).toFixed(1)} km`}</td></tr>)}</tbody></table></div>}</section>
    </div>
    <p className="mt-5 text-xs text-slate-500">Dữ liệu biểu đồ: {dateDaysAgo(13)} đến {today}. Không sử dụng bản đồ ở MVP.</p>
  </AdminShell>;
}
