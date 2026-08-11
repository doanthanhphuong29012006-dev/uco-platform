-- These indexes are managed in SQL because Prisma does not model GiST indexes
-- for Unsupported geography columns.
CREATE INDEX IF NOT EXISTS "merchants_location_gist_idx"
  ON "merchants" USING GIST ("location");

CREATE INDEX IF NOT EXISTS "stations_location_gist_idx"
  ON "stations" USING GIST ("location");

CREATE INDEX IF NOT EXISTS "collection_transactions_geo_point_gist_idx"
  ON "collection_transactions" USING GIST ("geo_point");

CREATE INDEX IF NOT EXISTS "collection_transactions_collector_collected_at_idx"
  ON "collection_transactions" ("collector_id", "collected_at");

CREATE INDEX IF NOT EXISTS "collection_transactions_merchant_collected_at_idx"
  ON "collection_transactions" ("merchant_id", "collected_at");
