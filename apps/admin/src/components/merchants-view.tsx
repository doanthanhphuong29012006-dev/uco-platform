'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatDate, formatLiters } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

export function MerchantsView() {
  const [search, setSearch] = useState('');
  const [anomaly, setAnomaly] = useState(false);
  const result = useQuery({ queryKey: ['merchants', search, anomaly], queryFn: () => api.merchants({ search: search || undefined, anomaly: anomaly || undefined }) });
  if (result.isLoading) return <AdminShell><Skeleton className="h-10 w-48" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  if (result.error) return <AdminShell><ErrorState message={result.error instanceof ApiError ? result.error.message : 'Không thể tải danh sách quán.'} /></AdminShell>;
  return <AdminShell><p className="text-sm font-semibold text-emerald-700">Mạng lưới điểm thu gom</p><h2 className="mt-1 text-3xl font-bold">Quán</h2><div className="mt-6 flex flex-wrap gap-3"><input className="min-h-11 min-w-64 rounded-xl border border-slate-300 bg-white px-3" placeholder="Tìm tên quán…" value={search} onChange={(event) => setSearch(event.target.value)} /><label className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-sm"><input type="checkbox" checked={anomaly} onChange={(event) => setAnomaly(event.target.checked)} /> Chỉ hiện bất thường</label></div><section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">{!result.data?.data.length ? <EmptyState message="Không tìm thấy quán phù hợp." /> : <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Tên quán</th><th className="pb-3">Địa chỉ</th><th className="pb-3">Toạ độ</th><th className="pb-3">Cách trạm</th><th className="pb-3">Trung bình/ngày</th><th className="pb-3">Lần thu gần nhất</th><th className="pb-3">Ghi chú</th></tr></thead><tbody>{result.data.data.map((merchant) => <tr key={merchant.id} className="border-b last:border-0"><td className="py-4 font-semibold">{merchant.name}</td><td className="py-4 text-slate-600">{merchant.address ?? '—'}</td><td className="py-4 text-slate-500">{merchant.lat?.toFixed(4) ?? '—'}, {merchant.lng?.toFixed(4) ?? '—'}</td><td className="py-4">{merchant.distance_m === null ? '—' : `${(merchant.distance_m / 1000).toFixed(1)} km`}</td><td className="py-4">{merchant.avg_daily_liters === null ? '—' : formatLiters(merchant.avg_daily_liters)}</td><td className="py-4">{formatDate(merchant.last_collected_at)}</td><td className="py-4">{merchant.anomaly ? <Badge tone="red">Bất thường</Badge> : <Badge tone="green">Bình thường</Badge>}</td></tr>)}</tbody></table></div>}</section></AdminShell>;
}
