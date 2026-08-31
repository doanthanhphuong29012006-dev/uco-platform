'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminCollectorInviteResponse, AdminCollectorSummary } from '@eco-oil/shared-types';
import { api, ApiError } from '../lib/api';
import { formatLiters } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

const empty = { name: '', phone: '', vehicle_type: 'Xe máy có thùng chứa', max_capacity_l: '100' };

function statusLabel(collector: AdminCollectorSummary): string {
  if (!collector.is_active) return 'Đã khóa';
  if (collector.link_status === 'PENDING_LINK') {
    return collector.invite_status === 'EXPIRED' ? 'Lời mời hết hạn' : 'Chờ liên kết';
  }
  return 'Đang hoạt động';
}

function statusTone(collector: AdminCollectorSummary): 'green' | 'orange' | 'red' | 'slate' {
  if (!collector.is_active) return 'slate';
  if (collector.link_status === 'PENDING_LINK')
    return collector.invite_status === 'EXPIRED' ? 'red' : 'orange';
  return 'green';
}

function formatInviteExpiry(value: string | null): string {
  if (!value) return 'không xác định';
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function CollectorsView() {
  const [selected, setSelected] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const [wardIds, setWardIds] = useState<string[]>([]);
  const [createdInvite, setCreatedInvite] = useState<AdminCollectorInviteResponse | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const collectors = useQuery({ queryKey: ['collectors'], queryFn: api.collectors });
  const wards = useQuery({ queryKey: ['admin-wards-active'], queryFn: () => api.wards(false) });
  const performance = useQuery({
    queryKey: ['collector-performance', selected],
    queryFn: () => api.collectorPerformance(selected as string),
    enabled: Boolean(selected),
  });

  const save = useMutation({
    mutationFn: () =>
      editingId
        ? api.updateCollector(editingId, {
            name: form.name,
            phone: form.phone,
            vehicle_type: form.vehicle_type,
            max_capacity_l: Number(form.max_capacity_l),
          })
        : api.createCollector({
            ...form,
            max_capacity_l: Number(form.max_capacity_l),
            ward_ids: wardIds,
          }),
    onSuccess: (result) => {
      if (!editingId) setCreatedInvite(result as AdminCollectorInviteResponse);
      setActionError(null);
      setForm(empty);
      setEditingId(null);
      setShowForm(false);
      void queryClient.invalidateQueries({ queryKey: ['collectors'] });
    },
  });

  const regenerate = useMutation({
    mutationFn: (id: string) => api.regenerateCollectorInvite(id),
    onSuccess: (result) => {
      setCreatedInvite(result);
      setCopyMessage(null);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['collectors'] });
    },
    onError: (error) =>
      setActionError(error instanceof ApiError ? error.message : 'Không thể tạo lại lời mời.'),
  });

  const toggleStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'INACTIVE' }) =>
      api.updateCollector(id, { status }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['collectors'] });
    },
    onError: (error) =>
      setActionError(error instanceof ApiError ? error.message : 'Không thể cập nhật trạng thái.'),
  });

  async function copyInviteLink(inviteUrl: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopyMessage('Đã sao chép link mời.');
    } catch {
      setCopyMessage('Không sao chép được. Vui lòng thử lại trên trình duyệt.');
    }
  }

  if (collectors.isLoading || wards.isLoading)
    return (
      <AdminShell>
        <Skeleton className="h-10 w-56" />
        <Skeleton className="mt-6 h-96" />
      </AdminShell>
    );
  if (collectors.error)
    return (
      <AdminShell>
        <ErrorState
          message={
            collectors.error instanceof ApiError
              ? collectors.error.message
              : 'Không thể tải danh sách người thu gom.'
          }
        />
      </AdminShell>
    );

  return (
    <AdminShell>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-700">Đội vận hành ngoài đường</p>
          <h2 className="mt-1 text-3xl font-bold">Người thu gom</h2>
        </div>
        <button
          className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white"
          onClick={() => {
            setEditingId(null);
            setForm(empty);
            setWardIds(wards.data?.[0] ? [wards.data[0].id] : []);
            setShowForm(!showForm);
          }}
        >
          Tạo tài khoản
        </button>
      </div>
      {createdInvite && (
        <section className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm">
          <p className="font-bold text-emerald-900">
            Đã tạo hồ sơ người thu gom ở trạng thái chờ liên kết.
          </p>
          <p className="mt-1 text-sm text-emerald-800">
            Gửi link này cho đúng người thu gom để họ đăng nhập Zalo và chấp nhận lời mời. Hết hạn
            lúc {formatInviteExpiry(createdInvite.invite_expires_at)}.
          </p>
          <button
            className="mt-3 min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white"
            onClick={() => void copyInviteLink(createdInvite.invite_url)}
          >
            Sao chép link mời
          </button>
          {copyMessage && (
            <p className="mt-2 text-sm font-semibold text-emerald-800" role="status">
              {copyMessage}
            </p>
          )}
        </section>
      )}
      {actionError && (
        <p className="mt-3 text-sm font-semibold text-red-700" role="alert">
          {actionError}
        </p>
      )}
      {showForm && (
        <section className="mt-5 grid gap-3 rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm md:grid-cols-2">
          <h3 className="md:col-span-2 text-lg font-bold">
            {editingId ? 'Sửa tài khoản người thu gom' : 'Tạo tài khoản người thu gom'}
          </h3>
          <label className="grid gap-1 text-sm font-semibold">
            Họ tên
            <input
              className="min-h-11 rounded-xl border border-slate-300 px-3 font-normal"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Số điện thoại
            <input
              className="min-h-11 rounded-xl border border-slate-300 px-3 font-normal"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Loại xe
            <input
              className="min-h-11 rounded-xl border border-slate-300 px-3 font-normal"
              value={form.vehicle_type}
              onChange={(event) => setForm({ ...form, vehicle_type: event.target.value })}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Dung tích xe (lít)
            <input
              type="number"
              min="1"
              className="min-h-11 rounded-xl border border-slate-300 px-3 font-normal"
              value={form.max_capacity_l}
              onChange={(event) => setForm({ ...form, max_capacity_l: event.target.value })}
            />
          </label>
          {!editingId && (
            <fieldset className="grid gap-2 text-sm font-semibold md:col-span-2">
              <legend>Phường phụ trách</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {wards.data?.map((ward) => (
                  <label
                    key={ward.id}
                    className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 font-normal"
                  >
                    <input
                      type="checkbox"
                      checked={wardIds.includes(ward.id)}
                      onChange={(event) =>
                        setWardIds(
                          event.target.checked
                            ? [...wardIds, ward.id]
                            : wardIds.filter((id) => id !== ward.id),
                        )
                      }
                    />
                    {ward.name} ({ward.code})
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <button
            className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white md:col-span-2 disabled:opacity-50"
            disabled={save.isPending || (!editingId && wardIds.length === 0)}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Đang lưu…' : editingId ? 'Lưu thay đổi' : 'Tạo và sinh link mời'}
          </button>
          {save.error && (
            <p className="text-sm text-red-700 md:col-span-2">
              {save.error instanceof ApiError ? save.error.message : 'Không thể lưu tài khoản.'}
            </p>
          )}
        </section>
      )}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        {!collectors.data?.data.length ? (
          <EmptyState message="Chưa có người thu gom." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead className="border-b text-xs uppercase text-slate-400">
                <tr>
                  <th className="pb-3">Họ tên</th>
                  <th className="pb-3">Phường phụ trách</th>
                  <th className="pb-3">Liên hệ</th>
                  <th className="pb-3">Trạng thái</th>
                  <th className="pb-3">Hành động</th>
                  <th className="pb-3">Hiệu suất 7 ngày</th>
                </tr>
              </thead>
              <tbody>
                {collectors.data.data.map((collector) => (
                  <tr key={collector.id} className="border-b last:border-0">
                    <td className="py-4 font-semibold">{collector.display_name}</td>
                    <td className="py-4">
                      {collector.wards
                        .map((ward) => ward.name + ' (' + ward.code + ')')
                        .join(', ') || 'Chưa gán phường'}
                    </td>
                    <td className="py-4">
                      {collector.user?.phone ?? collector.contact_phone ?? '—'}
                    </td>
                    <td className="py-4">
                      <Badge tone={statusTone(collector)}>{statusLabel(collector)}</Badge>
                      {collector.link_status === 'PENDING_LINK' && (
                        <p className="mt-1 text-xs text-slate-500">
                          Hết hạn: {formatInviteExpiry(collector.invite_expires_at)}
                        </p>
                      )}
                    </td>
                    <td className="py-4">
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold"
                          onClick={() => {
                            setEditingId(collector.id);
                            setForm({
                              name: collector.display_name,
                              phone: collector.user?.phone ?? collector.contact_phone ?? '',
                              vehicle_type: collector.vehicle_type ?? '',
                              max_capacity_l: String(collector.max_capacity_l ?? 100),
                            });
                            setShowForm(true);
                          }}
                        >
                          Sửa
                        </button>
                        {collector.link_status === 'PENDING_LINK' &&
                          collector.invite_url &&
                          collector.is_active && (
                            <button
                              className="min-h-10 rounded-lg border border-emerald-700 px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                              onClick={() => void copyInviteLink(collector.invite_url as string)}
                            >
                              Sao chép link mời
                            </button>
                          )}
                        {collector.link_status === 'PENDING_LINK' &&
                          (!collector.invite_url || collector.invite_status === 'EXPIRED') &&
                          collector.is_active && (
                            <button
                              className="min-h-10 rounded-lg border border-emerald-700 px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                              disabled={regenerate.isPending}
                              onClick={() => regenerate.mutate(collector.id)}
                            >
                              {regenerate.isPending ? 'Đang tạo…' : 'Tạo lại lời mời'}
                            </button>
                          )}
                        <button
                          className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold"
                          disabled={toggleStatus.isPending}
                          onClick={() =>
                            toggleStatus.mutate({
                              id: collector.id,
                              status: collector.is_active ? 'INACTIVE' : 'ACTIVE',
                            })
                          }
                        >
                          {collector.is_active ? 'Khóa' : 'Mở khóa'}
                        </button>
                      </div>
                    </td>
                    <td className="py-4">
                      <button
                        className="min-h-10 rounded-lg border border-emerald-700 px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                        onClick={() => setSelected(selected === collector.id ? null : collector.id)}
                      >
                        {selected === collector.id ? 'Đóng' : 'Xem hiệu suất'}
                      </button>
                      {selected === collector.id && (
                        <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">
                          {performance.isLoading ? (
                            'Đang tải…'
                          ) : performance.error ? (
                            'Không tải được hiệu suất.'
                          ) : performance.data ? (
                            <div className="grid gap-1">
                              <span>{formatLiters(performance.data.liters_7d)} / 7 ngày</span>
                              <span>{performance.data.collections_7d} lần thu</span>
                              <span>
                                Chênh lệch: {formatLiters(performance.data.variance_l)} (
                                {(performance.data.variance_pct * 100).toFixed(2)}%)
                              </span>
                              <Badge tone={performance.data.status === 'FLAGGED' ? 'red' : 'green'}>
                                {performance.data.status}
                              </Badge>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AdminShell>
  );
}
