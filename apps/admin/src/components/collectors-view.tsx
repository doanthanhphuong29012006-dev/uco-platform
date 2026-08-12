'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatLiters } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

const WARD_ID = '10000000-0000-4000-8000-000000000001';
const empty = { name: '', phone: '', zalo_id: '', vehicle_type: 'Xe máy có thùng chứa', max_capacity_l: '100' };

export function CollectorsView() {
  const [selected, setSelected] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const queryClient = useQueryClient();
  const collectors = useQuery({ queryKey: ['collectors'], queryFn: api.collectors });
  const performance = useQuery({ queryKey: ['collector-performance', selected], queryFn: () => api.collectorPerformance(selected as string), enabled: Boolean(selected) });
  const save = useMutation({
    mutationFn: () => editingId
      ? api.updateCollector(editingId, { name: form.name, phone: form.phone, vehicle_type: form.vehicle_type, max_capacity_l: Number(form.max_capacity_l) })
      : api.createCollector({ ...form, max_capacity_l: Number(form.max_capacity_l), ward_ids: [WARD_ID] }),
    onSuccess: () => { setForm(empty); setEditingId(null); setShowForm(false); void queryClient.invalidateQueries({ queryKey: ['collectors'] }); },
  });
  if (collectors.isLoading) return <AdminShell><Skeleton className="h-10 w-56" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  if (collectors.error) return <AdminShell><ErrorState message={collectors.error instanceof ApiError ? collectors.error.message : 'Không thể tải danh sách người thu gom.'} /></AdminShell>;
  return <AdminShell>
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-semibold text-emerald-700">Đội vận hành ngoài đường</p><h2 className="mt-1 text-3xl font-bold">Người thu gom</h2></div><button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white" onClick={() => { setEditingId(null); setForm(empty); setShowForm(!showForm); }}>Tạo tài khoản</button></div>
    {showForm && <section className="mt-5 grid gap-3 rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm md:grid-cols-2"><h3 className="md:col-span-2 text-lg font-bold">{editingId ? 'Sửa tài khoản người thu gom' : 'Tạo tài khoản người thu gom'}</h3>{[['name','Họ tên'],['phone','Số điện thoại'],['zalo_id','Zalo ID'],['vehicle_type','Loại xe'],['max_capacity_l','Dung tích xe (lít)']].map(([key, label]) => <label key={key} className="grid gap-1 text-sm font-semibold">{label}<input disabled={editingId !== null && key === 'zalo_id'} className="min-h-11 rounded-xl border border-slate-300 px-3 font-normal disabled:bg-slate-100" value={form[key as keyof typeof form]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>)}<button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white md:col-span-2 disabled:opacity-50" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Đang lưu…' : editingId ? 'Lưu thay đổi' : 'Lưu tài khoản'}</button>{save.error && <p className="text-sm text-red-700 md:col-span-2">{save.error instanceof ApiError ? save.error.message : 'Không thể lưu tài khoản.'}</p>}</section>}
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">{!collectors.data?.data.length ? <EmptyState message="Chưa có người thu gom." /> : <div className="overflow-x-auto"><table className="w-full min-w-[780px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Họ tên</th><th className="pb-3">Phường</th><th className="pb-3">Liên hệ</th><th className="pb-3">Trạng thái</th><th className="pb-3">Hành động</th><th className="pb-3">Hiệu suất 7 ngày</th></tr></thead><tbody>{collectors.data.data.map((collector) => <tr key={collector.id} className="border-b last:border-0"><td className="py-4 font-semibold">{collector.display_name}</td><td className="py-4">{collector.ward.name}</td><td className="py-4">{collector.user.phone ?? '—'}</td><td className="py-4"><Badge tone={collector.is_active ? 'green' : 'slate'}>{collector.is_active ? 'Đang hoạt động' : 'Tạm dừng'}</Badge></td><td className="py-4"><button className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold" onClick={() => { setEditingId(collector.id); setForm({ name: collector.display_name, phone: collector.user.phone ?? '', zalo_id: '', vehicle_type: collector.vehicle_type ?? '', max_capacity_l: String(collector.max_capacity_l ?? 100) }); setShowForm(true); }}>Sửa</button></td><td className="py-4"><button className="min-h-10 rounded-lg border border-emerald-700 px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50" onClick={() => setSelected(selected === collector.id ? null : collector.id)}>{selected === collector.id ? 'Đóng' : 'Xem hiệu suất'}</button>{selected === collector.id && <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">{performance.isLoading ? 'Đang tải…' : performance.error ? 'Không tải được hiệu suất.' : performance.data ? <div className="grid gap-1"><span>{formatLiters(performance.data.liters_7d)} / 7 ngày</span><span>{performance.data.collections_7d} lần thu</span><span>Chênh lệch: {formatLiters(performance.data.variance_l)} ({(performance.data.variance_pct * 100).toFixed(2)}%)</span><Badge tone={performance.data.status === 'FLAGGED' ? 'red' : 'green'}>{performance.data.status}</Badge></div> : null}</div>}</td></tr>)}</tbody></table></div>}</section>
  </AdminShell>;
}
