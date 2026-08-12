'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

const empty = { code: '', name: '', district: '', city: 'Hà Nội', center_lat: '', center_lng: '' };

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Không thể lưu phường. Vui lòng thử lại.';
  if (error.code === 'WARD_CODE_ALREADY_EXISTS') return 'Mã phường đã tồn tại. Vui lòng chọn mã khác.';
  if (error.code === 'WARD_HAS_ACTIVE_MERCHANTS') return 'Không thể tắt phường vì vẫn còn quán đang hoạt động.';
  return error.message || 'Không thể lưu phường. Vui lòng thử lại.';
}

export function WardsView() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const wards = useQuery({ queryKey: ['admin-wards-all'], queryFn: () => api.wards(true) });
  const save = useMutation({
    mutationFn: () => {
      const body = { code: form.code.toUpperCase(), name: form.name, district: form.district, city: form.city, ...(form.center_lat ? { center_lat: Number(form.center_lat) } : {}), ...(form.center_lng ? { center_lng: Number(form.center_lng) } : {}) };
      return editingId ? api.updateWard(editingId, body) : api.createWard(body);
    },
    onSuccess: () => { setForm(empty); setEditingId(null); setShowForm(false); void queryClient.invalidateQueries({ queryKey: ['admin-wards-all'] }); },
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.updateWard(id, { status: active ? 'ACTIVE' : 'INACTIVE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-wards-all'] }),
  });

  function locate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((position) => setForm((current) => ({ ...current, center_lat: position.coords.latitude.toFixed(6), center_lng: position.coords.longitude.toFixed(6) })));
  }

  if (wards.isLoading) return <AdminShell><Skeleton className="h-10 w-56" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  if (wards.error) return <AdminShell><ErrorState message="Không thể tải danh sách phường. Vui lòng thử lại." /></AdminShell>;
  return <AdminShell>
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-semibold text-emerald-700">Địa bàn vận hành</p><h2 className="mt-1 text-3xl font-bold">Phường / Địa bàn</h2></div><button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white" onClick={() => { setEditingId(null); setForm(empty); setShowForm(!showForm); }}>Thêm phường</button></div>
    {showForm && <section className="mt-5 grid gap-3 rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm md:grid-cols-2"><h3 className="md:col-span-2 text-lg font-bold">{editingId ? 'Sửa thông tin phường' : 'Thêm phường mới'}</h3>{[['code','Mã phường'],['name','Tên phường'],['district','Quận / huyện'],['city','Tỉnh / thành phố']].map(([key, label]) => <label key={key} className="grid gap-1 text-sm font-semibold">{label}<input className="min-h-11 rounded-xl border border-slate-300 px-3 font-normal" value={form[key as keyof typeof form]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} placeholder={key === 'code' ? 'HB-HK' : undefined} /></label>)}<label className="grid gap-1 text-sm font-semibold">Vĩ độ<input className="min-h-11 rounded-xl border border-slate-300 px-3 font-normal" inputMode="decimal" value={form.center_lat} onChange={(event) => setForm({ ...form, center_lat: event.target.value })} /></label><label className="grid gap-1 text-sm font-semibold">Kinh độ<input className="min-h-11 rounded-xl border border-slate-300 px-3 font-normal" inputMode="decimal" value={form.center_lng} onChange={(event) => setForm({ ...form, center_lng: event.target.value })} /></label><button type="button" className="min-h-11 rounded-xl border border-emerald-700 px-4 font-bold text-emerald-700 md:col-span-2" onClick={locate}>Lấy tọa độ từ thiết bị</button><p className="text-xs text-slate-500 md:col-span-2">Ranh giới polygon sẽ bổ sung ở sprint-4 khi triển khai bản đồ nhiệt.</p><button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white md:col-span-2 disabled:opacity-50" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Đang lưu…' : 'Lưu phường'}</button>{save.error && <p className="text-sm text-red-700 md:col-span-2">{errorMessage(save.error)}</p>}</section>}
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">{!wards.data?.length ? <EmptyState message="Chưa có phường nào." /> : <div className="overflow-x-auto"><table className="w-full min-w-[950px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Mã</th><th className="pb-3">Phường</th><th className="pb-3">Quận / thành phố</th><th className="pb-3">Quán</th><th className="pb-3">Can</th><th className="pb-3">Thu gom</th><th className="pb-3">Trạng thái</th><th className="pb-3">Thao tác</th></tr></thead><tbody>{wards.data.map((ward) => <tr key={ward.id} className="border-b last:border-0"><td className="py-4 font-mono font-semibold">{ward.code}</td><td className="py-4 font-semibold">{ward.name}</td><td className="py-4">{ward.district}, {ward.city}</td><td className="py-4">{ward.merchant_count}</td><td className="py-4">{ward.container_count}</td><td className="py-4">{ward.collector_count}</td><td className="py-4"><Badge tone={ward.is_active ? 'green' : 'slate'}>{ward.is_active ? 'Đang hoạt động' : 'Tạm dừng'}</Badge></td><td className="py-4"><div className="flex gap-2"><button className="min-h-10 rounded-lg border px-3 font-semibold" onClick={() => { setEditingId(ward.id); setForm({ code: ward.code, name: ward.name, district: ward.district, city: ward.city, center_lat: ward.center_lat?.toString() ?? '', center_lng: ward.center_lng?.toString() ?? '' }); setShowForm(true); }}>Sửa</button><button className="min-h-10 rounded-lg border px-3 font-semibold" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: ward.id, active: !ward.is_active })}>{ward.is_active ? 'Tắt' : 'Bật'}</button></div></td></tr>)}</tbody></table></div>}</section>
    {toggle.error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{errorMessage(toggle.error)}</p>}
  </AdminShell>;
}
