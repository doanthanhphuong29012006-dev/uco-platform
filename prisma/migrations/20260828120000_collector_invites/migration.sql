-- Allow admin-created collector profiles to exist before the collector links a Zalo account.
CREATE TYPE "CollectorLinkStatus" AS ENUM ('PENDING_LINK', 'LINKED');

ALTER TABLE "users"
  ALTER COLUMN "zalo_id" DROP NOT NULL;

ALTER TABLE "collectors"
  ALTER COLUMN "user_id" DROP NOT NULL,
  ADD COLUMN "contact_phone" TEXT,
  ADD COLUMN "link_status" "CollectorLinkStatus" NOT NULL DEFAULT 'LINKED',
  ADD COLUMN "invite_code_hash" TEXT,
  ADD COLUMN "invite_expires_at" TIMESTAMP(3);

UPDATE "collectors" c
SET "contact_phone" = u."phone"
FROM "users" u
WHERE u."id" = c."user_id" AND c."contact_phone" IS NULL;
