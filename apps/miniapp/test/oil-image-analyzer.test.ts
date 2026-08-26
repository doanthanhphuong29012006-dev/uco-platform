import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeOilPixelFrames, analyzeOilPixels, type OilImagePixelFrame } from '../src/lib/oil-image-analyzer';

function solid(width: number, height: number, rgb: [number, number, number]): OilImagePixelFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = rgb[0]; data[index + 1] = rgb[1]; data[index + 2] = rgb[2]; data[index + 3] = 255;
  }
  return { width, height, data };
}

function textured(width: number, height: number, base: [number, number, number]): OilImagePixelFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    const delta = (x + y) % 2 === 0 ? -60 : 40;
    data[index] = Math.max(0, base[0] + delta); data[index + 1] = Math.max(0, base[1] + delta); data[index + 2] = Math.max(0, base[2] + delta); data[index + 3] = 255;
  }
  return { width, height, data };
}

test('bright yellow clear pixels suggest grade A deterministically', () => {
  const result = analyzeOilPixels(solid(64, 64, [230, 170, 55]));
  assert.equal(result.suggested_grade, 'A');
  assert.equal(result.model_version, 'oil-image-heuristic-v1');
  assert.equal(result.analyzed_image_count, 1);
});

test('medium brown pixels suggest grade B', () => {
  assert.equal(analyzeOilPixels(solid(64, 64, [110, 65, 25])).suggested_grade, 'B');
});

test('dark textured pixels suggest grade C with an explainable reason', () => {
  const result = analyzeOilPixels(textured(64, 64, [35, 25, 15]));
  assert.equal(result.suggested_grade, 'C');
  assert.ok(result.reason_codes.includes('DARK_APPEARANCE') || result.reason_codes.includes('HIGH_TEXTURE_OR_SEDIMENT'));
});

test('small or invalid quality is never presented as a confident grade', () => {
  const result = analyzeOilPixels(solid(8, 8, [200, 150, 50]));
  assert.equal(result.suggested_grade, null);
  assert.equal(result.quality_status, 'UNSUPPORTED');
  assert.equal(result.confidence, 'LOW');
});

test('multiple images disagree deterministically and lower confidence', () => {
  const result = analyzeOilPixelFrames([solid(64, 64, [230, 170, 55]), solid(64, 64, [35, 25, 15])]);
  assert.equal(result.confidence, 'LOW');
  assert.ok(result.reason_codes.includes('MULTIPLE_IMAGES_DISAGREE'));
  assert.equal(result.analyzed_image_count, 2);
});
