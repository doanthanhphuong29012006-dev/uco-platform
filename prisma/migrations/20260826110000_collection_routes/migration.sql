CREATE TYPE "CollectionRouteStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "CollectionRouteStopStatus" AS ENUM ('PENDING', 'COLLECTED', 'SKIPPED');

CREATE TABLE "collection_routes" (
    "id" UUID NOT NULL,
    "client_uuid" UUID NOT NULL,
    "collector_id" UUID NOT NULL,
    "status" "CollectionRouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "origin_lat" DOUBLE PRECISION,
    "origin_lng" DOUBLE PRECISION,
    "vehicle_capacity_l" DECIMAL(10,2) NOT NULL,
    "total_expected_liters" DECIMAL(10,2) NOT NULL,
    "remaining_capacity_l" DECIMAL(10,2) NOT NULL,
    "optimization_snapshot" JSONB NOT NULL,
    "capacity_risk_snapshot" JSONB NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "collection_routes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "collection_route_stops" (
    "id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "expected_liters" DECIMAL(10,2),
    "merchant_snapshot" JSONB NOT NULL,
    "ai_snapshot" JSONB NOT NULL,
    "status" "CollectionRouteStopStatus" NOT NULL DEFAULT 'PENDING',
    "collected_at" TIMESTAMPTZ(3),
    "skipped_at" TIMESTAMPTZ(3),
    "skip_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "collection_route_stops_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "collection_routes_client_uuid_key" ON "collection_routes"("client_uuid");
CREATE INDEX "collection_routes_collector_id_status_idx" ON "collection_routes"("collector_id", "status");
CREATE UNIQUE INDEX "collection_routes_one_active_per_collector_idx" ON "collection_routes"("collector_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "collection_route_stops_route_id_order_id_key" ON "collection_route_stops"("route_id", "order_id");
CREATE UNIQUE INDEX "collection_route_stops_route_id_sequence_key" ON "collection_route_stops"("route_id", "sequence");
CREATE INDEX "collection_route_stops_order_id_status_idx" ON "collection_route_stops"("order_id", "status");

ALTER TABLE "collection_routes" ADD CONSTRAINT "collection_routes_collector_id_fkey"
  FOREIGN KEY ("collector_id") REFERENCES "collectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "collection_route_stops" ADD CONSTRAINT "collection_route_stops_route_id_fkey"
  FOREIGN KEY ("route_id") REFERENCES "collection_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "collection_route_stops" ADD CONSTRAINT "collection_route_stops_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "collection_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
