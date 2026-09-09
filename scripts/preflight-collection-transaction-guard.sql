-- Read-only preflight. Does NOT apply migrations or modify business data.
-- Run only on the intended database with operator approval.
-- Stop if the duplicate-order query returns any row; never auto-delete duplicates.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';

SELECT current_database() AS database_name, current_schema() AS schema_name;

-- Expected: zero rows. Predicate must match the migration's partial index.
SELECT order_id, COUNT(*) AS live_count,
       ARRAY_AGG(id ORDER BY created_at) AS transaction_ids
FROM public.collection_transactions
WHERE order_id IS NOT NULL AND deleted_at IS NULL
GROUP BY order_id
HAVING COUNT(*) > 1;

-- Review the actual definition and validity, not just the index name.
SELECT index_class.relname AS index_name, idx.indisunique, idx.indisvalid,
       pg_get_indexdef(idx.indexrelid) AS index_definition
FROM pg_catalog.pg_index idx
JOIN pg_catalog.pg_class index_class ON index_class.oid = idx.indexrelid
WHERE idx.indrelid = 'public.collection_transactions'::regclass
  AND index_class.relname = 'collection_transactions_live_order_id_key';

SELECT migration_name, started_at, finished_at, rolled_back_at
FROM public._prisma_migrations
WHERE migration_name = '20260908120000_collection_order_transaction_guard'
ORDER BY started_at DESC;

COMMIT;
