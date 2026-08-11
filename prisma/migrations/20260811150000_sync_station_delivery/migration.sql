-- Sync metadata and station delivery reconciliation fields.
ALTER TYPE "DeliveryStatus" RENAME TO "DeliveryStatus_old";
CREATE TYPE "DeliveryStatus" AS ENUM ('OK', 'FLAGGED');
ALTER TABLE "station_deliveries" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "station_deliveries"
  ALTER COLUMN "status" TYPE "DeliveryStatus"
  USING CASE WHEN "status"::text = 'REJECTED' THEN 'FLAGGED'::"DeliveryStatus" ELSE 'OK'::"DeliveryStatus" END;
ALTER TABLE "station_deliveries" ALTER COLUMN "status" SET DEFAULT 'OK';
DROP TYPE "DeliveryStatus_old";

ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'DELIVERY_VARIANCE';
CREATE TYPE "AlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

ALTER TABLE "stations"
  ADD COLUMN "capacity_l" DECIMAL(10,2) NOT NULL DEFAULT 1000,
  ADD COLUMN "current_volume_l" DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE "collection_transactions"
  ADD COLUMN "synced_at" TIMESTAMP(3),
  ADD COLUMN "station_delivery_id" UUID;

ALTER TABLE "station_deliveries"
  ADD COLUMN "client_uuid" TEXT,
  ADD COLUMN "variance_pct" DECIMAL(10,6);
UPDATE "station_deliveries"
SET "client_uuid" = md5(random()::text || clock_timestamp()::text || "id"::text)
WHERE "client_uuid" IS NULL;
UPDATE "station_deliveries"
SET "variance_pct" = CASE WHEN "expected_liters" = 0 THEN 0 ELSE "variance_liters" / "expected_liters" END
WHERE "variance_pct" IS NULL;
ALTER TABLE "station_deliveries"
  ALTER COLUMN "client_uuid" SET NOT NULL,
  ALTER COLUMN "variance_pct" SET NOT NULL;

ALTER TABLE "alerts"
  ALTER COLUMN "transaction_id" DROP NOT NULL,
  ADD COLUMN "station_delivery_id" UUID,
  ADD COLUMN "severity" "AlertSeverity";

CREATE UNIQUE INDEX "station_deliveries_client_uuid_key" ON "station_deliveries"("client_uuid");
CREATE INDEX "collection_transactions_station_delivery_id_idx" ON "collection_transactions"("station_delivery_id");

ALTER TABLE "collection_transactions"
  ADD CONSTRAINT "collection_transactions_station_delivery_id_fkey"
  FOREIGN KEY ("station_delivery_id") REFERENCES "station_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "alerts"
  ADD CONSTRAINT "alerts_station_delivery_id_fkey"
  FOREIGN KEY ("station_delivery_id") REFERENCES "station_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Restore PostGIS indexes that Prisma cannot represent in schema.prisma.
CREATE INDEX IF NOT EXISTS "merchants_location_gist_idx"
  ON "merchants" USING GIST ("location");
CREATE INDEX IF NOT EXISTS "stations_location_gist_idx"
  ON "stations" USING GIST ("location");
CREATE INDEX IF NOT EXISTS "collection_transactions_geo_point_gist_idx"
  ON "collection_transactions" USING GIST ("geo_point");
CREATE INDEX IF NOT EXISTS "collection_transactions_collector_collected_at_idx"
  ON "collection_transactions" USING BTREE ("collector_id", "collected_at");
CREATE INDEX IF NOT EXISTS "collection_transactions_merchant_collected_at_idx"
  ON "collection_transactions" USING BTREE ("merchant_id", "collected_at");
