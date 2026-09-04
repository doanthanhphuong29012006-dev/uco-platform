import { useEffect, useRef, useState } from 'react';
import type { AuthUser } from '@eco-oil/shared-types';
import { api } from '../lib/api';
import { isValidGeoPoint, normalizeVietnamesePhone, zaloClient } from '../lib/zalo-client';
import { requireConfirmedMerchantLocation, type ConfirmedMerchantLocation } from '../lib/merchant-location';
import { useAuthStore } from '../stores/auth-store';

export function MerchantApprovalView({ user }: { user: AuthUser }) {
  const signOut = useAuthStore((state) => state.signOut);
  const hydrate = useAuthStore((state) => state.hydrate);
  const [editing, setEditing] = useState(user.merchantApprovalStatus === 'REJECTED');
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const locationLock = useRef(false);
  const [loading, setLoading] = useState(Boolean(user.merchantId));
  const [message, setMessage] = useState<string | null>(null);
  const [wardId, setWardId] = useState<string | null>(null);
  const [location, setLocation] = useState<ConfirmedMerchantLocation | null>(null);
  const [form, setForm] = useState({ name: user.name ?? '', address: '', phone: user.phone ?? '', business_type: 'Quán ăn' });

  useEffect(() => {
    if (!user.merchantId) return;
    let active = true;
    void api.myMerchant().then((profile) => {
      if (!active) return;
      setForm({ name: profile.name, address: profile.address ?? '', phone: profile.user.phone ?? '', business_type: profile.business_type ?? '' });
      setWardId(profile.ward_id);
      setLoading(false);
    }).catch(() => { if (active) setMessage('Không tải được hồ sơ. Thông tin cũ chưa bị thay đổi; hãy mở lại để thử lại.'); });
    return () => { active = false; };
  }, [user.merchantId]);

  async function locate(): Promise<void> {
    if (locationLock.current) return;
    locationLock.current = true;
    setLocating(true);
    setMessage(null);
    setLocation(null);
    try {
      const point = await zaloClient.getLocation();
      if (!point || !isValidGeoPoint(point)) throw new Error('Không nhận được GPS thật. Hãy thử lại tại quán.');
      setLocation({ point, capturedAt: Date.now(), confirmed: false });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không lấy được vị trí. Thông tin đã nhập được giữ nguyên.');
    } finally {
      locationLock.current = false;
      setLocating(false);
    }
  }

  async function submit(): Promise<void> {
    if (busy || locating || loading) return;
    setBusy(true);
    setMessage(null);
    try {
      if (!form.name.trim() || !form.address.trim()) throw new Error('Tên quán và địa chỉ là bắt buộc.');
      const point = requireConfirmedMerchantLocation(location);
      const payload = { ...form, name: form.name.trim(), address: form.address.trim(), phone: normalizeVietnamesePhone(form.phone), ...point };
      // Omit ward_id: never overwrite an Admin's existing assignment on resubmission.
      if (user.merchantId) await api.updateMerchant(user.merchantId, payload);
      else await api.registerMyMerchant(payload);
      setEditing(false);
      setMessage('Đã gửi hồ sơ. Quán chỉ tham gia thu gom sau khi Admin gán phường và duyệt.');
      await hydrate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không gửi được hồ sơ. Hãy thử lại.');
    } finally { setBusy(false); }
  }

  return <main className="approval-page">
    <img className="approval-logo" src="/logo.svg" alt="ECOllect" />
    <h1>{!user.merchantId || editing ? 'Hoàn tất hồ sơ quán' : 'Hồ sơ đang chờ duyệt'}</h1>
    <p>{wardId ? 'Đã có phường trong hồ sơ; Admin sẽ kiểm tra khi duyệt.' : 'Chờ Admin gán phường. Bạn không cần biết mã phường.'}</p>
    {!user.merchantId || editing ? <div className="approval-form">
      <fieldset disabled={loading || busy}>
        <label>Tên quán<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Số điện thoại<input inputMode="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
        <label>Địa chỉ<input value={form.address} onChange={(event) => { setForm({ ...form, address: event.target.value }); setLocation((current) => current ? { ...current, confirmed: false } : null); }} /></label>
        <label>Loại hình<input value={form.business_type} onChange={(event) => setForm({ ...form, business_type: event.target.value })} /></label>
        <button type="button" className="secondary-button" disabled={locating} onClick={() => void locate()}>{locating ? 'Đang lấy GPS…' : 'Lấy vị trí quán'}</button>
        {location ? <section>
          <p>GPS: {location.point.lat.toFixed(6)}, {location.point.lng.toFixed(6)}</p>
          <a href={`https://www.google.com/maps/search/?api=1&query=${location.point.lat},${location.point.lng}`} target="_blank" rel="noreferrer">Kiểm tra trên bản đồ</a>
          <label><input type="checkbox" checked={location.confirmed} onChange={(event) => setLocation({ ...location, confirmed: event.target.checked })} />Tôi xác nhận đây là vị trí quán, khớp địa chỉ đã nhập</label>
        </section> : null}
        <button type="button" className="primary-button" disabled={locating || !location?.confirmed} onClick={() => void submit()}>{busy ? 'Đang gửi…' : 'Gửi hồ sơ quán'}</button>
      </fieldset>
    </div> : <p>{user.merchantRejectionReason ?? 'Quán chưa thể báo READY cho đến khi hồ sơ được duyệt.'}</p>}
    {user.merchantApprovalStatus === 'REJECTED' && !editing ? <button className="primary-button" onClick={() => setEditing(true)}>Sửa hồ sơ và gửi lại</button> : null}
    {message ? <p role="status">{message}</p> : null}
    <button className="secondary-button" onClick={() => void signOut()}>Đăng xuất</button>
  </main>;
}
