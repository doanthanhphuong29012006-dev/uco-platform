import { OilGrade } from '@prisma/client';
import { collectionCreateSchema } from '@eco-oil/validation';

const basePayload = {
  client_uuid: '00000000-0000-4000-8000-000000000001',
  order_id: '00000000-0000-4000-8000-000000000002',
  container_code: 'ECO-UCO-HB-HK-001',
  actual_liters: 20,
  grade: OilGrade.B,
  quality: 'PASS',
  geo: { lat: 21.0333, lng: 105.85 },
  photos: ['https://example.com/grade.jpg'],
};

const analysis = {
  suggested_grade: OilGrade.B,
  confidence: 'MEDIUM',
  model_version: 'oil-image-heuristic-v1',
  analyzed_image_count: 1,
  quality_status: 'USABLE',
  reason_codes: ['MEDIUM_BROWN_APPEARANCE'],
  summary: 'Ảnh có đặc điểm hình ảnh gần với hạng B.',
  features: {
    mean_luminance: 0.4, dark_pixel_ratio: 0.1, yellow_brown_ratio: 0.3,
    saturation_mean: 0.4, contrast: 0.1, texture_score: 0.03, blur_score: 0.03,
  },
};

describe('image grading collection contract', () => {
  it('accepts bounded analysis metadata and a manual override acknowledgement', () => {
    const parsed = collectionCreateSchema.parse({
      ...basePayload,
      image_grade_suggestion: 'B', image_grade_confidence: 'MEDIUM', image_grade_model_version: 'oil-image-heuristic-v1',
      image_grade_analysis: analysis, grade_decision_source: 'AI_SUGGESTION_ACCEPTED', grade_ai_override_acknowledged: false,
    });
    expect(parsed.image_grade_analysis).toEqual(analysis);
  });

  it('rejects unknown analysis fields instead of silently persisting unbounded metadata', () => {
    expect(() => collectionCreateSchema.parse({ ...basePayload, image_grade_analysis: { ...analysis, secret: 'nope' } })).toThrow();
  });

  it('rejects non-finite feature values', () => {
    expect(() => collectionCreateSchema.parse({ ...basePayload, image_grade_analysis: { ...analysis, features: { ...analysis.features, contrast: Number.NaN } } })).toThrow();
  });

  it('accepts the explicit AI/collector decision fields only with final confirmation', () => {
    const parsed = collectionCreateSchema.parse({
      ...basePayload,
      ai_suggested_grade: 'B',
      collector_selected_grade: 'B',
      collector_grade_confirmed: true,
    });
    expect(parsed.ai_suggested_grade).toBe('B');
    expect(parsed.collector_selected_grade).toBe('B');
  });

  it('rejects an unconfirmed collector final grade', () => {
    expect(() => collectionCreateSchema.parse({
      ...basePayload,
      ai_suggested_grade: 'B',
      collector_selected_grade: 'B',
      collector_grade_confirmed: false,
    })).toThrow();
  });
});
