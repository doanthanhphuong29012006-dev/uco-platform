DROP INDEX IF EXISTS "collectors_ward_id_is_active_idx";

ALTER TABLE "collectors"
  DROP CONSTRAINT IF EXISTS "collectors_ward_id_fkey";

ALTER TABLE "collectors"
  DROP COLUMN IF EXISTS "ward_id";
