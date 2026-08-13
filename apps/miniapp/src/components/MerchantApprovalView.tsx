import { useState } from 'react';
import type { AuthUser } from '@eco-oil/shared-types';
import { api, ApiError } from '../lib/api';
import { zaloClient } from '../lib/zalo-client';
import { useAuthStore } from '../stores/auth-store';

const WARD_ID = '10000000-0000-4000-8000-000000000001';

export function MerchantApprovalView({ user }: { user: AuthUser }) {
  const signOut = useAuthStore((state) => state.signOut);
  const [editing, setEditing] = useState(user.merchantApprovalStatus === 'REJECTED');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ name: user.name ?? '', address: '', phone: user.phone ?? '', business_type: 'Quán ăn', lat: null as number | null, lng: null as number | null });

  async function save() {
    if (!user.merchantId) return;
    setBusy(true); setMessage(null);
    try {
      const point = await zaloClient.getLocation();
      if (!point) throw new Error('Không lấy được vị trí GPS. Vui lòng bật quyền vị trí rồi thử lại.');
      await api.updateMerchant(user.merchantId, { ...form, lat: point.lat, lng: point.lng, ward_id: WARD_ID });
      setEditing(false);
      setMessage('Đã gửi lại hồ sơ. Eco-Oil sẽ xem xét trong thời gian sớm nhất.');
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Không thể gửi lại hồ sơ. Vui lòng thử lại.');
    } finally { setBusy(false); }
  }

  if (editing) return <main className="approval-page"><img className="approval-logo" src="/logo.svg" alt="Eco-Oil" /><h1>Cập nhật hồ sơ quán</h1><p>Vui lòng chỉnh lại thông tin rồi gửi lại để Eco-Oil xét duyệt.</p><div className="approval-form"><label>Tên quán<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Địa chỉ<input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label><label>Số điện thoại<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label><label>Loại hình<input value={form.business_type} onChange={(e) => setForm({ ...form, business_type: e.target.value })} /></label><button className="primary-button" onClick={() => void save()} disabled={busy}>{busy ? 'Đang gửi…' : 'Gửi lại hồ sơ'}</button></div>{message && <p className="notice-text">{message}</p>}<button className="text-button" onClick={signOut}>Đăng xuất</button></main>;

  return <main className="approval-page"><img className="approval-logo" src="/logo.svg" alt="Eco-Oil" /><div className="status-icon">{user.merchantApprovalStatus === 'REJECTED' ? '!' : '✓'}</div><h1>{user.merchantApprovalStatus === 'REJECTED' ? 'Hồ sơ cần bổ sung' : 'Hồ sơ đang chờ duyệt'}</h1><p>{user.merchantApprovalStatus === 'REJECTED' ? `Lý do: ${user.merchantRejectionReason ?? 'Vui lòng cập nhật lại thông tin.'}` : 'Eco-Oil đang xem xét thông tin quán của bạn. Khi được duyệt, bạn sẽ có thể báo sẵn sàng thu gom.'}</p><p className="hotline">Hotline hỗ trợ: 1900 0000</p>{user.merchantApprovalStatus === 'REJECTED' && <button className="primary-button" onClick={() => setEditing(true)}>Sửa hồ sơ và gửi lại</button>}<button className="secondary-button" onClick={signOut}>Đăng xuất</button></main>;
}
