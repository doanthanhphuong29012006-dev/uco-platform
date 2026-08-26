CREATE TYPE "AnomalyFeedbackVerdict" AS ENUM ('CONFIRMED_ANOMALY', 'FALSE_POSITIVE', 'UNSURE');
CREATE TYPE "AnomalyRiskLevel" AS ENUM ('NORMAL', 'REVIEW', 'HIGH_RISK');

-- CreateTable
CREATE TABLE "anomaly_feedback" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "verdict" "AnomalyFeedbackVerdict" NOT NULL,
    "note" TEXT,
    "reviewer_user_id" UUID NOT NULL,
    "risk_score_snapshot" INTEGER NOT NULL,
    "risk_level_snapshot" "AnomalyRiskLevel" NOT NULL,
    "reasons_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anomaly_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "anomaly_feedback_transaction_id_key" ON "anomaly_feedback"("transaction_id");
CREATE INDEX "anomaly_feedback_verdict_created_at_idx" ON "anomaly_feedback"("verdict", "created_at");
CREATE INDEX "anomaly_feedback_reviewer_user_id_updated_at_idx" ON "anomaly_feedback"("reviewer_user_id", "updated_at");

-- AddForeignKey
ALTER TABLE "anomaly_feedback" ADD CONSTRAINT "anomaly_feedback_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "collection_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "anomaly_feedback" ADD CONSTRAINT "anomaly_feedback_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
