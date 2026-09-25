-- Z4 — a notification held for its recipient's daily digest email
-- (lib/notification-digest.ts); cleared once the digest is sent.
ALTER TABLE "notifications" ADD COLUMN "emailDigest" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "notifications_emailDigest_userId_idx" ON "notifications"("emailDigest", "userId");
