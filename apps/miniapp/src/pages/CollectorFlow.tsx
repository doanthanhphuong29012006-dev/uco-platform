import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ContainerState, Quality } from '@eco-oil/shared-types';
import type { CollectionCreateRequest, ContainerLookupResponse, GeoPoint, RouteStop } from '@eco-oil/shared-types';
import { ApiError, api } from '../lib/api';
import { formatLiters } from '../lib/formatters';
import { zaloClient, WARD_CENTER } from '../lib/zalo-client';
import type { PhotoAsset } from '../lib/zalo-client';
import { StatusView } from '../components/StatusView';

type CollectorScreen =
  | { name: 'route' }
  | { name: 'qr'; stop: RouteStop }
  | { name: 'entry'; stop: RouteStop; container: ContainerLookupResponse }
  | { name: 'summary' };

export function CollectorFlow() {
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<CollectorScreen>({ name: 'route' });
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [locationDenied, setLocationDenied] = useState(false);
  const [completed, setCompleted] = useState<Record<string, number>>({});
  const [initialStopCount, setInitialStopCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void zaloClient.getCurrentLocation().then((point) => {
      if (active) {
        setLocation(point);
      }
    }).catch(() => {
      if (active) {
        setLocationDenied(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const route = useQuery({
    queryKey: ['collector-route', location],
    queryFn: () => api.currentRoute(location ?? undefined),
    staleTime: 15_000,
  });

  useEffect(() => {
    if (route.data && initialStopCount === null) {
      setInitialStopCount(route.data.stops.length);
    }
  }, [initialStopCount, route.data]);

  if (screen.name === 'qr') {
    return <CollectorQrScreen stop={screen.stop} onBack={() => setScreen({ name: 'route' })} onContinue={(container) => setScreen({ name: 'entry', stop: screen.stop, container })} />;
  }
  if (screen.name === 'entry') {
    return (
      <CollectorEntryScreen
        stop={screen.stop}
        container={screen.container}
        onBack={() => setScreen({ name: 'qr', stop: screen.stop })}
        onSuccess={(liters) => {
          setCompleted((current) => ({ ...current, [screen.stop.order_id]: liters }));
          setScreen({ name: 'route' });
          void queryClient.invalidateQueries({ queryKey: ['collector-route'] });
        }}
      />
    );
  }
  if (screen.name === 'summary') {
    return <CollectorSummaryScreen route={route.data} completed={completed} totalStops={initialStopCount ?? route.data?.stops.length ?? 0} onBack={() => setScreen({ name: 'route' })} />;
  }
  if (route.isPending) {
    return <StatusView title="Đang tải tuyến hôm nay…" />;
  }
  if (route.isError) {
    return <StatusView title="Chưa tải được tuyến" message="Kiểm tra kết nối rồi thử lại." action={{ label: 'Thử lại', onClick: () => { void route.refetch(); } }} />;
  }

  const activeStops = route.data.stops.filter((stop) => completed[stop.order_id] === undefined);
  return (
    <CollectorRouteScreen
      stops={activeStops}
      route={route.data}
      location={location}
      locationDenied={locationDenied}
      completed={completed}
      totalStops={initialStopCount ?? route.data.stops.length}
      onOpenQr={(stop) => setScreen({ name: 'qr', stop })}
      onOpenSummary={() => setScreen({ name: 'summary' })}
      onRefresh={() => void route.refetch()}
    />
  );
}

interface CollectorRouteScreenProps {
  stops: RouteStop[];
  route: { total_expected_liters: number; remaining_capacity_l: number };
  location: GeoPoint | null;
  locationDenied: boolean;
  completed: Record<string, number>;
  totalStops: number;
  onOpenQr: (stop: RouteStop) => void;
  onOpenSummary: () => void;
  onRefresh: () => void;
}

function CollectorRouteScreen({ stops, route, location, locationDenied, completed, totalStops, onOpenQr, onOpenSummary, onRefresh }: CollectorRouteScreenProps) {
  const vehicleCapacity = route.total_expected_liters + route.remaining_capacity_l;
  const routeFill = vehicleCapacity > 0 ? Math.min(100, Math.round((route.total_expected_liters / vehicleCapacity) * 100)) : 0;
  const completedLiters = Object.values(completed).reduce((sum, liters) => sum + liters, 0);

  return (
    <div className="page-content collector-content">
      <header className="page-header">
        <div><p className="eyebrow">CA HÔM NAY</p><h1>Tuyến thu gom</h1></div>
        <button className="round-action" onClick={onRefresh} aria-label="Tải lại tuyến">↻</button>
      </header>
      {locationDenied ? <div className="location-banner">Bạn đang dùng tâm phường. Bật quyền vị trí để khoảng cách và tuyến chính xác hơn.</div> : null}
      {!location && !locationDenied ? <div className="location-banner">Đang xin quyền vị trí để tính tuyến gần nhất…</div> : null}
      <section className="route-capacity-card">
        <div className="route-capacity-top"><span>Tổng lít dự kiến</span><strong>{formatLiters(route.total_expected_liters)} / {formatLiters(vehicleCapacity)}</strong></div>
        <div className="route-progress"><span className={routeFill >= 80 ? 'route-progress-high' : ''} style={{ width: `${routeFill}%` }} /></div>
        <div className="route-capacity-bottom"><span>{routeFill}% dung tích xe</span><span>{formatLiters(route.remaining_capacity_l)} còn trống</span></div>
      </section>
      <div className="route-summary-line"><strong>{Object.keys(completed).length} / {totalStops} điểm đã thu</strong><button className="text-button" onClick={onOpenSummary}>Tóm tắt ca</button></div>
      {stops.length === 0 ? (
        <StatusView title="Đã hoàn thành tuyến" message={completedLiters > 0 ? `Đã thu ${formatLiters(completedLiters)}. Bạn có thể xem lại tóm tắt ca.` : 'Hiện chưa có điểm READY trong phường.'} action={{ label: 'Xem tóm tắt ca', onClick: onOpenSummary }} />
      ) : (
        <section className="collector-stop-list">
          {stops.map((stop) => <CollectorStopCard key={stop.order_id} stop={stop} onOpenQr={() => onOpenQr(stop)} />)}
        </section>
      )}
    </div>
  );
}

function CollectorStopCard({ stop, onOpenQr }: { stop: RouteStop; onOpenQr: () => void }) {
  return (
    <article className="collector-stop-card">
      <div className="stop-number">{stop.seq}</div>
      <div className="stop-body">
        <div className="stop-title-row"><h2>{stop.merchant.name}</h2><span className="distance-label">{formatDistance(stop.distance_m)}</span></div>
        <p className="stop-address">{stop.merchant.address ?? 'Chưa có địa chỉ'}</p>
        <strong className="stop-liters">{formatLiters(stop.expected_liters)} dự kiến</strong>
        <div className="stop-actions">
          <a className={`call-action ${stop.merchant.phone ? '' : 'disabled-action'}`} href={stop.merchant.phone ? `tel:${stop.merchant.phone}` : undefined}>☎ Gọi quán</a>
          <button className="map-action" onClick={() => zaloClient.openDirections({ lat: stop.merchant.lat, lng: stop.merchant.lng })}>↗ Chỉ đường</button>
          <button className="collect-action" onClick={onOpenQr}>Thu gom</button>
        </div>
      </div>
    </article>
  );
}

function CollectorQrScreen({ stop, onBack, onContinue }: { stop: RouteStop; onBack: () => void; onContinue: (container: ContainerLookupResponse) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [container, setContainer] = useState<ContainerLookupResponse | null>(null);

  async function lookup(inputCode: string) {
    const normalized = inputCode.trim();
    if (!normalized) {
      setError('Vui lòng nhập mã can.');
      return;
    }
    setBusy(true);
    setError(null);
    setMismatch(false);
    setContainer(null);
    try {
      const found = await api.containerByQr(normalized);
      if (found.qr_code !== stop.container_code) {
        setMismatch(true);
        return;
      }
      setContainer(found);
    } catch (requestError) {
      setError(requestError instanceof ApiError && requestError.code === 'NOT_FOUND' ? 'Không tìm thấy can này.' : 'Chưa tra được mã can, thử lại nhé.');
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      const scannedCode = await zaloClient.scanQrCode();
      setCode(scannedCode);
      await lookup(scannedCode);
    } catch {
      setError('Không quét được mã. Bạn có thể nhập tay mã can.');
      setBusy(false);
    }
  }

  return (
    <div className="page-content collector-content">
      <button className="back-button" onClick={onBack}>← Quay lại tuyến</button>
      <header className="collector-screen-heading"><p className="eyebrow">ĐIỂM {stop.seq}</p><h1>Quét mã can</h1><p>{stop.merchant.name}</p></header>
      <section className="qr-target-card"><span>Can cần thu</span><strong>{stop.container_code}</strong><small>{stop.merchant.address ?? ''}</small></section>
      <button className="scan-button" onClick={() => void scan()} disabled={busy}>▣ {busy ? 'Đang kiểm tra…' : 'Quét QR bằng camera'}</button>
      {import.meta.env.DEV ? (
        <section className="manual-qr-card">
          <p className="section-label">Môi trường phát triển</p>
          <label htmlFor="manual-qr">Nhập tay mã can</label>
          <input id="manual-qr" value={code} onChange={(event) => setCode(event.target.value)} placeholder="ECO-UCO-Q3P7-001" />
          <button className="secondary-button" onClick={() => void lookup(code)} disabled={busy}>Tra mã can</button>
        </section>
      ) : null}
      {error ? <div className="error-panel">{error}</div> : null}
      {mismatch ? <div className="warning-panel"><strong>Đây không phải can của điểm này</strong><span>Kiểm tra lại mã QR. Không thể ghi nhận nhầm can.</span></div> : null}
      {container ? (
        <section className="verified-container-card">
          <span className="verified-badge">✓ Đã đối chiếu</span>
          <h2>{container.merchant.name}</h2>
          <p>{container.qr_code} · {formatLiters(container.capacity_liters)} · {container.state === ContainerState.AT_MERCHANT ? 'Đang ở quán' : container.state}</p>
          <button className="primary-button" onClick={() => onContinue(container)}>Tiếp tục nhập giao dịch</button>
        </section>
      ) : null}
    </div>
  );
}

function CollectorEntryScreen({ stop, container, onBack, onSuccess }: { stop: RouteStop; container: ContainerLookupResponse; onBack: () => void; onSuccess: (liters: number) => void }) {
  const [liters, setLiters] = useState('');
  const [quality, setQuality] = useState<Quality>(Quality.PASS);
  const [photos, setPhotos] = useState<PhotoAsset[]>([]);
  const [geo, setGeo] = useState<GeoPoint | null>(null);
  const [sending, setSending] = useState(false);
  const [takingPhoto, setTakingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [clientUuid] = useState(() => crypto.randomUUID());
  const capacity = Number(container.capacity_liters ?? 0);
  const actualLiters = Number(liters);
  const maxLiters = capacity * 1.1;
  const invalidLiters = !Number.isFinite(actualLiters) || actualLiters <= 0 || actualLiters > maxLiters;

  function adjustLiters(amount: number) {
    const next = Math.max(0, (Number(liters) || 0) + amount);
    setLiters(next.toFixed(1));
  }

  async function takePhoto() {
    setTakingPhoto(true);
    setError(null);
    try {
      const photo = await zaloClient.capturePhoto();
      setPhotos((current) => [...current, photo]);
    } catch {
      setError('Chưa chụp được ảnh, thử lại nhé.');
    } finally {
      setTakingPhoto(false);
    }
  }

  async function submit() {
    if (invalidLiters) {
      setError(`Số lít phải lớn hơn 0 và không vượt ${maxLiters.toFixed(1)} lít.`);
      return;
    }
    if (quality === Quality.FLAG && photos.length === 0) {
      setError('Chất lượng cần kiểm tra bắt buộc có ít nhất 1 ảnh.');
      return;
    }
    if (sending || success) {
      return;
    }
    setSending(true);
    setError(null);
    let currentGeo = geo;
    if (!currentGeo) {
      try {
        currentGeo = await zaloClient.getCurrentLocation();
      } catch {
        currentGeo = WARD_CENTER;
      }
      setGeo(currentGeo);
    }
    const payload: CollectionCreateRequest = {
      client_uuid: clientUuid,
      order_id: stop.order_id,
      container_code: stop.container_code,
      actual_liters: actualLiters,
      quality,
      geo: currentGeo,
      photos: photos.map((photo) => photo.url),
    };
    try {
      await api.createCollection(payload);
      setSuccess(true);
      window.setTimeout(() => onSuccess(actualLiters), 450);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === 'INVALID_LITERS') {
        setError(`Server từ chối số lít. Tối đa cho can này là ${maxLiters.toFixed(1)} lít.`);
      } else {
        setError('Chưa gửi được, thử lại. Dữ liệu và mã giao dịch vẫn được giữ nguyên.');
      }
    } finally {
      setSending(false);
    }
  }

  if (success) {
    return <div className="success-screen"><div className="success-icon">✓</div><h1>Đã ghi nhận giao dịch</h1><p>{formatLiters(actualLiters)} · Mã giao dịch đã được lưu an toàn.</p></div>;
  }

  return (
    <div className="page-content collector-content">
      <button className="back-button" onClick={onBack} disabled={sending}>← Quay lại quét mã</button>
      <header className="collector-screen-heading"><p className="eyebrow">GHI NHẬN THU GOM</p><h1>{container.merchant.name}</h1><p>{container.qr_code}</p></header>
      <section className="entry-target-card"><span>Số lít dự kiến</span><strong>{formatLiters(stop.expected_liters)}</strong><small>Mã giao dịch: {clientUuid.slice(0, 8)}…</small></section>
      <section className="liter-entry-card">
        <label htmlFor="actual-liters">Số lít thực tế</label>
        <div className="large-number-input"><button onClick={() => adjustLiters(-0.5)} disabled={sending}>−</button><input id="actual-liters" type="number" inputMode="decimal" step="0.5" min="0" value={liters} onChange={(event) => setLiters(event.target.value)} placeholder="0.0" /><span>lít</span><button onClick={() => adjustLiters(0.5)} disabled={sending}>+</button></div>
        <p className={invalidLiters && liters ? 'error-text' : 'field-help'}>Dung tích {formatLiters(capacity)} · tối đa {maxLiters.toFixed(1)} lít</p>
      </section>
      <section className="quality-card"><p className="section-label">Chất lượng dầu</p><div className="quality-options"><button className={quality === Quality.PASS ? 'quality-option selected' : 'quality-option'} onClick={() => setQuality(Quality.PASS)} disabled={sending}>✓ Đạt</button><button className={quality === Quality.FLAG ? 'quality-option selected flag-selected' : 'quality-option'} onClick={() => setQuality(Quality.FLAG)} disabled={sending}>⚠ Cần kiểm tra</button></div></section>
      {quality === Quality.FLAG ? <section className="photo-card"><div><strong>Ảnh kiểm tra</strong><p>{photos.length > 0 ? `${photos.length} ảnh đã chụp` : 'Cần ít nhất 1 ảnh'}</p></div><button className="secondary-button" onClick={() => void takePhoto()} disabled={takingPhoto || sending}>{takingPhoto ? 'Đang chụp…' : 'Chụp ảnh'}</button></section> : null}
      {error ? <div className="error-panel">{error}</div> : null}
      <button className="submit-collection-button" onClick={() => void submit()} disabled={sending || invalidLiters || (quality === Quality.FLAG && photos.length === 0)}>{sending ? 'Đang gửi giao dịch…' : 'Xác nhận thu gom'}</button>
    </div>
  );
}

function CollectorSummaryScreen({ route, completed, totalStops, onBack }: { route: { total_expected_liters: number; remaining_capacity_l: number } | undefined; completed: Record<string, number>; totalStops: number; onBack: () => void }) {
  const totalCollected = Object.values(completed).reduce((sum, liters) => sum + liters, 0);
  const vehicleCapacity = route ? route.total_expected_liters + route.remaining_capacity_l : 0;
  return (
    <div className="page-content collector-content summary-page">
      <button className="back-button" onClick={onBack}>← Về tuyến hôm nay</button>
      <header className="collector-screen-heading"><p className="eyebrow">KẾT QUẢ CA</p><h1>Tóm tắt thu gom</h1></header>
      <div className="summary-hero"><span>Đã thu hôm nay</span><strong>{formatLiters(totalCollected)}</strong></div>
      <section className="summary-grid"><div><span>Điểm đã thu</span><strong>{Object.keys(completed).length} / {totalStops}</strong></div><div><span>Dung tích còn lại</span><strong>{formatLiters(Math.max(vehicleCapacity - totalCollected, 0))}</strong></div></section>
      <button className="station-button" disabled>Đi nộp trạm <small>Sắp có ở bước tiếp theo</small></button>
    </div>
  );
}

function formatDistance(distanceM: number): string {
  return distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(1)} km`;
}
