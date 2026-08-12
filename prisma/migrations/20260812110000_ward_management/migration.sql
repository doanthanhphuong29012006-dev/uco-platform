ALTER TABLE "wards"
  ADD COLUMN "district" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "boundary" geometry(MultiPolygon, 4326);

CREATE INDEX "wards_status_is_active_idx" ON "wards"("status", "is_active");

ALTER TABLE "containers" ADD COLUMN "ward_id" UUID;
UPDATE "containers" c
SET "ward_id" = m."ward_id"
FROM "merchants" m
WHERE c."merchant_id" = m."id";
ALTER TABLE "containers"
  ADD CONSTRAINT "containers_ward_id_fkey"
  FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "containers_ward_id_state_idx" ON "containers"("ward_id", "state");
