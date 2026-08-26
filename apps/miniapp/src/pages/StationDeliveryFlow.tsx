import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { DEFAULT_DENSITY_KG_PER_LITER, DeliveryStatus } from '@eco-oil/shared-types';
import type { CollectionCreateRequest, GeoPoint, StationDeliveryCreateRequest, StationDeliveryResponse, StationRecommendation } from '@eco-oil/shared-types';
import { api } from '../lib/api';
import { formatCurrency, formatLiters } from '../lib/formatters';
import { enqueueStationDelivery, retryOutbox, type OutboxRecord } from '../lib/outbox-db';
import { syncOutbox } from '../lib/outbox-sync';
import { useOutboxRows } from '../lib/outbox-hooks';
import { zaloClient } from '../lib/zalo-client';
import type { PhotoAsset } from '../lib/zalo-client';
import { compressImageBlob } from '../lib/zalo-client';
import { pickZaloPhoto } from '../lib/media-picker';
import { StatusView } from '../components/StatusView';
import type { CompletedStop } from './CollectorFlow';
import { canSubmitStationDelivery, loadStationRecommendations, resolveStationSearchLocation, retryStationDeliverySync } from '../lib/station-delivery';

type DeliveryScreen = 'select' | 'review' | 'receipt' | 'closeout';

interface DeliveryCandidate extends CompletedStop {
  record: OutboxRecord;
  collection: CollectionCreateRequest;
}

interface StationDeliveryFlowProps {
  completed: Record<string, CompletedStop>;
  onBack: () => void;
  onDeliverySynced: () => void;
  onFinish: () => void;
}

const VARIANCE_THRESHOLD = 0.02;
const PRICE_PER_LITER = Number(import.meta.env.VITE_ESTIMATED_PRICE_PER_LITER ?? 8000);

