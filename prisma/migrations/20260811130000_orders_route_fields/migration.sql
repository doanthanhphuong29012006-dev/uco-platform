/*
  Warnings:

*/
-- DropIndex
DROP INDEX "collection_transactions_collector_collected_at_idx";

-- DropIndex
DROP INDEX "collection_transactions_geo_point_gist_idx";

-- DropIndex
DROP INDEX "collection_transactions_merchant_collected_at_idx";

-- DropIndex
DROP INDEX "merchants_location_gist_idx";

-- DropIndex
DROP INDEX "stations_location_gist_idx";

-- AlterTable
ALTER TABLE "collection_orders" ADD COLUMN     "container_id" UUID,
ADD COLUMN     "expected_liters" DECIMAL(10,2),
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "collectors" ADD COLUMN     "max_capacity_l" DECIMAL(10,2) NOT NULL DEFAULT 100;

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "last_collected_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "wards" ADD COLUMN     "center_lat" DOUBLE PRECISION,
ADD COLUMN     "center_lng" DOUBLE PRECISION;

-- AddForeignKey
ALTER TABLE "collection_orders" ADD CONSTRAINT "collection_orders_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "containers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
