CREATE TYPE "MassSource" AS ENUM ('SCALE', 'ESTIMATED_FROM_VOLUME');
CREATE TYPE "PriceUnit" AS ENUM ('PER_LITER', 'PER_KG');

ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'MASS_ESTIMATED_NOT_WEIGHED';

ALTER TABLE "collection_transactions"
  ADD COLUMN "actual_kg" DECIMAL(10,3),
  ADD COLUMN "mass_source" "MassSource" NOT NULL DEFAULT 'ESTIMATED_FROM_VOLUME',
  ADD COLUMN "density_factor" DECIMAL(10,6);

UPDATE "collection_transactions"
SET "actual_kg" = "actual_liters" * 0.91,
    "density_factor" = 0.91,
    "mass_source" = 'ESTIMATED_FROM_VOLUME';

ALTER TABLE "station_deliveries"
  ADD COLUMN "expected_kg" DECIMAL(10,3),
  ADD COLUMN "actual_kg" DECIMAL(10,3),
  ADD COLUMN "variance_kg" DECIMAL(10,3),
  ADD COLUMN "mass_source" "MassSource" NOT NULL DEFAULT 'ESTIMATED_FROM_VOLUME',
  ADD COLUMN "has_estimated_mass" BOOLEAN NOT NULL DEFAULT false;

UPDATE "station_deliveries"
SET "expected_kg" = "expected_liters" * 0.91,
    "actual_kg" = "actual_liters" * 0.91,
    "variance_kg" = "variance_liters" * 0.91,
    "mass_source" = 'ESTIMATED_FROM_VOLUME',
    "has_estimated_mass" = true;

ALTER TABLE "oil_prices"
  ADD COLUMN "unit" "PriceUnit" NOT NULL DEFAULT 'PER_LITER';

ALTER TABLE "payments"
  ADD COLUMN "kilograms" DECIMAL(10,3),
  ADD COLUMN "unit" "PriceUnit" NOT NULL DEFAULT 'PER_LITER';

UPDATE "payments" p
SET "kilograms" = ct."actual_kg"
FROM "collection_transactions" ct
WHERE ct."id" = p."transaction_id";
