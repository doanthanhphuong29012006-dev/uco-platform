import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ContainerState, Quality } from '@eco-oil/shared-types';
import type { CollectionCreateRequest, ContainerLookupResponse, CurrentRouteResponse, GeoPoint, RouteStop } from '@eco-oil/shared-types';
import { ApiError } from '../lib/api';
import { formatLiters } from '../lib/formatters';
import { retryOutbox, type OutboxRecord } from '../lib/outbox-db';
import { useOnlineStatus, useOutboxRows, useOutboxStats } from '../lib/outbox-hooks';
import { loadRouteWithCache, lookupContainerWithCache, prefetchRouteData, type RouteLoadResult } from '../lib/offline-cache';
import { enqueueCollection } from '../lib/outbox-db';
import { startOutboxSyncWorker, syncOutbox } from '../lib/outbox-sync';
import { submitContainerCode } from '../lib/container-code';
import { zaloClient } from '../lib/zalo-client';
import type { PhotoAsset } from '../lib/zalo-client';
import { StatusView } from '../components/StatusView';
import { StationDeliveryFlow } from './StationDeliveryFlow';

type CollectorScreen =
  | { name: 'route' }
  | { name: 'qr'; stop: RouteStop }
  | { name: 'entry'; stop: RouteStop; container: ContainerLookupResponse; containerCode: string }
  | { name: 'summary' }
  | { name: 'station-delivery' }
  | { name: 'outbox' };

export interface CompletedStop {
  liters: number;
  clientUuid: string;
  stop: RouteStop;
}

