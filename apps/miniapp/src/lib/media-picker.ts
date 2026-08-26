import type { ImageSource, PhotoAsset } from './zalo-client';
import { isMediaPickerCancelled, isZaloPermissionDenied, zaloClient } from './zalo-client';

export type MediaPickerResult =
  | { kind: 'selected'; photo: PhotoAsset }
  | { kind: 'cancelled' }
  | { kind: 'permission-denied' }
  | { kind: 'error'; error: unknown };

export async function pickZaloPhoto(
  source: ImageSource,
  pick: (source: ImageSource) => Promise<PhotoAsset> = (requestedSource) => zaloClient.chooseImage(requestedSource),
): Promise<MediaPickerResult> {
  try {
    const photo = await pick(source);
    return photo.url.trim()
      ? { kind: 'selected', photo }
      : { kind: 'cancelled' };
  } catch (error) {
    if (isZaloPermissionDenied(error)) return { kind: 'permission-denied' };
    if (isMediaPickerCancelled(error)) return { kind: 'cancelled' };
    return { kind: 'error', error };
  }
}
