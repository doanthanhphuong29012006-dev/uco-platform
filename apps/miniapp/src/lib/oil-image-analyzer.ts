export type OilImageGrade = 'A' | 'B' | 'C';
export type OilImageConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type OilImageQualityStatus = 'USABLE' | 'RETAKE_RECOMMENDED' | 'UNSUPPORTED';

export type OilImageReasonCode =
  | 'LIGHT_CLEAR_APPEARANCE'
  | 'MEDIUM_BROWN_APPEARANCE'
  | 'DARK_APPEARANCE'
  | 'HIGH_TEXTURE_OR_SEDIMENT'
  | 'LOW_TEXTURE'
  | 'IMAGE_TOO_DARK'
  | 'IMAGE_OVEREXPOSED'
  | 'IMAGE_TOO_BLURRY'
  | 'IMAGE_TOO_SMALL'
  | 'IMAGE_DECODE_FAILED'
  | 'MULTIPLE_IMAGES_DISAGREE'
  | 'INSUFFICIENT_IMAGE_SIGNAL';

export interface OilImageFeatures extends Record<string, number | null> {
  mean_luminance: number | null;
  dark_pixel_ratio: number | null;
  yellow_brown_ratio: number | null;
  saturation_mean: number | null;
  contrast: number | null;
  texture_score: number | null;
  blur_score: number | null;
}

export interface OilImageAnalysis {
  suggested_grade: OilImageGrade | null;
  confidence: OilImageConfidence;
  model_version: 'oil-image-heuristic-v1';
  analyzed_image_count: number;
  quality_status: OilImageQualityStatus;
  reason_codes: OilImageReasonCode[];
  summary: string;
  features: OilImageFeatures;
}