export function CollectorFlow() {
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<CollectorScreen>({ name: 'route' });
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [locationDenied, setLocationDenied] = useState(false);
  const [completed, setCompleted] = useState<Record<string, CompletedStop>>({});
  const [initialStopCount, setInitialStopCount] = useState<number | null>(null);
  const [shiftStarted, setShiftStarted] = useState(false);
  const [prefetching, setPrefetching] = useState(false);
  const online = useOnlineStatus();
  const outboxStats = useOutboxStats();
  const outboxRows = useOutboxRows();

  useEffect(() => {
    void startOutboxSyncWorker();
    let active = true;
    void zaloClient.getLocation().then((point) => {
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

  const route = useQuery<RouteLoadResult>({
    queryKey: ['collector-route', location],
    queryFn: () => loadRouteWithCache(location ?? undefined),
    staleTime: 15_000,
  });

  useEffect(() => {
    const wardCenter = route.data?.route.stops.find((stop) => stop.ward_center)?.ward_center;
    if (!location && wardCenter) {
      setLocation(wardCenter);
      setLocationDenied(true);
    }
  }, [location, route.data]);

  useEffect(() => {
    if (route.data && initialStopCount === null) {
      setInitialStopCount(route.data.route.stops.length);
    }
  }, [initialStopCount, route.data]);

  async function startShift(): Promise<void> {
    if (!route.data || prefetching) {
      return;
    }
    setPrefetching(true);
    try {
      await prefetchRouteData(route.data.route, location);
      setShiftStarted(true);
    } finally {
      setPrefetching(false);
    }
  }

  function onCollectionSaved(stop: RouteStop, liters: number, clientUuid: string): void {
    setCompleted((current) => ({ ...current, [stop.order_id]: { liters, clientUuid, stop } }));
    setScreen({ name: 'route' });
    void queryClient.invalidateQueries({ queryKey: ['collector-route'] });
  }

  let content: ReactNode;
  if (screen.name === 'outbox') {
    content = <OutboxQueueScreen onBack={() => setScreen({ name: 'route' })} />;
  } else if (screen.name === 'qr') {
     content = <CollectorQrScreen stop={screen.stop} onBack={() => setScreen({ name: 'route' })} onContinue={(container, containerCode) => setScreen({ name: 'entry', stop: screen.stop, container, containerCode })} />;
  } else if (screen.name === 'entry') {
    content = (
      <CollectorEntryScreen
        stop={screen.stop}
        container={screen.container}
        containerCode={screen.containerCode}
        onBack={() => setScreen({ name: 'qr', stop: screen.stop })}
        onSuccess={(liters, clientUuid) => onCollectionSaved(screen.stop, liters, clientUuid)}
      />
    );
  } else if (screen.name === 'summary') {
    content = <CollectorSummaryScreen route={route.data?.route} completed={completed} totalStops={initialStopCount ?? route.data?.route.stops.length ?? 0} onBack={() => setScreen({ name: 'route' })} onOpenDelivery={() => setScreen({ name: 'station-delivery' })} />;
  } else if (screen.name === 'station-delivery') {
    content = <StationDeliveryFlow completed={completed} onBack={() => setScreen({ name: 'route' })} />;
  } else if (route.isPending) {
    content = <StatusView title="Đang tải tuyến hôm nay…" />;
  } else if (route.isError) {
    content = <StatusView title="Chưa tải được tuyến" message="Chưa có dữ liệu tuyến trên máy. Kiểm tra kết nối rồi thử lại." action={{ label: 'Thử lại', onClick: () => { void route.refetch(); } }} />;
  } else {
    const activeStops = route.data.route.stops.filter((stop) => completed[stop.order_id] === undefined);
    content = (
      <CollectorRouteScreen
        stops={activeStops}
        route={route.data}
        location={location}
        locationDenied={locationDenied}
        completed={completed}
        totalStops={initialStopCount ?? route.data.route.stops.length}
        outboxRows={outboxRows}
        outboxStats={outboxStats}
        shiftStarted={shiftStarted}
        prefetching={prefetching}
        onStartShift={() => { void startShift(); }}
        onOpenQr={(stop) => setScreen({ name: 'qr', stop })}
        onOpenSummary={() => setScreen({ name: 'summary' })}
        onOpenOutbox={() => setScreen({ name: 'outbox' })}
        onRefresh={() => void route.refetch()}
      />
    );
  }

  return (
    <div className="collector-flow-root">
      {!online ? <div className="offline-banner">Đang ngoại tuyến — dữ liệu vẫn được lưu an toàn trên máy.</div> : null}
      {content}
    </div>
  );
}

interface CollectorRouteScreenProps {
  stops: RouteStop[];
  route: RouteLoadResult;
  location: GeoPoint | null;
  locationDenied: boolean;
  completed: Record<string, CompletedStop>;
  totalStops: number;
  outboxRows: OutboxRecord[];
  outboxStats: ReturnType<typeof useOutboxStats>;
  shiftStarted: boolean;
  prefetching: boolean;
  onStartShift: () => void;
  onOpenQr: (stop: RouteStop) => void;
  onOpenSummary: () => void;
  onOpenOutbox: () => void;
  onRefresh: () => void;
}

function CollectorRouteScreen({ stops, route, location, locationDenied, completed, totalStops, outboxRows, outboxStats, shiftStarted, prefetching, onStartShift, onOpenQr, onOpenSummary, onOpenOutbox, onRefresh }: CollectorRouteScreenProps) {
  const vehicleCapacity = route.route.total_expected_liters + route.route.remaining_capacity_l;
  const routeFill = vehicleCapacity > 0 ? Math.min(100, Math.round((route.route.total_expected_liters / vehicleCapacity) * 100)) : 0;
  const completedLiters = Object.values(completed).reduce((sum, item) => sum + item.liters, 0);

  return (
    <div className="page-content collector-content">
      <header className="page-header collector-page-header">
        <div><p className="eyebrow">CA HÔM NAY</p><h1>Tuyến thu gom</h1></div>
        <div className="collector-header-actions">
          <OutboxBadge stats={outboxStats} onClick={onOpenOutbox} />
          <button className="round-action" onClick={onRefresh} aria-label="Tải lại tuyến">↻</button>
        </div>
      </header>
      {!location && !locationDenied ? <div className="location-banner">Đang xin quyền vị trí để tính tuyến gần nhất…</div> : null}
      {locationDenied ? <div className="location-banner">Không lấy được vị trí GPS, đang dùng vị trí trung tâm phường. Giao dịch có thể bị đánh dấu cần kiểm tra.</div> : null}
      {route.fromCache ? <div className="offline-cache-banner">Đang dùng dữ liệu lúc {formatTime(route.cachedAt)}</div> : null}
      {!shiftStarted ? <button className="start-shift-button" onClick={onStartShift} disabled={prefetching}>{prefetching ? 'Đang lưu tuyến và mã QR…' : 'Bắt đầu ca — lưu tuyến offline'}</button> : <div className="shift-ready-note">✓ Tuyến và mã QR đã sẵn sàng khi mất sóng</div>}
      <section className="route-capacity-card">
        <div className="route-capacity-top"><span>Tổng lít dự kiến</span><strong>{formatLiters(route.route.total_expected_liters)} / {formatLiters(vehicleCapacity)}</strong></div>
        <div className="route-progress"><span className={routeFill >= 80 ? 'route-progress-high' : ''} style={{ width: `${routeFill}%` }} /></div>
        <div className="route-capacity-bottom"><span>{routeFill}% dung tích xe</span><span>{formatLiters(route.route.remaining_capacity_l)} còn trống</span></div>
      </section>
      <div className="route-summary-line"><strong>{Object.keys(completed).length} / {Math.max(totalStops, Object.keys(completed).length)} điểm đã thu</strong><button className="text-button" onClick={onOpenSummary}>Tóm tắt ca</button></div>
      {stops.length === 0 ? (
        <StatusView title="Đã hoàn thành tuyến" message={completedLiters > 0 ? `Đã thu ${formatLiters(completedLiters)}. Bạn có thể xem lại tóm tắt ca.` : 'Hiện chưa có điểm READY trong phường.'} action={{ label: 'Xem tóm tắt ca', onClick: onOpenSummary }} />
      ) : (
        <section className="collector-stop-list">
          {stops.map((stop) => <CollectorStopCard key={stop.order_id} stop={stop} outboxRow={findRowForStop(outboxRows, stop)} onOpenQr={() => onOpenQr(stop)} />)}
        </section>
      )}
    </div>
  );
}

function OutboxBadge({ stats, onClick }: { stats: ReturnType<typeof useOutboxStats>; onClick: () => void }) {
  const waiting = stats.pending + stats.syncing;
  const label = stats.failed > 0 ? `${stats.failed} giao dịch lỗi` : waiting > 0 ? `Đang chờ đồng bộ (${waiting})` : 'Đã đồng bộ hết';
  return <button className={`outbox-badge ${stats.failed > 0 ? 'outbox-badge-failed' : ''}`} onClick={onClick}>{label}</button>;
}

function CollectorStopCard({ stop, outboxRow, onOpenQr }: { stop: RouteStop; outboxRow: OutboxRecord | undefined; onOpenQr: () => void }) {
  const status = outboxRow?.status;
  return (
    <article className="collector-stop-card">
      <div className={`stop-number ${status ? `stop-number-${status}` : ''}`}>{stop.seq}</div>
      <div className="stop-body">
        <div className="stop-title-row"><h2>{stop.merchant.name}</h2><span className="distance-label">{formatDistance(stop.distance_m)}</span></div>
        <p className="stop-address">{stop.merchant.address ?? 'Chưa có địa chỉ'}</p>
        <strong className="stop-liters">{formatLiters(stop.expected_liters)} dự kiến</strong>
        {status ? <p className={`transaction-status transaction-status-${status}`}>{statusLabel(status)}</p> : null}
        <div className="stop-actions">
          <a className={`call-action ${stop.merchant.phone ? '' : 'disabled-action'}`} href={stop.merchant.phone ? `tel:${stop.merchant.phone}` : undefined}>☎ Gọi quán</a>
          <button className="map-action" onClick={() => zaloClient.openDirections({ lat: stop.merchant.lat, lng: stop.merchant.lng })}>↗ Chỉ đường</button>
          <button className="collect-action" onClick={onOpenQr} disabled={status === 'pending' || status === 'syncing'}>{status === 'synced' ? 'Đã thu' : 'Thu gom'}</button>
        </div>
      </div>
    </article>
  );
}

function CollectorQrScreen({ stop, onBack, onContinue }: { stop: RouteStop; onBack: () => void; onContinue: (container: ContainerLookupResponse, containerCode: string) => void }) {
  const [code, setCode] = useState(stop.container_code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [container, setContainer] = useState<ContainerLookupResponse | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  async function lookup(inputCode: string): Promise<void> {
    setMismatch(false);
    setContainer(null);
    setCachedAt(null);
    await submitContainerCode(
      inputCode,
      lookupContainerWithCache,
      {
        setBusy,
        setError,
        onResolved: (found, normalized) => {
          setCode(normalized);
          if (found.container.qr_code !== stop.container_code) {
            setMismatch(true);
            return;
          }
          setCachedAt(found.cachedAt);
          setContainer(found.container);
        },
      },
      (requestError) => requestError instanceof ApiError && requestError.code === 'NOT_FOUND' ? 'Không tìm thấy can này.' : 'Chưa tra được mã can, thử lại nhé.',
    );
  }

  async function scan(): Promise<void> {
    setBusy(true);
    setError(null);
      try {
        const scannedCode = await zaloClient.scanQRCode();
        if (!scannedCode.trim()) {
          setError('Chưa quét được mã can. Bạn có thể nhập tay mã can bên dưới.');
          return;
        }
        await lookup(scannedCode);
      } catch {
        setError('Không quét được mã. Bạn có thể nhập tay mã can.');
      } finally {
        setBusy(false);
      }
  }

  return (
    <div className="page-content collector-content">
      <button className="back-button" onClick={onBack}>← Quay lại tuyến</button>
      <header className="collector-screen-heading"><p className="eyebrow">ĐIỂM {stop.seq}</p><h1>Quét mã can</h1><p>{stop.merchant.name}</p></header>
      <section className="qr-target-card"><span>Can cần thu</span><strong>{stop.container_code}</strong><small>{stop.merchant.address ?? ''}</small></section>
      <button className="scan-button" onClick={() => { void scan(); }} disabled={busy}>▣ {busy ? 'Đang kiểm tra…' : 'Quét QR bằng camera'}</button>
      <section className="manual-qr-card">
        <p className="section-label">Nhập mã can</p>
        <label htmlFor="manual-qr">Bạn có thể nhập hoặc sửa mã can</label>
        <input id="manual-qr" value={code} onChange={(event) => setCode(event.target.value)} placeholder="ECO-UCO-Q3P7-001" />
        <button className="secondary-button" onClick={() => { void lookup(code); }} disabled={busy}>Kiểm tra mã can</button>
      </section>
      {error ? <div className="error-panel">{error}</div> : null}
      {mismatch ? <div className="warning-panel"><strong>Đây không phải can của điểm này</strong><span>Kiểm tra lại mã QR. Không thể ghi nhận nhầm can.</span></div> : null}
      {container ? (
        <section className="verified-container-card">
          <span className="verified-badge">✓ Đã đối chiếu</span>
          {cachedAt ? <p className="offline-cache-note">Dữ liệu lúc {formatTime(cachedAt)}</p> : null}
          <h2>{container.merchant.name}</h2>
          <p>{container.qr_code} · {formatLiters(container.capacity_liters)} · {container.state === ContainerState.AT_MERCHANT ? 'Đang ở quán' : container.state}</p>
          <button className="primary-button" onClick={() => onContinue(container, code.trim())}>Tiếp tục nhập giao dịch</button>
        </section>
      ) : null}
    </div>
  );
}

function CollectorEntryScreen({ stop, container, containerCode, onBack, onSuccess }: { stop: RouteStop; container: ContainerLookupResponse; containerCode: string; onBack: () => void; onSuccess: (liters: number, clientUuid: string) => void }) {
  const [liters, setLiters] = useState('');
  const [quality, setQuality] = useState<Quality>(Quality.PASS);
  const [photos, setPhotos] = useState<PhotoAsset[]>([]);
  const [geo, setGeo] = useState<GeoPoint | null>(null);
  const [saving, setSaving] = useState(false);
  const [takingPhoto, setTakingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [locationFallback, setLocationFallback] = useState(false);
  const [clientUuid] = useState(() => crypto.randomUUID());
  const capacity = Number(container.capacity_liters ?? 0);
  const actualLiters = Number(liters);
  const maxLiters = capacity * 1.1;
  const invalidLiters = !Number.isFinite(actualLiters) || actualLiters <= 0 || actualLiters > maxLiters;

  function adjustLiters(amount: number): void {
    const next = Math.max(0, (Number(liters) || 0) + amount);
    setLiters(next.toFixed(1));
  }

  async function takePhoto(): Promise<void> {
    setTakingPhoto(true);
    setError(null);
    try {
      const photo = await zaloClient.chooseImage();
      setPhotos((current) => [...current, photo]);
    } catch {
      setError('Chưa chụp được ảnh, thử lại nhé.');
    } finally {
      setTakingPhoto(false);
    }
  }

  async function submit(): Promise<void> {
    if (invalidLiters) {
      setError(`Số lít phải lớn hơn 0 và không vượt ${maxLiters.toFixed(1)} lít.`);
      return;
    }
    if (quality === Quality.FLAG && photos.length === 0) {
      setError('Chất lượng cần kiểm tra bắt buộc có ít nhất 1 ảnh.');
      return;
    }
    if (saving || success) {
      return;
    }
    setSaving(true);
    setError(null);
    let currentGeo = geo;
    if (!currentGeo) {
      try {
        currentGeo = await zaloClient.getLocation(stop.ward_center ?? null);
      } catch {
        currentGeo = stop.ward_center ?? null;
      }
      if (!currentGeo) {
        setError('Không xác định được vị trí hiện tại hoặc tâm phường. Vui lòng bật GPS rồi thử lại.');
        setSaving(false);
        return;
      }
      if (stop.ward_center && currentGeo.lat === stop.ward_center.lat && currentGeo.lng === stop.ward_center.lng) {
        setLocationFallback(true);
      }
      setGeo(currentGeo);
    }
    const payload: CollectionCreateRequest = {
      client_uuid: clientUuid,
      order_id: stop.order_id,
       container_code: containerCode,
      actual_liters: actualLiters,
      quality,
      geo: currentGeo,
      photos: photos.map((photo) => photo.url),
      collected_at: new Date().toISOString(),
    };
    try {
      await enqueueCollection(payload);
      setSuccess(true);
      void syncOutbox();
      window.setTimeout(() => onSuccess(actualLiters, clientUuid), 450);
    } catch {
      setError('Chưa lưu được dữ liệu trên máy. Đừng đóng màn hình, thử lại nhé.');
    } finally {
      setSaving(false);
    }
  }

  if (success) {
    return <div className="success-screen"><div className="success-icon">✓</div><h1>Đã lưu an toàn</h1><p>{formatLiters(actualLiters)} · Giao dịch sẽ tự đồng bộ khi có mạng.</p></div>;
  }

  return (
    <div className="page-content collector-content">
      <button className="back-button" onClick={onBack} disabled={saving}>← Quay lại quét mã</button>
       <header className="collector-screen-heading"><p className="eyebrow">GHI NHẬN THU GOM</p><h1>{container.merchant.name}</h1><p>{containerCode}</p></header>
      <section className="entry-target-card"><span>Số lít dự kiến</span><strong>{formatLiters(stop.expected_liters)}</strong><small>Mã giao dịch: {clientUuid.slice(0, 8)}…</small>{locationFallback ? <p className="location-banner">Không lấy được vị trí GPS, đang dùng vị trí trung tâm phường. Giao dịch có thể bị đánh dấu cần kiểm tra.</p> : null}</section>
      <section className="liter-entry-card">
        <label htmlFor="actual-liters">Số lít thực tế</label>
        <div className="large-number-input"><button onClick={() => adjustLiters(-0.5)} disabled={saving}>−</button><input id="actual-liters" type="number" inputMode="decimal" step="0.5" min="0" value={liters} onChange={(event) => setLiters(event.target.value)} placeholder="0.0" /><span>lít</span><button onClick={() => adjustLiters(0.5)} disabled={saving}>+</button></div>
        <p className={invalidLiters && liters ? 'error-text' : 'field-help'}>Dung tích {formatLiters(capacity)} · tối đa {maxLiters.toFixed(1)} lít</p>
      </section>
      <section className="quality-card"><p className="section-label">Chất lượng dầu</p><div className="quality-options"><button className={quality === Quality.PASS ? 'quality-option selected' : 'quality-option'} onClick={() => setQuality(Quality.PASS)} disabled={saving}>✓ Đạt</button><button className={quality === Quality.FLAG ? 'quality-option selected flag-selected' : 'quality-option'} onClick={() => setQuality(Quality.FLAG)} disabled={saving}>⚠ Cần kiểm tra</button></div></section>
      {quality === Quality.FLAG ? <section className="photo-card"><div><strong>Ảnh kiểm tra</strong><p>{photos.length > 0 ? `${photos.length} ảnh đã chụp` : 'Cần ít nhất 1 ảnh'}</p></div><button className="secondary-button" onClick={() => { void takePhoto(); }} disabled={takingPhoto || saving}>{takingPhoto ? 'Đang chụp…' : 'Chụp ảnh'}</button></section> : null}
      {error ? <div className="error-panel">{error}</div> : null}
      <button className="submit-collection-button" onClick={() => { void submit(); }} disabled={saving || invalidLiters || (quality === Quality.FLAG && photos.length === 0)}>{saving ? 'Đang lưu trên máy…' : 'Xác nhận thu gom'}</button>
    </div>
  );
}

function CollectorSummaryScreen({ route, completed, totalStops, onBack, onOpenDelivery }: { route: CurrentRouteResponse | undefined; completed: Record<string, CompletedStop>; totalStops: number; onBack: () => void; onOpenDelivery: () => void }) {
  const totalCollected = Object.values(completed).reduce((sum, item) => sum + item.liters, 0);
  const completedCount = Object.keys(completed).length;
  const displayedTotalStops = Math.max(totalStops, completedCount);
  const vehicleCapacity = route ? route.total_expected_liters + route.remaining_capacity_l : 0;
  return (
    <div className="page-content collector-content summary-page">
      <button className="back-button" onClick={onBack}>← Về tuyến hôm nay</button>
      <header className="collector-screen-heading"><p className="eyebrow">KẾT QUẢ CA</p><h1>Tóm tắt thu gom</h1></header>
      <div className="summary-hero"><span>Đã thu hôm nay</span><strong>{formatLiters(totalCollected)}</strong></div>
      <section className="summary-grid"><div><span>Điểm đã thu</span><strong>{completedCount} / {displayedTotalStops}</strong></div><div><span>Dung tích còn lại</span><strong>{formatLiters(Math.max(vehicleCapacity - totalCollected, 0))}</strong></div></section>
      <button className="station-button" onClick={onOpenDelivery} disabled={completedCount === 0}>Đi nộp trạm <small>{completedCount === 0 ? 'Chưa có giao dịch' : 'Đối soát và chọn trạm'}</small></button>
    </div>
  );
}

function OutboxQueueScreen({ onBack }: { onBack: () => void }) {
  const rows = useOutboxRows();
  const stats = useOutboxStats();
  const [retrying, setRetrying] = useState<string | null>(null);

  async function retry(clientUuid: string): Promise<void> {
    setRetrying(clientUuid);
    try {
      await retryOutbox(clientUuid);
      await syncOutbox();
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className="page-content collector-content outbox-page">
      <button className="back-button" onClick={onBack}>← Về tuyến hôm nay</button>
      <header className="collector-screen-heading"><p className="eyebrow">AN TOÀN DỮ LIỆU</p><h1>Hàng chờ đồng bộ</h1><p>{formatBytes(stats.bytes)} đang lưu trên máy</p></header>
      {stats.over_limit ? <div className="warning-panel"><strong>Hàng chờ đang vượt 50MB</strong><span>Hãy bật mạng để đồng bộ bớt dữ liệu ảnh.</span></div> : null}
      {rows.length === 0 ? <StatusView title="Hàng chờ đang trống" message="Mọi giao dịch đã được đồng bộ hoặc chưa phát sinh." /> : <section className="outbox-list">{rows.map((row) => <OutboxRow key={row.client_uuid} row={row} retrying={retrying === row.client_uuid} onRetry={() => { void retry(row.client_uuid); }} />)}</section>}
    </div>
  );
}

function OutboxRow({ row, retrying, onRetry }: { row: OutboxRecord; retrying: boolean; onRetry: () => void }) {
  const payload = row.payload as Partial<CollectionCreateRequest>;
  return (
    <article className="outbox-row">
      <div className="outbox-row-top"><span className={`outbox-dot outbox-dot-${row.status}`} /><strong>{formatLiters(payload.actual_liters)} · {statusLabel(row.status)}</strong></div>
      <p>UUID: {row.client_uuid}</p>
      <p>Tạo lúc {formatTime(row.created_at)} · Lần thử {row.attempts}</p>
      {row.last_error ? <div className="outbox-error">{row.last_error}</div> : null}
      {row.status === 'failed' ? <button className="secondary-button" onClick={onRetry} disabled={retrying}>{retrying ? 'Đang thử lại…' : 'Thử lại thủ công'}</button> : null}
    </article>
  );
}

function findRowForStop(rows: OutboxRecord[], stop: RouteStop): OutboxRecord | undefined {
  return rows.find((row) => row.type === 'collection' && (row.payload as Partial<CollectionCreateRequest>).order_id === stop.order_id);
}

function statusLabel(status: OutboxRecord['status']): string {
  switch (status) {
    case 'pending': return 'Đang chờ đồng bộ';
    case 'syncing': return 'Đang đồng bộ';
    case 'synced': return 'Đã đồng bộ';
    case 'failed': return 'Giao dịch lỗi';
  }
}

function formatDistance(distanceM: number): string {
  return distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(1)} km`;
}

function formatTime(value: string | null): string {
  if (!value) return '--:--';
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
