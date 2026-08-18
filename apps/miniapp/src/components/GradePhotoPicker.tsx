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
  onTakePhoto: () => void;
  onChooseFile: (file: File) => void;
  onRemovePhoto: (index: number) => void;
}

export function GradePhotoPicker({ photos, busy, disabled, onTakePhoto, onChooseFile, onRemovePhoto }: GradePhotoPickerProps) {
  return (
    <section className="photo-card grade-photo-card">
      <div>
        <strong>Ảnh phân hạng / kiểm tra</strong>
        <p>{photos.length > 0 ? `${photos.length} ảnh đã chọn` : 'Hạng B, hạng C hoặc nghi ngờ pha lẫn cần ít nhất 1 ảnh thật.'}</p>
      </div>
      <div className="photo-actions">
        <button type="button" className="secondary-button" onClick={onTakePhoto} disabled={busy || disabled}>
          {busy ? 'Đang xử lý…' : 'Chụp ảnh'}
        </button>
        <label className="secondary-button file-picker-button">
          Chọn ảnh có sẵn
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
