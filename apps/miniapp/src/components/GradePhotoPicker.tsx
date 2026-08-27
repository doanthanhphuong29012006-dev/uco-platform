import { OilGrade } from '@eco-oil/shared-types';
import type { PhotoAsset } from '../lib/zalo-client';

export function isGradePhotoMissing(grade: OilGrade | null, suspectedAdulteration: boolean, photoCount: number): boolean {
  const required = grade === OilGrade.B || grade === OilGrade.C || suspectedAdulteration;
  return required && photoCount === 0;
}

interface GradePhotoPickerProps {
  photos: PhotoAsset[];
  busy: boolean;
  disabled: boolean;
  message?: string | null;
  onTakePhoto: () => void;
  onChooseAlbum?: () => void;
  onChooseFile: (file: File) => void;
  onRemovePhoto: (index: number) => void;
}

export function GradePhotoPicker({ photos, busy, disabled, message, onTakePhoto, onChooseAlbum, onChooseFile, onRemovePhoto }: GradePhotoPickerProps) {
  return (
    <section className="photo-card grade-photo-card">
      <div>
        <strong>Ảnh phân hạng / kiểm tra</strong>
        <p>{photos.length > 0 ? `${photos.length} ảnh đã chọn` : 'Hạng B, hạng C hoặc nghi ngờ pha lẫn cần ít nhất 1 ảnh thật.'}</p>
      </div>
      {message ? <p role="status">{message}</p> : null}
      <div className="photo-actions">
        <button type="button" className="secondary-button" onClick={onTakePhoto} disabled={busy || disabled}>
          {busy ? 'Đang xử lý…' : photos.length > 0 ? 'Chụp lại ảnh' : 'Chụp ảnh'}
        </button>
        {onChooseAlbum ? (
          <button type="button" className="secondary-button" onClick={onChooseAlbum} disabled={busy || disabled}>
            Chọn từ thư viện Zalo
          </button>
        ) : null}
        <label className="secondary-button file-picker-button">
          Tải file dự phòng
          <input
            className="sr-only"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onChooseFile(file);
            }}
            disabled={busy || disabled}
          />
        </label>
      </div>
      {photos.length > 0 ? (
        <div className="photo-preview-list">
          {photos.map((photo, index) => (
            <figure className="photo-preview" key={`${photo.url}-${index}`}>
              <img src={photo.url} alt={`Ảnh phân hạng ${index + 1}`} />
              <button type="button" className="photo-remove-button" onClick={() => onRemovePhoto(index)} disabled={busy || disabled}>Xoá ảnh</button>
            </figure>
          ))}
        </div>
      ) : null}
    </section>
  );
}
