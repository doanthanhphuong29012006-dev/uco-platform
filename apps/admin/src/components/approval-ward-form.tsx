'use client';
import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';

export function ApprovalWardForm({ onCreated }: { onCreated: (id: string) => void }) {
  const queries = useQueryClient();
  const [form, setForm] = useState({ code: '', name: '', district: '', city: '' });
  const create = useMutation({
    mutationFn: () => api.createWard(form),
    onSuccess: async (ward) => {
      await Promise.all([queries.invalidateQueries({ queryKey: ['wards'] }), queries.invalidateQueries({ queryKey: ['admin-wards-all'] })]);
      onCreated(ward.id);
    },
  });
  return <form className="grid gap-3 rounded-xl border bg-white p-4" onSubmit={(event) => { event.preventDefault(); if (!create.isPending) create.mutate(); }}>
    <p>Mã dưới đây là mã nội bộ duy nhất. Chỉ dùng mã hành chính chính thức khi đã đối chiếu nguồn chính thức; hệ thống không tự sinh mã hành chính.</p>
    {([['code', 'Mã phường nội bộ'], ['name', 'Tên phường'], ['district', 'Quận / huyện (theo danh mục vận hành)'], ['city', 'Tỉnh / thành phố']] as const).map(([key, label]) => <label key={key}>{label}<input className="block min-h-11 rounded border px-3" required value={form[key]} disabled={create.isPending} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>)}
    <button type="submit" disabled={create.isPending}>{create.isPending ? 'Đang thêm…' : 'Lưu phường mới'}</button>
    {create.error ? <p role="alert">{create.error instanceof ApiError && create.error.code === 'WARD_CODE_ALREADY_EXISTS' ? 'Mã phường đã tồn tại. Hãy chọn phường có sẵn hoặc nhập mã khác.' : create.error.message}</p> : null}
  </form>;
}
