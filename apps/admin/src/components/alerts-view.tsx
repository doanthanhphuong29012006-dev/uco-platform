'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminAlert } from '@eco-oil/shared-types';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

export function AlertsView() {
  const [type, setType] = useState('');
  const [resolved, setResolved] = useState('false');
  const queryClient = useQueryClient();
  const alerts = useQuery({ queryKey: ['alerts', type, resolved], queryFn: () => api.alerts({ type: type || undefined, resolved: resolved === '' ? undefined : resolved === 'true', page: 1, limit: 100 }) });
  const resolve = useMutation({ mutationFn: (id: string) => api.resolveAlert(id), onMutate: async (id) => { await queryClient.cancelQueries({ queryKey: ['alerts'] }); const keys = queryClient.getQueryCache().findAll({ queryKey: ['alerts'] }); keys.forEach((query) => { queryClient.setQueryData<{ data: AdminAlert[]; meta: unknown }>(query.queryKey, (old) => old ? { ...old, data: old.data.map((alert) => alert.id === id ? { ...alert, resolved_at: new Date().toISOString() } : alert) } : old); }); } });
  if (alerts.isLoading) return <AdminShell><Skeleton className="h-10 w-56" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  if (alerts.error) return <AdminShell><ErrorState message={alerts.error instanceof ApiError ? alerts.error.message : 'Không thể tải cảnh báo.'} /></AdminShell>;
  return <AdminShell><div><p className="text-sm font-semibold text-emerald-700">Theo dõi bất thường</p><h2 className="mt-1 text-3xl font-bold">Cảnh báo</h2></div><div className="mt-6 flex flex-wrap gap-3"><select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" value={type} onChange={(event) => setType(event.target.value)}><option value="">Tất cả loại</option><option value="GEO_MISMATCH">Sai vị trí</option><option value="DELIVERY_VARIANCE">Lệch nộp trạm</option></select><select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" value={resolved} onChange={(event) => setResolved(event.target.value)}><option value="false">Chưa xử lý</option><option value="true">Đã xử lý</option><option value="">Tất cả trạng thái</option></select></div><section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">{!alerts.data?.data.length ? <EmptyState message="Không có cảnh báo phù hợp." /> : <div className="space-y-3">{alerts.data.data.map((alert) => <article key={alert.id} className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4 md:flex-row md:items-center md:justify-between"><div><div className="flex flex-wrap items-center gap-2"><Badge tone={alert.type === 'DELIVERY_VARIANCE' ? 'orange' : 'red'}>{alert.type === 'DELIVERY_VARIANCE' ? 'Lệch nộp trạm' : 'Sai vị trí'}</Badge>{alert.severity && <Badge tone={alert.severity === 'HIGH' ? 'red' : 'orange'}>{alert.severity}</Badge>}{alert.resolved_at && <Badge tone="green">Đã xử lý</Badge>}</div><p className="mt-2 font-semibold">{alert.message ?? 'Cảnh báo cần kiểm tra'}</p><p className="mt-1 text-sm text-slate-500">{formatDate(alert.created_at)}</p></div>{!alert.resolved_at && <button className="min-h-11 rounded-xl bg-ink px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={resolve.isPending} onClick={() => resolve.mutate(alert.id)}>Đánh dấu đã xử lý</button>}</article>)}</div>}</section></AdminShell>;
}
