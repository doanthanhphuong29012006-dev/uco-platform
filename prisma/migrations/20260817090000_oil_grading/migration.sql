-- Oil grading is required by the API for new transactions, but remains nullable
-- in the database so historical transactions are not backfilled with guesses.
CREATE TYPE "OilGrade" AS ENUM ('A', 'B', 'C');

ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'SUSPECTED_ADULTERATION';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'OIL_GRADE_C';

ALTER TABLE "collection_transactions"
  ADD COLUMN "grade" "OilGrade",
  ADD COLUMN "grade_photo_url" TEXT,
  ADD COLUMN "grade_note" TEXT,
  ADD COLUMN "suspected_adulteration" BOOLEAN NOT NULL DEFAULT false;
