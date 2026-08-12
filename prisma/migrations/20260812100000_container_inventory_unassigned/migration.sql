-- Allow inventory cans to exist before they are assigned to a merchant.
ALTER TABLE "containers"
  ALTER COLUMN "merchant_id" DROP NOT NULL;
