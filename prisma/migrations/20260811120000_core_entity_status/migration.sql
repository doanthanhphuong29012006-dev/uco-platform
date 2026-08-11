-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'INACTIVE');

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
ALTER TABLE "collectors" ADD COLUMN     "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "containers" ADD COLUMN     "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "avg_daily_liters" DECIMAL(10,2),
ADD COLUMN     "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "stations" ADD COLUMN     "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE';

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
