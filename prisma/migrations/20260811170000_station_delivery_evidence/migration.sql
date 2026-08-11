ALTER TABLE "station_deliveries"
  ADD COLUMN "note" TEXT,
  ADD COLUMN "photos" JSONB NOT NULL DEFAULT '[]'::jsonb;