export function StationDeliveryFlow({ completed, onBack, onDeliverySynced, onFinish }: StationDeliveryFlowProps) {
  const [screen, setScreen] = useState<DeliveryScreen>('select');
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [locationDenied, setLocationDenied] = useState(false);
  const [locating, setLocating] = useState(true);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<StationRecommendation[]>([]);
  const [recommendationStatus, setRecommendationStatus] = useState<'idle' | 'success' | 'empty' | 'error'>('idle');
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [loadingRecommendations, setLoadingRecommendations] = useState(false);
  const [selectedStation, setSelectedStation] = useState<StationRecommendation | null>(null);
  const [deliveryClientUuid, setDeliveryClientUuid] = useState<string | null>(null);
  const [retryingWaiting, setRetryingWaiting] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const rows = useOutboxRows();
  const entries = useMemo(() => Object.values(completed), [completed]);
  const candidates = useMemo(() => getCandidates(entries, rows), [entries, rows]);
  const expectedLiters = entries.reduce((sum, item) => sum + item.liters, 0);
  const expectedKg = entries.reduce((sum, item) => sum + (item.kilograms ?? item.liters * DEFAULT_DENSITY_KG_PER_LITER), 0);
  const waiting = entries.length - candidates.length;
  const fallbackLocation = useMemo(() => entries.find((entry) => entry.stop.ward_center)?.stop.ward_center ?? null, [entries]);

  const resolveLocation = useCallback(async (): Promise<void> => {
    setLocating(true);
    setLocationError(null);
    setRecommendationError(null);
    setRecommendationStatus('idle');
    try {
      const result = await resolveStationSearchLocation(
        () => zaloClient.getLocation(fallbackLocation),
        fallbackLocation,
      );
      if (result.location) {
        setLocation(result.location);
        setLocationDenied(result.usedFallback);
      } else {
        setLocation(null);
        setLocationDenied(true);
        setLocationError(result.error);
        setRecommendationStatus('error');
      }
    } finally {
      setLocating(false);
    }
  }, [fallbackLocation]);

  useEffect(() => { void resolveLocation(); }, [resolveLocation]);

  const findStations = useCallback(async (): Promise<void> => {
    if (!location) {
      setRecommendationStatus('error');
      setRecommendationError('Chưa xác định được vị trí để tìm trạm phù hợp.');
      return;
    }
    setRecommendationError(null);
    const result = await loadStationRecommendations(
      () => api.recommendStations(location, expectedLiters),
      setLoadingRecommendations,
    );
    setRecommendations(result.stations);
    setRecommendationStatus(result.status);
    setRecommendationError(result.error);
  }, [expectedLiters, location]);

  useEffect(() => {
    if (screen === 'select' && waiting === 0 && expectedLiters > 0 && location) {
      void findStations();
    }
  }, [expectedLiters, findStations, location, screen, waiting]);

  async function retryWaiting(): Promise<void> {
    await retryStationDeliverySync(async () => {
      const waitingRows = entries
        .map((entry) => rows.find((row) => row.client_uuid === entry.clientUuid))
        .filter((row): row is OutboxRecord => Boolean(row && row.status !== 'synced'));
      await Promise.all(waitingRows.filter((row) => row.status === 'failed').map((row) => retryOutbox(row.client_uuid)));
      return syncOutbox();
    }, setRetryingWaiting, setRetryError);
  }

  if (entries.length === 0) {
    return <StatusView title="Chưa có giao dịch để nộp" message="Hãy thu gom ít nhất một điểm rồi quay lại đây." action={{ label: 'Về tuyến hôm nay', onClick: onBack }} />;
  }

  if (screen === 'select') {
    const loading = waiting === 0 && (locating || loadingRecommendations);
    const error = locationError ?? recommendationError;
    return <StationSelectScreen expectedLiters={expectedLiters} expectedKg={expectedKg} waiting={waiting} locationDenied={locationDenied} recommendations={recommendations} loading={loading} status={recommendationStatus} error={error} retryingWaiting={retryingWaiting} retryError={retryError} onBack={onBack} onRetryWaiting={() => { void retryWaiting(); }} onChoose={(station) => { setSelectedStation(station); setScreen('review'); }} onRetry={() => { void resolveLocation(); }} />;
  }

  if (screen === 'review' && selectedStation) {
    return <StationDeliveryReview station={selectedStation} candidates={candidates} expectedLiters={expectedLiters} expectedKg={expectedKg} onBack={() => setScreen('select')} onSubmitted={(clientUuid) => { setDeliveryClientUuid(clientUuid); setScreen('receipt'); }} />;
  }

  if (screen === 'receipt' && selectedStation && deliveryClientUuid) {
    return <StationDeliveryReceipt station={selectedStation} clientUuid={deliveryClientUuid} expectedLiters={expectedLiters} rows={rows} onDeliverySynced={onDeliverySynced} onCloseOut={() => setScreen('closeout')} onBack={onBack} />;
  }

  return <ShiftCloseout candidates={candidates} onFinish={onFinish} />;
}

function StationSelectScreen({ expectedLiters, expectedKg, waiting, locationDenied, recommendations, loading, status, error, retryingWaiting, retryError, onBack, onRetryWaiting, onChoose, onRetry }: {
  expectedLiters: number;
  expectedKg: number;
  waiting: number;
  locationDenied: boolean;
  recommendations: StationRecommendation[];
  loading: boolean;
  status: 'idle' | 'success' | 'empty' | 'error';
  error: string | null;
  retryingWaiting: boolean;
  retryError: string | null;
  onBack: () => void;
  onRetryWaiting: () => void;
  onChoose: (station: StationRecommendation) => void;
  onRetry: () => void;
}) {
  return (
    <div className="page-content collector-content station-page">
      <button className="back-button" onClick={onBack}>← Về tóm tắt ca</button>
      <header className="collector-screen-heading"><p className="eyebrow">NỘP TRẠM</p><h1>Chọn trạm tiếp nhận</h1><p>Đang mang {formatLiters(expectedLiters)} lít (~{expectedKg.toFixed(1)} kg) cần đối soát</p></header>
      {locationDenied ? <div className="location-banner">Không lấy được vị trí GPS, đang dùng vị trí trung tâm phường. Giao dịch có thể bị đánh dấu cần kiểm tra.</div> : null}
      {waiting > 0 ? <div className="warning-panel delivery-waiting-panel"><strong>Còn {waiting} giao dịch chưa đồng bộ, đang gửi…</strong><span>Phải đồng bộ xong để server biết chính xác các giao dịch trước khi nộp trạm.</span>{retryError ? <span className="error-text">{retryError}</span> : null}<button className="secondary-button" onClick={onRetryWaiting} disabled={retryingWaiting}>{retryingWaiting ? 'Đang thử lại…' : 'Thử lại đồng bộ'}</button></div> : null}
      {loading ? <StatusView title="Đang tìm trạm còn chỗ…" /> : null}
      {!loading && status === 'error' ? <StatusView title="Chưa tìm được trạm" message={error ?? 'Kiểm tra kết nối rồi thử lại.'} action={{ label: 'Thử lại', onClick: onRetry }} /> : null}
      {!loading && status === 'empty' ? <StatusView title="Hiện chưa có trạm phù hợp để tiếp nhận" message="Thử lại sau hoặc liên hệ điều phối để được hướng dẫn." action={{ label: 'Thử lại', onClick: onRetry }} /> : null}
      {!loading && waiting === 0 && status === 'success' ? <section className="station-list">{recommendations.map((station) => <StationCard key={station.id} station={station} liters={expectedLiters} onChoose={() => onChoose(station)} />)}</section> : null}
    </div>
  );
}

