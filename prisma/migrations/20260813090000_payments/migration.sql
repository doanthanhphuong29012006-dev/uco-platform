CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

CREATE TABLE "oil_prices" (
  "id" UUID NOT NULL,
  "unit_price" DECIMAL(14,2) NOT NULL,
  "effective_from" TIMESTAMPTZ(3) NOT NULL,
  "effective_to" TIMESTAMPTZ(3),
  "note" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "oil_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oil_prices_positive_unit_price" CHECK ("unit_price" > 0),
  CONSTRAINT "oil_prices_valid_range" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);

-- A database-level exclusion constraint is the final guard against overlapping
-- price windows, including concurrent admin requests.
ALTER TABLE "oil_prices"
  ADD CONSTRAINT "oil_prices_effective_range_excl"
  EXCLUDE USING GIST (
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  );

CREATE INDEX "oil_prices_effective_from_effective_to_idx"
  ON "oil_prices"("effective_from", "effective_to");

CREATE TABLE "payments" (
  "id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "transaction_id" UUID NOT NULL,
  "liters" DECIMAL(10,2) NOT NULL,
  "unit_price" DECIMAL(14,2) NOT NULL,
  "amount" DECIMAL(18,0) NOT NULL,
  "period" TEXT NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "paid_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payments_transaction_id_key" UNIQUE ("transaction_id"),
  CONSTRAINT "payments_positive_liters" CHECK ("liters" > 0),
  CONSTRAINT "payments_positive_unit_price" CHECK ("unit_price" > 0),
  CONSTRAINT "payments_nonnegative_amount" CHECK ("amount" >= 0),
  CONSTRAINT "payments_period_format" CHECK ("period" ~ '^[0-9]{4}-W[0-9]{2}$')
);

CREATE INDEX "payments_merchant_id_period_idx"
  ON "payments"("merchant_id", "period");
CREATE INDEX "payments_period_status_idx"
  ON "payments"("period", "status");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "collection_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
