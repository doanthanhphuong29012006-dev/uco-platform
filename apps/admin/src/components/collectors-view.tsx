'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatLiters } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

export function CollectorsView() {
  const [selected, setSelected] = useState<string | null>(null);
  const collectors = useQuery({ queryKey: ['collectors'], queryFn: api.collectors });
  const performance = useQuery({ queryKey: ['collector-performance', selected], queryFn: () => api.collectorPerformance(selected as string), enabled: Boolean(selected) });
  if (collectors.isLoading) return <AdminShell><Skeleton className="h-10 w-56" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  if (collectors.error) return <AdminShell><ErrorState message={collectors.error instanceof ApiError ? collectors.error.message : 'Không thể tải danh sách người thu gom.'} /></AdminShell>;
  return <AdminShell><p className="text-sm font-semibold text-emerald-700">Đội vận hành ngoài đường</p><h2 className="mt-1 text-3xl font-bold">Người thu gom</h2><section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">{!collectors.data?.data.length ? <EmptyState message="Chưa có người thu gom." /> : <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Họ tên</th><th className="pb-3">Phường</th><th className="pb-3">Liên hệ</th><th className="pb-3">Trạng thái</th><th className="pb-3">Hiệu suất 7 ngày</th></tr></thead><tbody>{collectors.data.data.map((collector) => <tr key={collector.id} className="border-b last:border-0"><td className="py-4 font-semibold">{collector.display_name}</td><td className="py-4">{collector.ward.name}</td><td className="py-4">{collector.user.phone ?? '—'}</td><td className="py-4"><Badge tone={collector.is_active ? 'green' : 'slate'}>{collector.is_active ? 'Đang hoạt động' : 'Tạm dừng'}</Badge></td><td className="py-4"><button className="min-h-10 rounded-lg border border-emerald-700 px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50" onClick={() => setSelected(selected === collector.id ? null : collector.id)}>{selected === collector.id ? 'Đóng' : 'Xem hiệu suất'}</button>{selected === collector.id && <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">{performance.isLoading ? 'Đang tải…' : performance.error ? 'Không tải được hiệu suất.' : performance.data ? <div className="grid gap-1"><span>{formatLiters(performance.data.liters_7d)} / 7 ngày</span><span>{performance.data.collections_7d} lần thu</span><span>Chênh lệch: {formatLiters(performance.data.variance_l)} ({(performance.data.variance_pct * 100).toFixed(2)}%)</span><Badge tone={performance.data.status === 'FLAGGED' ? 'red' : 'green'}>{performance.data.status}</Badge></div> : null}</div>}</td></tr>)}</tbody></table></div>}</section></AdminShell>;
}
