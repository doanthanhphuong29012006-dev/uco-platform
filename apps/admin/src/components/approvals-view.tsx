'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

type Coordinates = { lat: string; lng: string };

export function ApprovalsView() {
  const queryClient = useQueryClient();
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [provisionId, setProvisionId] = useState<string | null>(null);
  const [selectedContainerId, setSelectedContainerId] = useState('');
  const [createNew, setCreateNew] = useState(false);
  const [coordinates, setCoordinates] = useState<Record<string, Coordinates>>({});
  const [coordinateError, setCoordinateError] = useState<string | null>(null);

  const pending = useQuery({ queryKey: ['pending-merchants'], queryFn: () => api.merchants({ status: 'PENDING' }) });
  const unassigned = useQuery({ queryKey: ['unassigned-containers'], queryFn: () => api.containers({ unassigned: true }) });

  const approve = useMutation({
    mutationFn: async ({ merchantId, lat, lng }: { merchantId: string; lat: number; lng: number }) => {
      await api.approveMerchant(merchantId, { lat, lng });
      if (selectedContainerId) await api.assignContainer(selectedContainerId, merchantId);
      if (createNew) {
        const merchant = pending.data?.data.find((item) => item.id === merchantId);
        const created = await api.createContainer({ ward_code: merchant?.ward_code ?? undefined, capacity_liters: 30 });
        await api.assignContainer(created.id, merchantId);
      }
    },
    onSuccess: () => {
      setProvisionId(null);
      setSelectedContainerId('');
      setCreateNew(false);
      setCoordinateError(null);
      void queryClient.invalidateQueries({ queryKey: ['pending-merchants'] });
      void queryClient.invalidateQueries({ queryKey: ['unassigned-containers'] });
      void queryClient.invalidateQueries({ queryKey: ['pending-merchants-count'] });
    },
  });

  const reject = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => api.rejectMerchant(id, text),
    onSuccess: () => {
      setReasonId(null);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['pending-merchants'] });
      void queryClient.invalidateQueries({ queryKey: ['pending-merchants-count'] });
    },
  });

  if (pending.isLoading) return <AdminShell><Skeleton className="h-10 w-56" /><Skeleton className="mt-6 h-40" /></AdminShell>;
  if (pending.error) return <AdminShell><ErrorState message={pending.error instanceof ApiError ? pending.error.message : 'Không thể tải hồ sơ chờ duyệt.'} /></AdminShell>;

  return <AdminShell>
    <p className="text-sm font-semibold text-emerald-700">Kiểm duyệt hồ sơ</p>
    <h2 className="mt-1 text-3xl font-bold">Duyệt quán</h2>
    <section className="mt-6 grid gap-4">
      {!pending.data?.data.length ? <EmptyState message="Không có hồ sơ nào đang chờ duyệt." /> : pending.data.data.map((merchant) => {
        const current = coordinates[merchant.id] ?? { lat: String(merchant.lat ?? ''), lng: String(merchant.lng ?? '') };
        return <article key={merchant.id} className="rounded-2xl border border-amber-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold">{merchant.name}</h3>
              <p className="mt-1 text-sm text-slate-600">{merchant.address ?? 'Chưa có địa chỉ'}</p>
              <p className="mt-2 text-sm text-slate-500">{merchant.business_type ?? 'Chưa chọn loại hình'} · {merchant.phone ?? 'Chưa có số điện thoại'}</p>
              <p className="mt-1 text-xs text-slate-400">Phường: {merchant.ward_name ?? merchant.ward_code ?? '—'}</p>
            </div>
            <Badge tone="orange">PENDING</Badge>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="min-h-11 rounded-xl bg-emerald-700 px-4 text-sm font-bold text-white" onClick={() => {
              setProvisionId(merchant.id);
              setSelectedContainerId('');
              setCreateNew(false);
              setCoordinateError(null);
              setCoordinates((old) => ({ ...old, [merchant.id]: current }));
            }}>Duyệt hồ sơ</button>
            <button className="min-h-11 rounded-xl border border-red-300 px-4 text-sm font-bold text-red-700" onClick={() => setReasonId(reasonId === merchant.id ? null : merchant.id)}>Từ chối</button>
          </div>
          {provisionId === merchant.id && <div className="mt-4 grid gap-3 rounded-xl bg-emerald-50 p-4">
            <strong>Tọa độ thực tế trước khi duyệt</strong>
            <p className="text-sm text-slate-600">Kiểm tra vị trí trên bản đồ hoặc nhập tọa độ GPS của quán. Không dùng tọa độ mặc định.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm font-semibold">Vĩ độ (8–24)<input className="min-h-11 rounded-xl border bg-white px-3" type="number" step="any" value={current.lat} onChange={(event) => setCoordinates((old) => ({ ...old, [merchant.id]: { ...current, lat: event.target.value } }))} /></label>
              <label className="grid gap-1 text-sm font-semibold">Kinh độ (102–110)<input className="min-h-11 rounded-xl border bg-white px-3" type="number" step="any" value={current.lng} onChange={(event) => setCoordinates((old) => ({ ...old, [merchant.id]: { ...current, lng: event.target.value } }))} /></label>
            </div>
            <select className="min-h-11 rounded-xl border bg-white px-3" value={selectedContainerId} onChange={(event) => { setSelectedContainerId(event.target.value); setCreateNew(false); }}><option value="">Duyệt trước, cấp can sau</option>{unassigned.data?.data.map((container) => <option key={container.id} value={container.id}>{container.qr_code} · {container.capacity_liters ?? '—'} lít</option>)}</select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={createNew} onChange={(event) => { setCreateNew(event.target.checked); setSelectedContainerId(''); }} /> Tạo can mới 30 lít và cấp ngay</label>
            <div className="flex gap-2"><button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white disabled:opacity-50" disabled={approve.isPending} onClick={() => {
              const lat = Number(current.lat);
              const lng = Number(current.lng);
              if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 8 || lat > 24 || lng < 102 || lng > 110 || (Math.abs(lat - 10.7769) < 0.000001 && Math.abs(lng - 106.7009) < 0.000001)) {
                setCoordinateError('Vui lòng nhập tọa độ thực trong lãnh thổ Việt Nam; không dùng tọa độ mặc định.');
                return;
              }
              approve.mutate({ merchantId: merchant.id, lat, lng });
            }}>{approve.isPending ? 'Đang xử lý…' : 'Xác nhận duyệt'}</button><button className="min-h-11 rounded-xl border px-4 font-semibold" onClick={() => setProvisionId(null)}>Hủy</button></div>
            {coordinateError && <p className="text-sm text-red-700">{coordinateError}</p>}
            {approve.error && <p className="text-sm text-red-700">{approve.error instanceof ApiError ? approve.error.message : 'Không thể duyệt hồ sơ.'}</p>}
          </div>}
          {reasonId === merchant.id && <div className="mt-3 grid gap-2 rounded-xl bg-red-50 p-3"><label className="text-sm font-semibold text-red-900">Lý do từ chối bắt buộc</label><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ví dụ: Cần bổ sung địa chỉ rõ hơn" /><button className="min-h-10 rounded-lg bg-red-700 px-4 text-sm font-bold text-white disabled:opacity-50" disabled={!reason.trim() || reject.isPending} onClick={() => reject.mutate({ id: merchant.id, text: reason })}>Xác nhận từ chối</button></div>}
        </article>;
      })}
    </section>
  </AdminShell>;
}
