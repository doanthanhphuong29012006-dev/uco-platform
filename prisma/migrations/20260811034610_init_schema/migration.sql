-- CreateEnum
CREATE TYPE "Role" AS ENUM ('MERCHANT', 'COLLECTOR', 'STATION', 'ADMIN');

-- CreateEnum
CREATE TYPE "ContainerState" AS ENUM ('AT_MERCHANT', 'IN_TRANSIT', 'AT_STATION');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('READY', 'ASSIGNED', 'COLLECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('MANUAL', 'PREDICTED');

-- CreateEnum
CREATE TYPE "Quality" AS ENUM ('PASS', 'FLAG');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('RECEIVED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "zalo_id" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wards" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT 'Ho Chi Minh City',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "wards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "business_name" TEXT NOT NULL,
    "address" TEXT,
    "location" geography(Point, 4326),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collectors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "collectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "location" geography(Point, 4326),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "containers" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "qr_code" TEXT NOT NULL,
    "state" "ContainerState" NOT NULL DEFAULT 'AT_MERCHANT',
    "capacity_liters" DECIMAL(10,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_orders" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "collector_id" UUID,
    "status" "OrderStatus" NOT NULL DEFAULT 'READY',
    "source" "OrderSource" NOT NULL DEFAULT 'MANUAL',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "collection_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_transactions" (
    "id" UUID NOT NULL,
    "client_uuid" TEXT NOT NULL,
    "order_id" UUID,
    "container_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "collector_id" UUID NOT NULL,
    "actual_liters" DECIMAL(10,2) NOT NULL,
    "quality" "Quality" NOT NULL,
    "geo_point" geography(Point, 4326),
    "photos" JSONB NOT NULL DEFAULT '[]',
    "collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "collection_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "station_deliveries" (
    "id" UUID NOT NULL,
    "station_id" UUID NOT NULL,
    "collector_id" UUID NOT NULL,
    "expected_liters" DECIMAL(10,2) NOT NULL,
    "actual_liters" DECIMAL(10,2) NOT NULL,
    "variance_liters" DECIMAL(10,2) NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'RECEIVED',
    "delivered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "station_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_zalo_id_key" ON "users"("zalo_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "wards_code_key" ON "wards"("code");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_user_id_key" ON "merchants"("user_id");

-- CreateIndex
CREATE INDEX "merchants_ward_id_is_active_idx" ON "merchants"("ward_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "collectors_user_id_key" ON "collectors"("user_id");

-- CreateIndex
CREATE INDEX "collectors_ward_id_is_active_idx" ON "collectors"("ward_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "stations_user_id_key" ON "stations"("user_id");

-- CreateIndex
CREATE INDEX "stations_ward_id_is_active_idx" ON "stations"("ward_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "containers_qr_code_key" ON "containers"("qr_code");

-- CreateIndex
CREATE INDEX "containers_merchant_id_state_idx" ON "containers"("merchant_id", "state");

-- CreateIndex
CREATE INDEX "collection_orders_status_priority_requested_at_idx" ON "collection_orders"("status", "priority", "requested_at");

-- CreateIndex
CREATE INDEX "collection_orders_merchant_id_requested_at_idx" ON "collection_orders"("merchant_id", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "collection_transactions_client_uuid_key" ON "collection_transactions"("client_uuid");

-- CreateIndex
CREATE INDEX "station_deliveries_station_id_delivered_at_idx" ON "station_deliveries"("station_id", "delivered_at");

-- CreateIndex
CREATE INDEX "station_deliveries_collector_id_delivered_at_idx" ON "station_deliveries"("collector_id", "delivered_at");

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collectors" ADD CONSTRAINT "collectors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collectors" ADD CONSTRAINT "collectors_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "containers" ADD CONSTRAINT "containers_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_orders" ADD CONSTRAINT "collection_orders_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_orders" ADD CONSTRAINT "collection_orders_collector_id_fkey" FOREIGN KEY ("collector_id") REFERENCES "collectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_transactions" ADD CONSTRAINT "collection_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "collection_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_transactions" ADD CONSTRAINT "collection_transactions_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "containers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_transactions" ADD CONSTRAINT "collection_transactions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_transactions" ADD CONSTRAINT "collection_transactions_collector_id_fkey" FOREIGN KEY ("collector_id") REFERENCES "collectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_deliveries" ADD CONSTRAINT "station_deliveries_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_deliveries" ADD CONSTRAINT "station_deliveries_collector_id_fkey" FOREIGN KEY ("collector_id") REFERENCES "collectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PostGIS geography indexes are maintained as raw SQL because Prisma does not
-- expose GiST index syntax for Unsupported geography fields.
CREATE INDEX "merchants_location_gist_idx"
  ON "merchants" USING GIST ("location");

CREATE INDEX "stations_location_gist_idx"
  ON "stations" USING GIST ("location");

CREATE INDEX "collection_transactions_geo_point_gist_idx"
  ON "collection_transactions" USING GIST ("geo_point");

CREATE INDEX "collection_transactions_collector_collected_at_idx"
  ON "collection_transactions" ("collector_id", "collected_at");

CREATE INDEX "collection_transactions_merchant_collected_at_idx"
  ON "collection_transactions" ("merchant_id", "collected_at");
