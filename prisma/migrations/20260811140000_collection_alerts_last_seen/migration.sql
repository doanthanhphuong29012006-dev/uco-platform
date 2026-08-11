-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('GEO_MISMATCH');

-- DropForeignKey
ALTER TABLE "collection_orders" DROP CONSTRAINT "collection_orders_container_id_fkey";

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
ALTER TABLE "containers" ADD COLUMN     "last_seen_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "type" "AlertType" NOT NULL,
    "message" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alerts_type_created_at_idx" ON "alerts"("type", "created_at");

-- AddForeignKey
ALTER TABLE "collection_orders" ADD CONSTRAINT "collection_orders_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "containers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "collection_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
