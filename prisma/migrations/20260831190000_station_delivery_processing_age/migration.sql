ALTER TABLE "station_deliveries"
ADD COLUMN "processed_at" TIMESTAMP(3);

CREATE INDEX "station_deliveries_station_id_processed_at_delivered_at_idx"
ON "station_deliveries"("station_id", "processed_at", "delivered_at");
