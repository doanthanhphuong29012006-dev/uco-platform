'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminContainerSummary } from '@eco-oil/shared-types';
import { api, ApiError } from '../lib/api';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const messages: Record<string, string> = {
    WARD_NOT_FOUND: 'Phường đã chọn không còn tồn tại. Vui lòng chọn lại phường.',
    QR_CODE_ALREADY_EXISTS: 'Mã QR đã tồn tại. Vui lòng thử lại.',
    CONTAINER_NOT_AT_STATION: 'Can không còn ở tại trạm. Vui lòng tải lại danh sách.',
    MERCHANT_REQUIRED: 'Can chưa được gắn với quán nên không thể huỷ ca vận chuyển.',
    CONTAINER_NOT_IN_TRANSIT: 'Can không còn ở trạng thái đang vận chuyển. Vui lòng tải lại danh sách.',
  };
  return messages[error.code] ?? error.message ?? fallback;
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Chưa ghi nhận';
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

export function ContainersView() {
  const queryClient = useQueryClient();
  const [state, setState] = useState('');
  const [unassigned, setUnassigned] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [capacity, setCapacity] = useState('30');
  const [wardId, setWardId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [returnTarget, setReturnTarget] = useState<AdminContainerSummary | null>(null);
  const [returnMerchantId, setReturnMerchantId] = useState('');
  const [returnNote, setReturnNote] = useState('');
  const [cancelTarget, setCancelTarget] = useState<AdminContainerSummary | null>(null);
  const [cancelNote, setCancelNote] = useState('');
  const [assignTarget, setAssignTarget] = useState<Record<string, string>>({});
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const containers = useQuery({ queryKey: ['admin-containers', state, unassigned], queryFn: () => api.containers({ state: state || undefined, unassigned: unassigned || undefined }) });
  const wards = useQuery({ queryKey: ['admin-wards-active'], queryFn: () => api.wards(false) });
  const merchants = useQuery({ queryKey: ['approved-merchants-for-containers'], queryFn: () => api.merchants({ status: 'APPROVED' }) });
  const create = useMutation({ mutationFn: () => api.createContainer({ ward_id: wardId, capacity_liters: Number(capacity) }), onSuccess: () => { setShowCreate(false); void queryClient.invalidateQueries({ queryKey: ['admin-containers'] }); } });
  const assign = useMutation({ mutationFn: ({ id, merchantId }: { id: string; merchantId: string }) => api.assignContainer(id, merchantId), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['admin-containers'] }); } });
  const unassignMutation = useMutation({ mutationFn: api.unassignContainer, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['admin-containers'] }); } });
  const returnMutation = useMutation({
    mutationFn: () => api.returnContainerToMerchant(returnTarget?.id ?? '', { merchant_id: returnMerchantId || undefined, note: returnNote.trim() || undefined }),
    onSuccess: () => { setReturnTarget(null); setReturnNote(''); setReturnMerchantId(''); void queryClient.invalidateQueries({ queryKey: ['admin-containers'] }); },
  });
  const cancelMutation = useMutation({
    mutationFn: () => api.cancelContainerTransit(cancelTarget?.id ?? '', { note: cancelNote.trim() || undefined }),
    onSuccess: () => { setCancelTarget(null); setCancelNote(''); void queryClient.invalidateQueries({ queryKey: ['admin-containers'] }); },
  });
  const selected = containers.data?.data.find((item) => item.id === selectedId) ?? null;
  const transitContainers = containers.data?.data.filter((item) => item.state === 'IN_TRANSIT') ?? [];
  const stationContainers = containers.data?.data.filter((item) => item.state === 'AT_STATION') ?? [];

  useEffect(() => { if (wards.data?.length === 1 && !wardId) setWardId(wards.data[0].id); }, [wardId, wards.data]);
  useEffect(() => {
    let cancelled = false;
    if (!selected) { setQrDataUrl(null); return; }
    void QRCode.toDataURL(selected.qr_code, { width: 240, margin: 2 }).then((url) => { if (!cancelled) setQrDataUrl(url); });
    return () => { cancelled = true; };
  }, [selected]);

  if (containers.isLoading || wards.isLoading) return <AdminShell><Skeleton className="h-10 w-56" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  if (containers.error || wards.error) return <AdminShell><ErrorState message="Không thể tải dữ liệu quản lý can. Vui lòng thử lại." /></AdminShell>;

  function openReturnDialog(container: AdminContainerSummary): void {
    returnMutation.reset(); setReturnTarget(container); setReturnMerchantId(container.merchant?.id ?? ''); setReturnNote('');
  }
  function openCancelDialog(container: AdminContainerSummary): void {
    cancelMutation.reset(); setCancelTarget(container); setCancelNote('');
  }

  return <AdminShell>
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-semibold text-emerald-700">Kho vật tư</p><h2 className="mt-1 text-3xl font-bold">Quản lý can</h2></div><button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white" onClick={() => setShowCreate(!showCreate)}>Tạo can mới</button></div>
    {showCreate && <section className="mt-5 grid gap-3 rounded-2xl border border-emerald-200 bg-white p-5 md:grid-cols-3"><label className="grid gap-1 text-sm font-semibold">Phường<select className="min-h-11 rounded-xl border px-3 font-normal" value={wardId} onChange={(event) => setWardId(event.target.value)}><option value="">Chọn phường</option>{wards.data?.map((ward) => <option key={ward.id} value={ward.id}>{ward.name} ({ward.code})</option>)}</select></label><label className="grid gap-1 text-sm font-semibold">Dung tích (lít)<select className="min-h-11 rounded-xl border px-3 font-normal" value={capacity} onChange={(event) => setCapacity(event.target.value)}><option value="20">20 lít</option><option value="30">30 lít</option><option value="50">50 lít</option></select></label><button className="min-h-11 self-end rounded-xl bg-emerald-700 px-4 font-bold text-white disabled:opacity-50" disabled={!wardId || create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Đang tạo…' : 'Tạo và đưa vào kho'}</button>{create.error && <p className="text-sm text-red-700 md:col-span-3">{friendlyError(create.error, 'Không thể tạo can. Vui lòng thử lại.')}</p>}</section>}
    <div className="mt-5 flex flex-wrap gap-3"><select className="min-h-11 rounded-xl border bg-white px-3" value={state} onChange={(event) => setState(event.target.value)}><option value="">Tất cả trạng thái</option><option value="AT_MERCHANT">Ở quán / trong kho</option><option value="IN_TRANSIT">Đang vận chuyển</option><option value="AT_STATION">Tại trạm</option></select><label className="flex min-h-11 items-center gap-2 rounded-xl border bg-white px-3 text-sm"><input type="checkbox" checked={unassigned} onChange={(event) => setUnassigned(event.target.checked)} /> Chỉ can chưa gán</label></div>
    <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">{!containers.data?.data.length ? <EmptyState message="Kho chưa có can phù hợp." /> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Mã QR</th><th className="pb-3">Dung tích</th><th className="pb-3">Trạng thái</th><th className="pb-3">Quán đang giữ</th><th className="pb-3">Thao tác</th></tr></thead><tbody>{containers.data.data.map((container) => <tr key={container.id} className="border-b last:border-0"><td className="py-4 font-mono font-semibold">{container.qr_code}</td><td className="py-4">{container.capacity_liters ?? '—'} lít</td><td className="py-4"><Badge tone={container.state === 'AT_MERCHANT' ? 'green' : container.state === 'IN_TRANSIT' ? 'orange' : 'slate'}>{container.state}</Badge></td><td className="py-4">{container.merchant?.name ?? <Badge tone="orange">Chưa gán</Badge>}</td><td className="py-4"><div className="flex flex-wrap items-center gap-2"><button className="min-h-10 rounded-lg border px-3 font-semibold" onClick={() => setSelectedId(container.id)}>Xem / in QR</button>{container.state === 'AT_STATION' ? <button className="min-h-10 rounded-lg border border-amber-300 px-3 font-semibold text-amber-800" disabled={returnMutation.isPending} onClick={() => openReturnDialog(container)}>Trả can về quán</button> : null}{container.merchant ? <button className="min-h-10 rounded-lg border border-red-300 px-3 font-semibold text-red-700" disabled={unassignMutation.isPending} onClick={() => unassignMutation.mutate(container.id)}>Thu hồi</button> : <><select className="min-h-10 rounded-lg border px-2" value={assignTarget[container.id] ?? ''} onChange={(event) => setAssignTarget({ ...assignTarget, [container.id]: event.target.value })}><option value="">Chọn quán để cấp</option>{merchants.data?.data.map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.name}</option>)}</select><button className="min-h-10 rounded-lg bg-emerald-700 px-3 font-semibold text-white disabled:opacity-50" disabled={!assignTarget[container.id] || assign.isPending} onClick={() => assign.mutate({ id: container.id, merchantId: assignTarget[container.id] })}>Cấp can</button></>}</div></td></tr>)}</tbody></table></div>}</section>
    {transitContainers.length > 0 ? <section className="mt-5 rounded-2xl border border-orange-200 bg-orange-50 p-5"><h3 className="font-bold text-orange-900">Can đang vận chuyển</h3><div className="mt-3 grid gap-2">{transitContainers.map((container) => <div key={container.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-3"><div><p className="font-mono font-semibold">{container.qr_code}</p><p className="text-sm text-slate-600">{container.merchant?.name ?? 'Chưa gắn quán'} · Rời quán: {formatDateTime(container.last_seen_at)}</p></div><button className="min-h-10 rounded-lg border border-orange-300 px-3 font-semibold text-orange-800" disabled={cancelMutation.isPending} onClick={() => openCancelDialog(container)}>Huỷ ca vận chuyển</button></div>)}</div></section> : null}
    {stationContainers.length > 0 ? <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-5"><h3 className="font-bold text-amber-900">Can đang ở trạm</h3><div className="mt-3 grid gap-2">{stationContainers.map((container) => <div key={container.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-3"><span className="font-mono font-semibold">{container.qr_code}</span><button className="min-h-10 rounded-lg border border-amber-300 px-3 font-semibold text-amber-800" disabled={returnMutation.isPending} onClick={() => openReturnDialog(container)}>Trả can về quán</button></div>)}</div></section> : null}
    {selected && <div className="fixed inset-0 z-20 grid place-items-center bg-black/50 p-4" role="dialog"><section className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl"><h3 className="text-xl font-bold">Mã QR can</h3><p className="mt-2 font-mono text-sm">{selected.qr_code}</p>{qrDataUrl ? <img className="mx-auto my-4 h-60 w-60" src={qrDataUrl} alt={`Mã QR ${selected.qr_code}`} /> : <Skeleton className="mx-auto my-4 h-60 w-60" />}<p className="text-sm text-slate-600">{selected.merchant?.name ?? 'Can trong kho chưa gán'}</p><div className="mt-4 flex gap-2"><button className="min-h-11 flex-1 rounded-xl bg-emerald-700 font-bold text-white" onClick={() => window.print()}>In mã QR</button><button className="min-h-11 flex-1 rounded-xl border font-bold" onClick={() => setSelectedId(null)}>Đóng</button></div></section></div>}
    {returnTarget && <div className="fixed inset-0 z-30 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true"><section className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"><h3 className="text-xl font-bold">Trả can về quán</h3><p className="mt-2 text-sm text-slate-600">{returnTarget.qr_code} đang ở tại trạm. Chọn quán sẽ nhận lại can.</p><label className="mt-5 grid gap-1 text-sm font-semibold">Quán nhận can<select className="min-h-11 rounded-xl border px-3 font-normal" value={returnMerchantId} onChange={(event) => setReturnMerchantId(event.target.value)}><option value="">Chọn quán đã được duyệt</option>{merchants.data?.data.map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.name} — {merchant.ward_name ?? 'Chưa có phường'}</option>)}</select></label><label className="mt-4 grid gap-1 text-sm font-semibold">Ghi chú<textarea className="min-h-24 rounded-xl border p-3 font-normal" value={returnNote} onChange={(event) => setReturnNote(event.target.value)} placeholder="Không bắt buộc" /></label>{returnMutation.error ? <p className="mt-3 text-sm text-red-700">{friendlyError(returnMutation.error, 'Không thể trả can về quán.')}</p> : null}<div className="mt-5 flex justify-end gap-2"><button className="min-h-11 rounded-xl border px-4 font-semibold" disabled={returnMutation.isPending} onClick={() => setReturnTarget(null)}>Huỷ</button><button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white disabled:opacity-50" disabled={!returnMerchantId || returnMutation.isPending} onClick={() => returnMutation.mutate()}>{returnMutation.isPending ? 'Đang trả can…' : 'Xác nhận trả can'}</button></div></section></div>}
    {cancelTarget && <div className="fixed inset-0 z-30 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true"><section className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"><h3 className="text-xl font-bold">Huỷ ca vận chuyển</h3><p className="mt-2 text-sm text-slate-600">Đưa {cancelTarget.qr_code} về trạng thái ở quán và giữ nguyên các giao dịch chưa nộp trạm?</p><label className="mt-5 grid gap-1 text-sm font-semibold">Ghi chú<textarea className="min-h-24 rounded-xl border p-3 font-normal" value={cancelNote} onChange={(event) => setCancelNote(event.target.value)} placeholder="Không bắt buộc" /></label>{cancelMutation.error ? <p className="mt-3 text-sm text-red-700">{friendlyError(cancelMutation.error, 'Không thể huỷ ca vận chuyển.')}</p> : null}<div className="mt-5 flex justify-end gap-2"><button className="min-h-11 rounded-xl border px-4 font-semibold" disabled={cancelMutation.isPending} onClick={() => setCancelTarget(null)}>Huỷ</button><button className="min-h-11 rounded-xl bg-orange-700 px-4 font-bold text-white disabled:opacity-50" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>{cancelMutation.isPending ? 'Đang huỷ…' : 'Xác nhận huỷ ca'}</button></div></section></div>}
  </AdminShell>;
}