function StationCard({ station, liters, onChoose }: { station: StationRecommendation; liters: number; onChoose: () => void }) {
  const afterDelivery = station.current_volume_l + liters;
  const fill = station.capacity_l > 0 ? Math.min(100, Math.round((afterDelivery / station.capacity_l) * 100)) : 100;
  const enough = station.remaining_capacity_l >= liters;
  return <article className={`station-card ${enough ? '' : 'station-card-unavailable'}`}><div className="station-card-top"><div><h2>{station.name}</h2><p>{station.address ?? 'Chưa có địa chỉ'}</p></div><strong>{formatDistance(station.distance_m)}</strong></div><div className="station-capacity-label"><span>Còn lại sau khi nộp</span><b>{formatLiters(Math.max(station.remaining_capacity_l - liters, 0))}</b></div><div className="progress-track station-progress"><span style={{ width: `${fill}%` }} /></div>{!enough ? <p className="station-unavailable-label">Không đủ sức chứa</p> : null}<div className="station-card-actions"><button className="map-action" onClick={() => zaloClient.openDirections({ lat: station.lat, lng: station.lng })}>↗ Chỉ đường</button><button className="primary-button" onClick={onChoose} disabled={!enough}>Chọn trạm này</button></div></article>;
}

function StationDeliveryReview({ station, candidates, expectedLiters, expectedKg, onBack, onSubmitted }: { station: StationRecommendation; candidates: DeliveryCandidate[]; expectedLiters: number; expectedKg: number; onBack: () => void; onSubmitted: (clientUuid: string) => void }) {
  const [actual, setActual] = useState(expectedLiters.toFixed(1));
  const [actualKgInput, setActualKgInput] = useState(expectedKg.toFixed(1));
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<PhotoAsset[]>([]);
  const [saving, setSaving] = useState(false);
  const [takingPhoto, setTakingPhoto] = useState(false);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientUuid] = useState(() => crypto.randomUUID());
  const mountedRef = useRef(true);
  const mediaPickerInFlightRef = useRef(false);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const actualLiters = Number(actual);
  const actualKg = Number(actualKgInput);
  const varianceKg = actualKg - expectedKg;
  const varianceKgPct = expectedKg > 0 ? varianceKg / expectedKg : 0;
  const flagged = Math.abs(varianceKgPct) > VARIANCE_THRESHOLD;
  const invalid = !Number.isFinite(actualLiters) || actualLiters <= 0 || !Number.isFinite(actualKg) || actualKg <= 0;

  async function takePhoto(): Promise<void> {
    if (mediaPickerInFlightRef.current) return;
    mediaPickerInFlightRef.current = true;
    setTakingPhoto(true);
    setPhotoNotice(null);
    try {
      const result = await pickZaloPhoto('camera');
      if (!mountedRef.current) return;
      if (result.kind === 'selected') setPhotos((current) => [...current, result.photo]);
      else if (result.kind === 'cancelled') setPhotoNotice('Bạn chưa chọn ảnh. Bạn có thể thử lại hoặc chọn ảnh từ thư viện/file dự phòng.');
      else if (result.kind === 'permission-denied') setError('Zalo chưa có quyền Camera. Hãy bật quyền hoặc chọn ảnh từ thư viện/file dự phòng.');
      else setError('Chưa chụp được ảnh. Hãy chọn ảnh từ thư viện hoặc file dự phòng.');
    } finally {
      mediaPickerInFlightRef.current = false;
      if (mountedRef.current) setTakingPhoto(false);
    }
  }

  async function chooseAlbumPhoto(): Promise<void> {
    if (mediaPickerInFlightRef.current) return;
    mediaPickerInFlightRef.current = true;
    setTakingPhoto(true);
    setError(null);
    setPhotoNotice(null);
    try {
      const result = await pickZaloPhoto('album');
      if (!mountedRef.current) return;
      if (result.kind === 'selected') setPhotos((current) => [...current, result.photo]);
      else if (result.kind === 'cancelled') setPhotoNotice('Bạn chưa chọn ảnh. Bạn có thể thử lại hoặc chọn ảnh từ camera/file dự phòng.');
      else if (result.kind === 'permission-denied') setError('Zalo chưa được phép chọn ảnh. Hãy kiểm tra quyền hoặc dùng file dự phòng.');
      else setError('Không chọn được ảnh từ thư viện Zalo. Hãy dùng file dự phòng.');
    } finally {
      mediaPickerInFlightRef.current = false;
      if (mountedRef.current) setTakingPhoto(false);
    }
  }

  async function choosePhotoFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (mediaPickerInFlightRef.current) return;
    mediaPickerInFlightRef.current = true;
    setTakingPhoto(true);
    setError(null);
    setPhotoNotice(null);
    try {
      const photo = await compressImageBlob(file);
      if (!photo.url.trim()) {
        throw new Error('Ảnh không hợp lệ');
      }
      if (mountedRef.current) setPhotos((current) => [...current, photo]);
    } catch {
      if (mountedRef.current) setError('Không đọc được ảnh. Hãy chọn một ảnh khác.');
    } finally {
      mediaPickerInFlightRef.current = false;
      if (mountedRef.current) setTakingPhoto(false);
    }
  }

  async function submit(): Promise<void> {
    if (invalid) return setError('Số lít thực tế phải lớn hơn 0.');
    if (flagged && !note.trim()) return setError('Chênh lệch vượt 2%, hãy nhập lý do trước khi xác nhận.');
    if (flagged && photos.length === 0) return setError('Chênh lệch vượt 2%, hãy chụp ít nhất 1 ảnh làm bằng chứng.');
    if (saving) return;
    setSaving(true);
    setError(null);
    const payload: StationDeliveryCreateRequest = {
      client_uuid: clientUuid,
      station_id: station.id,
      transaction_ids: candidates.map((item) => item.record.server_id as string),
      actual_liters: actualLiters,
      actual_kg: actualKg,
      delivered_at: new Date().toISOString(),
      note: note.trim() || undefined,
      photos: photos.map((photo) => photo.url),
    };
    try {
      await enqueueStationDelivery(payload);
      void syncOutbox();
      onSubmitted(clientUuid);
    } catch {
      setError('Chưa lưu được phiếu trên máy. Đừng đóng màn hình, thử lại nhé.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-content collector-content station-page">
      <button className="back-button" onClick={onBack} disabled={saving}>← Chọn lại trạm</button>
      <header className="collector-screen-heading"><p className="eyebrow">ĐỐI SOÁT TRƯỚC KHI NỘP</p><h1>{station.name}</h1><p>{station.address ?? ''}</p></header>
      <section className="delivery-transactions-card"><h2>Từng giao dịch sẽ nộp</h2>{candidates.map((item) => <div className="delivery-transaction-row" key={item.clientUuid}><div><strong>{item.stop.merchant.name}</strong><span>{formatTime(item.collection.collected_at ?? item.record.created_at)}</span></div><b>{formatLiters(collectionLiters(item.collection))} lít · {collectionKilograms(item.collection).toFixed(1)} kg</b></div>)}<div className="delivery-total-row"><span>Tổng server sẽ tự tính</span><strong>{formatLiters(expectedLiters)} lít (~{expectedKg.toFixed(1)} kg)</strong></div></section>
      <section className="delivery-input-card"><label htmlFor="delivery-kg">Khối lượng thực tế đổ vào trạm (ưu tiên số cân)</label><div className="delivery-liters-input"><input id="delivery-kg" type="number" inputMode="decimal" step="0.1" min="0" value={actualKgInput} onChange={(event) => setActualKgInput(event.target.value)} /><span>kg</span></div><p className={flagged ? 'variance-danger' : 'variance-ok'}>{varianceKg >= 0 ? '+' : ''}{varianceKg.toFixed(2)} kg ({(varianceKgPct * 100).toFixed(1)}%)</p><label htmlFor="delivery-liters">Số lít thực tế (để đối chiếu song song)</label><div className="delivery-liters-input"><input id="delivery-liters" type="number" inputMode="decimal" step="0.1" min="0" value={actual} onChange={(event) => setActual(event.target.value)} /><span>lít</span></div><p className="variance-help">Ngưỡng đối soát 2% được tính trên kg.</p>{flagged ? <div className="warning-panel"><strong>Chênh lệch vượt 2%, giao dịch sẽ được gắn cờ kiểm tra</strong><span>Vui lòng nhập lý do và chụp ảnh trước khi gửi.</span></div> : null}</section>
      {flagged ? <><section className="delivery-note-card"><label htmlFor="delivery-note">Lý do chênh lệch bắt buộc</label><textarea id="delivery-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Ví dụ: dầu còn bám trong can…" /></section><section className="photo-card"><div><strong>Ảnh bằng chứng</strong><p>{photos.length > 0 ? `${photos.length} ảnh thật đã chọn` : 'Cần ít nhất 1 ảnh thật để gửi'}</p></div>{photoNotice ? <p role="status">{photoNotice}</p> : null}<div className="flex flex-wrap gap-2"><button className="secondary-button" onClick={() => { void takePhoto(); }} disabled={takingPhoto || saving}>{takingPhoto ? 'Đang xử lý…' : 'Chụp ảnh'}</button><button className="secondary-button" onClick={() => { void chooseAlbumPhoto(); }} disabled={takingPhoto || saving}>Chọn từ thư viện Zalo</button><label className="secondary-button cursor-pointer">Tải file dự phòng<input className="sr-only" type="file" accept="image/*" onChange={(event) => { void choosePhotoFile(event); }} disabled={takingPhoto || saving} /></label></div></section></> : null}
      {error ? <div className="error-panel">{error}</div> : null}<p className="server-calculation-note">Expected liters không gửi từ app. Server sẽ tính lại từ các giao dịch đã đồng bộ.</p><button className="submit-collection-button" onClick={() => { void submit(); }} disabled={saving || !canSubmitStationDelivery({ invalid, flagged, note, photoCount: photos.length })}>{saving ? 'Đang lưu phiếu trên máy…' : 'Xác nhận nộp trạm'}</button>
    </div>
  );
}

function StationDeliveryReceipt({ station, clientUuid, expectedLiters, rows, onDeliverySynced, onCloseOut, onBack }: { station: StationRecommendation; clientUuid: string; expectedLiters: number; rows: OutboxRecord[]; onDeliverySynced: () => void; onCloseOut: () => void; onBack: () => void }) {
  const row = rows.find((item) => item.client_uuid === clientUuid);
  const response = row?.server_response as StationDeliveryResponse | undefined;
  const actual = response?.actual_liters ?? Number((row?.payload as StationDeliveryCreateRequest | undefined)?.actual_liters ?? 0);
  const flagged = response?.status === DeliveryStatus.FLAGGED;
  const syncNotified = useRef(false);
  useEffect(() => {
    if (row?.status === 'synced' && !syncNotified.current) {
      syncNotified.current = true;
      onDeliverySynced();
    }
  }, [onDeliverySynced, row?.status]);
  return <div className="page-content collector-content station-page receipt-page"><header className="collector-screen-heading"><p className="eyebrow">BIÊN NHẬN NỘP TRẠM</p><h1>{flagged ? 'Đã ghi nhận có chênh lệch' : 'Đã lưu phiếu nộp trạm'}</h1><p>{station.name}</p></header><section className="receipt-card"><div className={`receipt-status receipt-status-${response?.status ?? row?.status ?? 'pending'}`}>{flagged ? '⚠ FLAGGED — cần kiểm tra' : row?.status === 'synced' ? '✓ OK — server đã đối soát' : 'Đang chờ đồng bộ server'}</div><dl><div><dt>Mã phiếu</dt><dd>{response?.id ?? clientUuid}</dd></div><div><dt>Trạm</dt><dd>{station.name}</dd></div><div><dt>Tổng server đối soát</dt><dd>{formatLiters(response?.expected_liters ?? expectedLiters)}</dd></div><div><dt>Thực tế đổ</dt><dd>{formatLiters(actual)}</dd></div><div><dt>Chênh lệch</dt><dd>{response ? `${response.variance_l >= 0 ? '+' : ''}${response.variance_l.toFixed(1)} L (${(response.variance_pct * 100).toFixed(1)}%)` : 'Chờ server tính'}</dd></div><div><dt>Giờ ghi nhận</dt><dd>{formatTime(response?.created_at ?? row?.created_at ?? null)}</dd></div></dl></section>{row?.status === 'failed' ? <div className="error-panel">{deliveryErrorMessage(row.last_error ?? '')}</div> : null}<div className="receipt-actions"><button className="secondary-button" onClick={() => window.print()}>Lưu ảnh biên nhận</button><button className="primary-button" onClick={onCloseOut} disabled={row?.status !== 'synced'}>{row?.status === 'synced' ? 'Kết ca' : 'Đang chờ giao trạm thành công…'}</button></div><button className="back-button" onClick={onBack}>← Về tóm tắt ca</button></div>;
}

function ShiftCloseout({ candidates, onFinish }: { candidates: DeliveryCandidate[]; onFinish: () => void }) {
  const total = candidates.reduce((sum, item) => sum + collectionLiters(item.collection), 0);
  return <div className="page-content collector-content summary-page"><header className="collector-screen-heading"><p className="eyebrow">KẾT CA</p><h1>Ca làm đã khép lại</h1></header><div className="summary-hero"><span>Tổng lít đã thu</span><strong>{formatLiters(total)}</strong></div><section className="summary-grid"><div><span>Số điểm đã thu</span><strong>{candidates.length}</strong></div><div><span>Số phiếu nộp trạm</span><strong>1</strong></div></section><section className="closeout-money"><span>Tổng tiền ước tính</span><strong>{formatCurrency(total * PRICE_PER_LITER)}</strong><small>Đơn giá thử nghiệm: {formatCurrency(PRICE_PER_LITER)} / lít</small></section><button className="primary-button closeout-button" onClick={onFinish}>Kết thúc ca</button></div>;
}

function getCandidates(entries: CompletedStop[], rows: OutboxRecord[]): DeliveryCandidate[] {
  return entries.map((entry) => {
    const record = rows.find((row) => row.client_uuid === entry.clientUuid);
    if (!record || record.status !== 'synced' || !record.server_id || record.type !== 'collection') return null;
    return { ...entry, record, collection: record.payload as CollectionCreateRequest };
  }).filter((item): item is DeliveryCandidate => item !== null);
}

function collectionLiters(collection: CollectionCreateRequest): number {
  return collection.actual_liters ?? (collection.actual_kg ?? 0) / DEFAULT_DENSITY_KG_PER_LITER;
}

function collectionKilograms(collection: CollectionCreateRequest): number {
  return collection.actual_kg ?? collectionLiters(collection) * DEFAULT_DENSITY_KG_PER_LITER;
}

function deliveryErrorMessage(error: unknown): string {
  const value = typeof error === 'string' ? error : error instanceof Error ? error.message : 'Chưa xử lý được phiếu nộp trạm.';
  if (value.includes('STATION_OVER_CAPACITY')) return 'Trạm vừa hết chỗ, hãy chọn trạm khác.';
  if (value.includes('TRANSACTION_ALREADY_DELIVERED')) return 'Một giao dịch đã được nộp trong phiếu khác.';
  return value;
}

function formatDistance(distanceM: number): string {
  return distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(1)} km`;
}

function formatTime(value: string | null): string {
  if (!value) return '--:--';
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
