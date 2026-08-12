'use client';

import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatLiters } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { EmptyState, ErrorState, Skeleton } from './ui';

export function StationsView() {
  const result = useQuery({ queryKey: ['stations'], queryFn: api.stations });
  if (result.isLoading) return <AdminShell><Skeleton className="h-10 w-48" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  if (result.error) return <AdminShell><ErrorState message={result.error instanceof ApiError ? result.error.message : 'Không thể tải danh sách trạm.'} /></AdminShell>;
  return <AdminShell><p className="text-sm font-semibold text-emerald-700">Điểm tiếp nhận</p><h2 className="mt-1 text-3xl font-bold">Trạm</h2><section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">{!result.data?.data.length ? <EmptyState message="Chưa có trạm hoạt động." /> : <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Tên trạm</th><th className="pb-3">Địa chỉ</th><th className="pb-3">Dung tích</th><th className="pb-3">Mức đầy</th><th className="pb-3">Trạng thái</th></tr></thead><tbody>{result.data.data.map((station) => { const tone = station.fill_pct > 95 ? 'bg-red-600' : station.fill_pct > 80 ? 'bg-orange-500' : 'bg-emerald-600'; return <tr key={station.id} className="border-b last:border-0"><td className="py-4 font-semibold">{station.name}</td><td className="py-4 text-slate-600">{station.address ?? '—'}</td><td className="py-4">{formatLiters(station.current_volume_l)} / {formatLiters(station.capacity_l)}</td><td className="py-4"><div className="flex items-center gap-3"><div className="h-2 w-32 rounded-full bg-slate-200"><div className={`h-2 rounded-full ${tone}`} style={{ width: `${Math.min(station.fill_pct, 100)}%` }} /></div><span className="font-semibold">{station.fill_pct.toFixed(1)}%</span></div></td><td className="py-4">{station.fill_pct > 95 ? 'Gần đầy' : station.fill_pct > 80 ? 'Cần theo dõi' : 'Bình thường'}</td></tr>; })}</tbody></table></div>}</section></AdminShell>;
}
