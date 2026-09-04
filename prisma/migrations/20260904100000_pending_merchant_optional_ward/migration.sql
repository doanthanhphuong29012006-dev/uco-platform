-- Preserve all existing profiles and history. Pending onboarding can wait for an Admin ward assignment.
ALTER TABLE "merchants" ALTER COLUMN "ward_id" DROP NOT NULL;
ALTER TABLE "merchants" ADD CONSTRAINT "approved_merchant_requires_ward"
  CHECK ("approval_status" <> 'APPROVED' OR "ward_id" IS NOT NULL);
