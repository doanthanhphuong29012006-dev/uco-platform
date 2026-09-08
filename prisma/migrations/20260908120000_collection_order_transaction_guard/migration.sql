-- A collection order can have at most one live transaction. The partial
-- predicate preserves soft-deleted historical rows while preventing two
-- different client UUIDs from collecting the same order.
CREATE UNIQUE INDEX "collection_transactions_live_order_id_key"
ON "collection_transactions"("order_id")
WHERE "order_id" IS NOT NULL AND "deleted_at" IS NULL;