export interface OilImagePixelFrame {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** Initial thresholds are intentionally centralized for calibration with real, labelled images later. */
export const OIL_IMAGE_HEURISTIC_CONFIG = Object.freeze({
  targetSize: 256,
  minimumDimension: 32,
  darkLuminance: 0.24,
  overexposedLuminance: 0.97,
  darkPixelRatio: 0.55,
  yellowBrownHueMin: 18,
  yellowBrownHueMax: 68,
  yellowBrownSaturationMin: 0.16,
  blurryTextureScore: 0.012,
  highTextureScore: 0.16,
  clearLuminance: 0.56,
  clearTextureScore: 0.09,
  nearThresholdMargin: 0.06,
});

const MODEL_VERSION = 'oil-image-heuristic-v1' as const;

const nullFeatures: OilImageFeatures = {
  mean_luminance: null,
  dark_pixel_ratio: null,
  yellow_brown_ratio: null,
  saturation_mean: null,
  contrast: null,
  texture_score: null,
  blur_score: null,
};

function uniqueReasons(reasons: OilImageReasonCode[]): OilImageReasonCode[] {
  return [...new Set(reasons)];
}

function unsupported(reason: OilImageReasonCode, count = 0): OilImageAnalysis {
  return {
    suggested_grade: null,
    confidence: 'LOW',
    model_version: MODEL_VERSION,
    analyzed_image_count: count,
    quality_status: 'UNSUPPORTED',
    reason_codes: [reason],
    summary: 'Chưa thể phân tích ảnh trên thiết bị này.',
    features: { ...nullFeatures },
  };
}

function hueAndSaturation(red: number, green: number, blue: number): { hue: number; saturation: number; luminance: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }
  const saturation = max === 0 ? 0 : delta / max;
  return { hue, saturation, luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

function finiteFrame(frame: OilImagePixelFrame): boolean {
  return Number.isInteger(frame.width) && frame.width > 0 && Number.isInteger(frame.height) && frame.height > 0
    && frame.data.length >= frame.width * frame.height * 4;
}

function sampleFrame(frame: OilImagePixelFrame): { features: OilImageFeatures; qualityReasons: OilImageReasonCode[] } | null {
  if (!finiteFrame(frame)) return null;
  const left = Math.floor(frame.width * 0.1);
  const top = Math.floor(frame.height * 0.1);
  const right = Math.ceil(frame.width * 0.9);
  const bottom = Math.ceil(frame.height * 0.9);
  const luminances: number[] = [];
  let dark = 0;
  let yellowBrown = 0;
  let saturationTotal = 0;
  let edgeTotal = 0;
  let edgeCount = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * frame.width + x) * 4;
      const pixel = hueAndSaturation(Number(frame.data[offset]), Number(frame.data[offset + 1]), Number(frame.data[offset + 2]));
      luminances.push(pixel.luminance);
      if (pixel.luminance < OIL_IMAGE_HEURISTIC_CONFIG.darkLuminance) dark += 1;
      if (pixel.saturation >= OIL_IMAGE_HEURISTIC_CONFIG.yellowBrownSaturationMin
        && pixel.hue >= OIL_IMAGE_HEURISTIC_CONFIG.yellowBrownHueMin
        && pixel.hue <= OIL_IMAGE_HEURISTIC_CONFIG.yellowBrownHueMax) yellowBrown += 1;
      saturationTotal += pixel.saturation;
      if (x > left) {
        const previous = (y * frame.width + x - 1) * 4;
        const neighbor = hueAndSaturation(Number(frame.data[previous]), Number(frame.data[previous + 1]), Number(frame.data[previous + 2]));
        edgeTotal += Math.abs(pixel.luminance - neighbor.luminance);
        edgeCount += 1;
      }
    }
  }
  if (luminances.length === 0) return null;
  const mean = luminances.reduce((sum, value) => sum + value, 0) / luminances.length;
  const variance = luminances.reduce((sum, value) => sum + (value - mean) ** 2, 0) / luminances.length;
  const texture = edgeCount === 0 ? 0 : edgeTotal / edgeCount;
  const features: OilImageFeatures = {
    mean_luminance: mean,
    dark_pixel_ratio: dark / luminances.length,
    yellow_brown_ratio: yellowBrown / luminances.length,
    saturation_mean: saturationTotal / luminances.length,
    contrast: Math.sqrt(variance),
    texture_score: texture,
    blur_score: texture,
  };
  const qualityReasons: OilImageReasonCode[] = [];
  if (frame.width < OIL_IMAGE_HEURISTIC_CONFIG.minimumDimension || frame.height < OIL_IMAGE_HEURISTIC_CONFIG.minimumDimension) qualityReasons.push('IMAGE_TOO_SMALL');
  if (mean < OIL_IMAGE_HEURISTIC_CONFIG.darkLuminance) qualityReasons.push('IMAGE_TOO_DARK');
  if (mean > OIL_IMAGE_HEURISTIC_CONFIG.overexposedLuminance) qualityReasons.push('IMAGE_OVEREXPOSED');
  if (texture < OIL_IMAGE_HEURISTIC_CONFIG.blurryTextureScore) qualityReasons.push('IMAGE_TOO_BLURRY');
  return { features, qualityReasons };
}

