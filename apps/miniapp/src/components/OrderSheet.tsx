import { useState } from 'react';

interface OrderSheetProps {
  busy: boolean;
  onClose: () => void;
  onSubmit: (liters: number | undefined) => void;
}

export function OrderSheet({ busy, onClose, onSubmit }: OrderSheetProps) {
  const [liters, setLiters] = useState('');
  const parsedLiters = liters.trim() ? Number(liters) : undefined;
  const valid = parsedLiters === undefined || (Number.isFinite(parsedLiters) && parsedLiters > 0);

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="order-sheet-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 id="order-sheet-title">Báo sẵn sàng thu gom</h2>
        <p>Nhập số lít ước lượng để collector chuẩn bị chuyến đi.</p>
        <label htmlFor="estimated-liters">Số lít ước lượng</label>
        <div className="input-with-suffix">
          <input id="estimated-liters" inputMode="decimal" type="number" min="0.1" step="0.1" value={liters} onChange={(event) => setLiters(event.target.value)} placeholder="Ví dụ: 18.5" />
          <span>lít</span>
        </div>
        {!valid ? <p className="error-text">Vui lòng nhập số lít lớn hơn 0.</p> : null}
        <div className="sheet-actions">
          <button className="secondary-button" onClick={onClose} disabled={busy}>Để sau</button>
          <button className="primary-button" onClick={() => onSubmit(parsedLiters)} disabled={busy || !valid}>
            {busy ? 'Đang gửi…' : 'Báo ngay'}
          </button>
        </div>
      </section>
    </div>
  );
}
