import jsQR from 'jsqr';

type BarcodeDetectorResult = { rawValue?: string };
type BarcodeDetectorInstance = {
  detect(source: CanvasImageSource): Promise<BarcodeDetectorResult[]>;
};
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorInstance;

export type BrowserQrErrorCode =
  | 'CAMERA_UNSUPPORTED'
  | 'CAMERA_PERMISSION_DENIED'
  | 'CAMERA_NOT_FOUND'
  | 'QR_CANCELLED'
  | 'QR_TIMEOUT'
  | 'QR_NOT_FOUND';

export class BrowserQrScannerError extends Error {
  constructor(
    readonly code: BrowserQrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserQrScannerError';
  }
}

function browserQrError(error: unknown): BrowserQrScannerError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new BrowserQrScannerError(
      'CAMERA_PERMISSION_DENIED',
      'Trình duyệt chưa được cấp quyền Camera. Hãy bật quyền camera trong cài đặt Safari/Chrome rồi thử lại.',
    );
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new BrowserQrScannerError('CAMERA_NOT_FOUND', 'Thiết bị không tìm thấy camera phù hợp.');
  }
  return error instanceof BrowserQrScannerError
    ? error
    : new BrowserQrScannerError('CAMERA_UNSUPPORTED', 'Không mở được camera trên trình duyệt này.');
}

function createImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không đọc được ảnh QR'));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Ảnh QR không hợp lệ'));
      image.src = String(reader.result ?? '');
    };
    reader.readAsDataURL(file);
  });
}

async function decodeCanvas(
  canvas: HTMLCanvasElement,
  detector: BarcodeDetectorInstance | null,
): Promise<string | null> {
  if (detector) {
    try {
      const detected = await detector.detect(canvas);
      const value = detected[0]?.rawValue?.trim();
      if (value) return value;
    } catch {
      // Some Safari/WebView builds expose BarcodeDetector but fail at runtime.
    }
  }

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || canvas.width < 1 || canvas.height < 1) return null;
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  })?.data?.trim() || null;
}

function makeDetector(): BarcodeDetectorInstance | null {
  const Detector = (globalThis as typeof globalThis & {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }).BarcodeDetector;
  if (typeof Detector !== 'function') return null;
  try {
    return new Detector({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

export interface BrowserQrScannerOptions {
  timeoutMs?: number;
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'> | null;
  document?: Document | null;
}

export function scanBrowserQrCode({
  timeoutMs = 45_000,
  mediaDevices = typeof navigator === 'undefined' ? null : navigator.mediaDevices,
  document: browserDocument = typeof document === 'undefined' ? null : document,
}: BrowserQrScannerOptions = {}): Promise<string> {
  if (!browserDocument || !mediaDevices?.getUserMedia) {
    return Promise.reject(
      new BrowserQrScannerError(
        'CAMERA_UNSUPPORTED',
        'Trình duyệt không hỗ trợ camera. Hãy chọn ảnh QR hoặc nhập mã can bằng tay.',
      ),
    );
  }

  // Start the permission request in the original click stack to preserve iOS user activation.
  const streamRequest = mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });

  return new Promise<string>((resolve, reject) => {
    const overlay = browserDocument.createElement('div');
    overlay.className = 'browser-qr-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Quét mã QR');

    const panel = browserDocument.createElement('div');
    panel.className = 'browser-qr-panel';
    const title = browserDocument.createElement('strong');
    title.textContent = 'Đưa mã QR vào giữa khung hình';
    const help = browserDocument.createElement('p');
    help.textContent = 'Nếu camera bị chặn, hãy bật quyền Camera trong cài đặt Safari/Chrome hoặc chọn ảnh QR.';
    const video = browserDocument.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    const canvas = browserDocument.createElement('canvas');
    canvas.hidden = true;
    const actions = browserDocument.createElement('div');
    actions.className = 'browser-qr-actions';
    const fileLabel = browserDocument.createElement('label');
    fileLabel.className = 'secondary-button';
    fileLabel.textContent = 'Chọn ảnh QR';
    const fileInput = browserDocument.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.className = 'accessible-file-input';
    fileLabel.append(fileInput);
    const cancelButton = browserDocument.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'secondary-button';
    cancelButton.textContent = 'Đóng camera';
    actions.append(fileLabel, cancelButton);
    panel.append(title, help, video, actions, canvas);
    overlay.append(panel);
    browserDocument.body.append(overlay);

    let settled = false;
    let stream: MediaStream | null = null;
    let frame = 0;
    const detector = makeDetector();
    const timeout = globalThis.setTimeout(
      () => finish(new BrowserQrScannerError('QR_TIMEOUT', 'Quét QR quá thời gian chờ. Hãy thử lại hoặc nhập mã bằng tay.')),
      timeoutMs,
    );

    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      if (frame) cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      overlay.remove();
    };
    const finish = (outcome: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof outcome === 'string') resolve(outcome);
      else reject(outcome);
    };

    cancelButton.addEventListener('click', () => {
      finish(new BrowserQrScannerError('QR_CANCELLED', 'Đã đóng trình quét QR.'));
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      void createImage(file)
        .then(async (image) => {
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext('2d')?.drawImage(image, 0, 0);
          const code = await decodeCanvas(canvas, detector);
          if (code) finish(code);
          else help.textContent = 'Ảnh chưa nhận diện được QR. Hãy chọn ảnh rõ hơn hoặc nhập mã bằng tay.';
        })
        .catch(() => {
          help.textContent = 'Không đọc được ảnh QR. Hãy chọn ảnh khác hoặc nhập mã bằng tay.';
        });
    });

    const scanFrame = async () => {
      if (settled) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        const scale = Math.min(1, 960 / video.videoWidth);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
        const code = await decodeCanvas(canvas, detector);
        if (code) {
          finish(code);
          return;
        }
      }
      frame = requestAnimationFrame(() => {
        void scanFrame();
      });
    };

    void streamRequest.then(
      async (openedStream) => {
        if (settled) {
          openedStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = openedStream;
        video.srcObject = openedStream;
        try {
          await video.play();
          void scanFrame();
        } catch (error) {
          finish(browserQrError(error));
        }
      },
      (error) => finish(browserQrError(error)),
    );
  });
}