function classifySample(sample: { features: OilImageFeatures; qualityReasons: OilImageReasonCode[] }): OilImageAnalysis {
  const { features, qualityReasons } = sample;
  const mean = features.mean_luminance as number;
  const darkRatio = features.dark_pixel_ratio as number;
  const yellowBrown = features.yellow_brown_ratio as number;
  const texture = features.texture_score as number;
  const reasons: OilImageReasonCode[] = [...qualityReasons];
  let suggestedGrade: OilImageGrade | null = null;
  if (qualityReasons.includes('IMAGE_TOO_SMALL')) {
    reasons.push('INSUFFICIENT_IMAGE_SIGNAL');
  } else if (mean < 0.27 || darkRatio >= OIL_IMAGE_HEURISTIC_CONFIG.darkPixelRatio || texture >= OIL_IMAGE_HEURISTIC_CONFIG.highTextureScore) {
    suggestedGrade = 'C';
    reasons.push(texture >= OIL_IMAGE_HEURISTIC_CONFIG.highTextureScore ? 'HIGH_TEXTURE_OR_SEDIMENT' : 'DARK_APPEARANCE');
  } else if (mean >= OIL_IMAGE_HEURISTIC_CONFIG.clearLuminance && yellowBrown >= 0.12 && texture <= OIL_IMAGE_HEURISTIC_CONFIG.clearTextureScore) {
    suggestedGrade = 'A';
    reasons.push('LIGHT_CLEAR_APPEARANCE', 'LOW_TEXTURE');
  } else {
    suggestedGrade = 'B';
    reasons.push('MEDIUM_BROWN_APPEARANCE');
  }
  const lowQuality = qualityReasons.length > 0;
  const confidence: OilImageConfidence = suggestedGrade === null || lowQuality ? 'LOW' : (
    suggestedGrade === 'C' && (mean < 0.18 || darkRatio > 0.75) ? 'HIGH' :
      suggestedGrade === 'A' && mean > 0.7 && yellowBrown > 0.25 ? 'HIGH' :
        'MEDIUM'
  );
  const qualityStatus: OilImageQualityStatus = qualityReasons.includes('IMAGE_TOO_SMALL') ? 'UNSUPPORTED' : lowQuality ? 'RETAKE_RECOMMENDED' : 'USABLE';
  const summary = suggestedGrade === null
    ? 'Chưa đủ tín hiệu hình ảnh để gợi ý phân hạng.'
    : `Ảnh có đặc điểm hình ảnh gần với hạng ${suggestedGrade}. Đây chỉ là gợi ý thử nghiệm, không thay thế quyết định của người thu gom.`;
  return { suggested_grade: suggestedGrade, confidence, model_version: MODEL_VERSION, analyzed_image_count: 1, quality_status: qualityStatus, reason_codes: uniqueReasons(reasons), summary, features };
}

export function analyzeOilPixels(frame: OilImagePixelFrame): OilImageAnalysis {
  const sample = sampleFrame(frame);
  return sample ? classifySample(sample) : unsupported('IMAGE_TOO_SMALL');
}

export function analyzeOilPixelFrames(frames: readonly OilImagePixelFrame[]): OilImageAnalysis {
  if (frames.length === 0) return unsupported('INSUFFICIENT_IMAGE_SIGNAL');
  const analyses = frames.map(analyzeOilPixels);
  const usable = analyses.filter((analysis) => analysis.suggested_grade !== null);
  if (usable.length === 0) return { ...analyses[0], analyzed_image_count: analyses.length };
  const counts = new Map<OilImageGrade, number>();
  usable.forEach((analysis) => counts.set(analysis.suggested_grade as OilImageGrade, (counts.get(analysis.suggested_grade as OilImageGrade) ?? 0) + 1));
  const gradeOrder: OilImageGrade[] = ['A', 'B', 'C'];
  const winner = gradeOrder.reduce((best, grade) => (counts.get(grade) ?? 0) > (counts.get(best) ?? 0) ? grade : best, gradeOrder[0]);
  const disagree = counts.size > 1;
  const base = usable.find((analysis) => analysis.suggested_grade === winner) ?? usable[0];
  return {
    ...base,
    suggested_grade: winner,
    confidence: disagree ? 'LOW' : base.confidence,
    analyzed_image_count: analyses.length,
    reason_codes: uniqueReasons([...analyses.flatMap((analysis) => analysis.reason_codes), ...(disagree ? ['MULTIPLE_IMAGES_DISAGREE' as const] : [])]),
    summary: disagree ? 'Các ảnh cho tín hiệu khác nhau; người thu gom cần kiểm tra và quyết định phân hạng.' : base.summary,
  };
}

function decodeImage(url: string): Promise<OilImagePixelFrame> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      reject(new Error('IMAGE_DECODER_UNSUPPORTED'));
      return;
    }
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, OIL_IMAGE_HEURISTIC_CONFIG.targetSize / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) { reject(new Error('IMAGE_CANVAS_UNSUPPORTED')); return; }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      try { resolve({ width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data }); } catch (error) { reject(error); }
    };
    image.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
    image.src = url;
  });
}

export async function analyzeOilImages(imageUrls: readonly string[]): Promise<OilImageAnalysis> {
  if (imageUrls.length === 0) return unsupported('INSUFFICIENT_IMAGE_SIGNAL');
  try {
    const frames = await Promise.all(imageUrls.map((url) => decodeImage(url)));
    return analyzeOilPixelFrames(frames);
  } catch {
    return unsupported('IMAGE_DECODE_FAILED' as OilImageReasonCode);
  }
}
