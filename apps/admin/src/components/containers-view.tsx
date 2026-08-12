'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

export function ContainersView() {
  const queryClient = useQueryClient();
  const [state, setState] = useState('');
  const [unassigned, setUnassigned] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [capacity, setCapacity] = useState('30');
  const [wardCode, setWardCode] = useState('Q3-P7');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<Record<string, string>>({});
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const containers = useQuery({ queryKey: ['admin-containers', state, unassigned], queryFn: () => api.containers({ state: state || undefined, unassigned: unassigned || undefined }) });
  const merchants = useQuery({ queryKey: ['all-merchants-for-containers'], queryFn: () => api.merchants({}) });
  const create = useMutation({ mutationFn: () => api.createContainer({ ward_code: wardCode, capacity_liters: Number(capacity) }), onSuccess: () => { setShowCreate(false); void queryClient.invalidateQueries({ queryKey: ['admin-containers'] }); } });
  const assign = useMutation({ mutationFn: ({ id, merchantId }: { id: string; merchantId: string }) => api.assignContainer(id, merchantId), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['admin-containers'] }); } });
  const unassignMutation = useMutation({ mutationFn: api.unassignContainer, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['admin-containers'] }); } });
  const selected = containers.data?.data.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!selected) { setQrDataUrl(null); return; }
    void QRCode.toDataURL(selected.qr_code, { width: 240, margin: 2 }).then((url) => { if (!cancelled) setQrDataUrl(url); });
    return () => { cancelled = true; };
  }, [selected]);

  if (containers.isLoading) return <AdminShell><Skeleton className="h-10 w-56" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  if (containers.error) return <AdminShell><ErrorState message={containers.error instanceof ApiError ? containers.error.message : 'Không thể tải danh sách can.'} /></AdminShell>;
  return <AdminShell>
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-semibold text-emerald-700">Kho vật tư</p><h2 className="mt-1 text-3xl font-bold">Quản lý can</h2></div><button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white" onClick={() => setShowCreate(!showCreate)}>Tạo can mới</button></div>
    {showCreate && <section className="mt-5 grid gap-3 rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm md:grid-cols-3"><label className="grid gap-1 text-sm font-semibold">Mã phường<input className="min-h-11 rounded-xl border px-3 font-normal" value={wardCode} onChange={(event) => setWardCode(event.target.value)} /></label><label className="grid gap-1 text-sm font-semibold">Dung tích (lít)<input type="number" min="1" className="min-h-11 rounded-xl border px-3 font-normal" value={capacity} onChange={(event) => setCapacity(event.target.value)} /></label><button className="min-h-11 self-end rounded-xl bg-emerald-700 px-4 font-bold text-white disabled:opacity-50" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Đang tạo…' : 'Tạo và đưa vào kho'}</button>{create.error && <p className="text-sm text-red-700 md:col-span-3">{create.error instanceof ApiError ? create.error.message : 'Không thể tạo can.'}</p>}</section>}
    <div className="mt-5 flex flex-wrap gap-3"><select className="min-h-11 rounded-xl border bg-white px-3" value={state} onChange={(event) => setState(event.target.value)}><option value="">Tất cả trạng thái</option><option value="AT_MERCHANT">Ở quán / trong kho</option><option value="IN_TRANSIT">Đang vận chuyển</option><option value="AT_STATION">Tại trạm</option></select><label className="flex min-h-11 items-center gap-2 rounded-xl border bg-white px-3 text-sm"><input type="checkbox" checked={unassigned} onChange={(event) => setUnassigned(event.target.checked)} /> Chỉ can chưa gán</label></div>
    <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">{!containers.data?.data.length ? <EmptyState message="Kho chưa có can phù hợp." /> : <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Mã QR</th><th className="pb-3">Dung tích</th><th className="pb-3">Trạng thái</th><th className="pb-3">Quán đang giữ</th><th className="pb-3">Thao tác</th></tr></thead><tbody>{containers.data.data.map((container) => <tr key={container.id} className="border-b last:border-0"><td className="py-4 font-mono font-semibold">{container.qr_code}</td><td className="py-4">{container.capacity_liters ?? '—'} lít</td><td className="py-4"><Badge tone={container.state === 'AT_MERCHANT' ? 'green' : container.state === 'IN_TRANSIT' ? 'orange' : 'slate'}>{container.state}</Badge></td><td className="py-4">{container.merchant?.name ?? <Badge tone="orange">Chưa gán</Badge>}</td><td className="py-4"><div className="flex flex-wrap items-center gap-2"><button className="min-h-10 rounded-lg border px-3 font-semibold" onClick={() => setSelectedId(container.id)}>Xem / in QR</button>{container.merchant ? <button className="min-h-10 rounded-lg border border-red-300 px-3 font-semibold text-red-700" disabled={unassignMutation.isPending} onClick={() => unassignMutation.mutate(container.id)}>Thu hồi</button> : <><select className="min-h-10 rounded-lg border px-2" value={assignTarget[container.id] ?? ''} onChange={(event) => setAssignTarget({ ...assignTarget, [container.id]: event.target.value })}><option value="">Chọn quán để cấp</option>{merchants.data?.data.map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.name}</option>)}</select><button className="min-h-10 rounded-lg bg-emerald-700 px-3 font-semibold text-white disabled:opacity-50" disabled={!assignTarget[container.id] || assign.isPending} onClick={() => assign.mutate({ id: container.id, merchantId: assignTarget[container.id] })}>Cấp can</button></>}</div></td></tr>)}</tbody></table></div>}</section>
    {selected && <div className="fixed inset-0 z-20 grid place-items-center bg-black/50 p-4" role="dialog"><section className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl"><h3 className="text-xl font-bold">Mã QR can</h3><p className="mt-2 font-mono text-sm">{selected.qr_code}</p>{qrDataUrl ? <img className="mx-auto my-4 h-60 w-60" src={qrDataUrl} alt={`Mã QR ${selected.qr_code}`} /> : <Skeleton className="mx-auto my-4 h-60 w-60" />}<p className="text-sm text-slate-600">{selected.merchant?.name ?? 'Can trong kho chưa gán'}</p><div className="mt-4 flex gap-2"><button className="min-h-11 flex-1 rounded-xl bg-emerald-700 font-bold text-white" onClick={() => window.print()}>In mã QR</button><button className="min-h-11 flex-1 rounded-xl border font-bold" onClick={() => setSelectedId(null)}>Đóng</button></div></section></div>}
  </AdminShell>;
}
