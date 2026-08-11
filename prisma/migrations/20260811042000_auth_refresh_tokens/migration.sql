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

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_expires_at_revoked_at_idx" ON "refresh_tokens"("user_id", "expires_at", "revoked_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
