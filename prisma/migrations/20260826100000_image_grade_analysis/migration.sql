CREATE TYPE "ImageGradeConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "GradeDecisionSource" AS ENUM ('MANUAL', 'AI_SUGGESTION_ACCEPTED', 'MANUAL_OVERRIDE_AI');

ALTER TABLE "collection_transactions"
  ADD COLUMN "image_grade_suggestion" "OilGrade",
  ADD COLUMN "image_grade_confidence" "ImageGradeConfidence",
  ADD COLUMN "image_grade_model_version" VARCHAR(64),
  ADD COLUMN "image_grade_analysis" JSONB,
  ADD COLUMN "grade_decision_source" "GradeDecisionSource",
  ADD COLUMN "grade_ai_override_acknowledged" BOOLEAN NOT NULL DEFAULT false;
