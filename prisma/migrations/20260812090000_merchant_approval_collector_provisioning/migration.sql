-- Merchant onboarding and collector provisioning. Existing seeded merchants stay active and approved.
CREATE TYPE "MerchantApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "merchants"
  ADD COLUMN "business_type" TEXT,
  ADD COLUMN "approval_status" "MerchantApprovalStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "rejection_reason" TEXT;

UPDATE "merchants" SET "approval_status" = 'APPROVED' WHERE "deleted_at" IS NULL;

ALTER TABLE "collectors" ADD COLUMN "vehicle_type" TEXT;

CREATE TABLE "collector_wards" (
  "id" UUID NOT NULL,
  "collector_id" UUID NOT NULL,
  "ward_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "collector_wards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "collector_wards_collector_id_ward_id_key" ON "collector_wards"("collector_id", "ward_id");
CREATE INDEX "collector_wards_ward_id_idx" ON "collector_wards"("ward_id");
ALTER TABLE "collector_wards" ADD CONSTRAINT "collector_wards_collector_id_fkey"
  FOREIGN KEY ("collector_id") REFERENCES "collectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "collector_wards" ADD CONSTRAINT "collector_wards_ward_id_fkey"
  FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "collector_wards" ("id", "collector_id", "ward_id")
SELECT gen_random_uuid(), c."id", c."ward_id"
FROM "collectors" c
WHERE c."deleted_at" IS NULL
ON CONFLICT ("collector_id", "ward_id") DO NOTHING;
