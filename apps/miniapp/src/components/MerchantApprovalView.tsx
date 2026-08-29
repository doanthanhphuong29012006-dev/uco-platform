import { useEffect, useState } from 'react';
import type { AdminWardSummary, AuthUser } from '@eco-oil/shared-types';
import { api, ApiError } from '../lib/api';
import { zaloClient } from '../lib/zalo-client';
import { useAuthStore } from '../stores/auth-store';

const WARD_ID = '10000000-0000-4000-8000-000000000001';

export function MerchantApprovalView({ user }: { user: AuthUser }) {
  const signOut = useAuthStore((state) => state.signOut);
  const hydrate = useAuthStore((state) => state.hydrate);
  const [editing, setEditing] = useState(user.merchantApprovalStatus === 'REJECTED');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [wards, setWards] = useState<AdminWardSummary[]>([]);
  const [wardId, setWardId] = useState('');
  const [form, setForm] = useState({ name: user.name ?? '', address: '', phone: user.phone ?? '', business_type: 'Quán ăn', lat: null as number | null, lng: null as number | null });

  useEffect(() => {
    if (user.merchantId) return;
    void api.registrationWards().then(setWards).catch(() => setMessage('Không tải được danh sách phường. Vui lòng thử lại.'));
  }, [user.merchantId]);

  async function save() {
    if (!user.merchantId) return;
    setBusy(true);
    setMessage(null);
    try {
      const point = await zaloClient.getLocation();
      if (!point) throw new Error('Không lấy được vị trí GPS. Vui lòng bật quyền vị trí rồi thử lại.');
      await api.updateMerchant(user.merchantId, { ...form, lat: point.lat, lng: point.lng, ward_id: WARD_ID });
      setEditing(false);
      setMessage('Đã gửi lại hồ sơ. ECollect sẽ xem xét trong thời gian sớm nhất.');
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Không thể gửi lại hồ sơ. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  }

  async function registerMerchant(): Promise<void> {
    if (user.merchantId || !wardId) return;
    setBusy(true);
    setMessage(null);
    try {
      const point = await zaloClient.getLocation();
      if (!point) throw new Error('Không lấy được vị trí GPS. Vui lòng bật quyền vị trí rồi thử lại.');
      await api.registerMyMerchant({ ...form, ward_id: wardId, lat: point.lat, lng: point.lng });
      await hydrate();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Không thể tạo hồ sơ quán. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  }

  const fields = (
    <div className="approval-form">
      <label>Tên quán<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>Địa chỉ<input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
      <label>Số điện thoại<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label>Loại hình<input value={form.business_type} onChange={(event) => setForm({ ...form, business_type: event.target.value })} /></label>
      {!user.merchantId ? <label>Phường<select value={wardId} onChange={(event) => setWardId(event.target.value)} disabled={!wards.length}><option value="">Chọn phường</option>{wards.map((ward) => <option key={ward.id} value={ward.id}>{ward.name}, {ward.district}</option>)}</select></label> : null}
      <button className="primary-button" onClick={() => { void (user.merchantId ? save() : registerMerchant()); }} disabled={busy || (!user.merchantId && (!wardId || !form.name.trim() || !form.address.trim()))}>{busy ? 'Đang gửi…' : user.merchantId ? 'Gửi lại hồ sơ' : 'Gửi hồ sơ quán'}</button>
    </div>
  );

  if (!user.merchantId || editing) {
    return (
      <main className="approval-page">
        <img className="approval-logo" src="/logo.svg" alt="ECollect" />
        <p className="eyebrow">HỒ SƠ QUÁN</p>
        <h1>{user.merchantId ? 'Cập nhật hồ sơ quán' : 'Hoàn tất hồ sơ quán'}</h1>
        <p>{user.merchantId ? 'Vui lòng chỉnh lại thông tin rồi gửi lại để ECollect xét duyệt.' : 'Bổ sung thông tin quán để gửi hồ sơ xét duyệt.'}</p>
        {fields}
        {message ? <p className="notice-text" role="status">{message}</p> : null}
        <button className="text-button" onClick={() => { void signOut(); }}>Đăng xuất</button>
      </main>
    );
  }

  const rejected = user.merchantApprovalStatus === 'REJECTED';
  return (
    <main className="approval-page">
      <img className="approval-logo" src="/logo.svg" alt="ECollect" />
      <div className={`status-label ${rejected ? 'status-label-danger' : ''}`}>{rejected ? 'Cần cập nhật' : 'Đang xét duyệt'}</div>
      <h1>{rejected ? 'Hồ sơ cần bổ sung' : 'Hồ sơ đang chờ duyệt'}</h1>
      <p>{rejected ? `Lý do: ${user.merchantRejectionReason ?? 'Vui lòng cập nhật lại thông tin.'}` : 'ECollect đang xem xét thông tin quán của bạn. Khi được duyệt, bạn sẽ có thể báo sẵn sàng thu gom.'}</p>
      <p className="hotline">Hotline hỗ trợ: 1900 0000</p>
      {rejected ? <button className="primary-button" onClick={() => setEditing(true)}>Sửa hồ sơ và gửi lại</button> : null}
      <button className="secondary-button" onClick={() => { void signOut(); }}>Đăng xuất</button>
    </main>
  );
}
