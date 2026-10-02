-- AlterTable
ALTER TABLE "approval_instances" ADD COLUMN     "outcome" TEXT;

-- AlterTable
ALTER TABLE "approval_steps" ADD COLUMN     "approverRoleId" TEXT,
ADD COLUMN     "clauseType" TEXT,
ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "findingId" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'approval',
ADD COLUMN     "linkedClauseIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "linkedFindingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "versionId" TEXT,
ALTER COLUMN "approvalInstanceId" DROP NOT NULL,
ALTER COLUMN "approverId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "clause_categories" ADD COLUMN     "approverRoleId" TEXT,
ADD COLUMN     "approverUserId" TEXT;

-- AlterTable
ALTER TABLE "contract_requests" ADD COLUMN     "rejectionReason" TEXT;

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'draft',
ADD COLUMN     "stageState" TEXT NOT NULL DEFAULT 'drafting',
ADD COLUMN     "turn" TEXT NOT NULL DEFAULT 'internal',
ADD COLUMN     "turnOwnerId" TEXT,
ADD COLUMN     "turnSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "approval_steps_approverRoleId_status_idx" ON "approval_steps"("approverRoleId", "status");

-- CreateIndex
CREATE INDEX "approval_steps_contractId_kind_idx" ON "approval_steps"("contractId", "kind");

-- CreateIndex
CREATE INDEX "audit_events_orgId_action_createdAt_idx" ON "audit_events"("orgId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "contracts_orgId_stage_idx" ON "contracts"("orgId", "stage");

-- ─── docs/41 Part 18 — stage, state and turn from the status ─────────────────
-- The mapping is packages/types/src/lifecycle.ts (stageForStatus, turnFor),
-- documented in docs/47-STAGE-STATE-TURN.md. The SQL functions below are the
-- same tables; lifecycle-trigger.integration.test.ts checks they agree.

CREATE OR REPLACE FUNCTION clm_status_for(stage TEXT, state TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE stage
    WHEN 'request'   THEN 'DRAFT'
    WHEN 'draft'     THEN CASE WHEN state = 'ready' THEN 'PENDING_REVIEW' ELSE 'DRAFT' END
    WHEN 'negotiate' THEN 'UNDER_NEGOTIATION'
    WHEN 'approve'   THEN CASE state WHEN 'approved' THEN 'APPROVED' WHEN 'declined' THEN 'DRAFT' ELSE 'PENDING_APPROVAL' END
    WHEN 'sign'      THEN 'PENDING_SIGNATURE'
    WHEN 'active'    THEN 'EXECUTED'
    WHEN 'closed'    THEN CASE state WHEN 'expired' THEN 'EXPIRED' WHEN 'terminated' THEN 'TERMINATED' ELSE 'ARCHIVED' END
    ELSE 'DRAFT'
  END
$$;

CREATE OR REPLACE FUNCTION clm_stage_for(status TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE status
    WHEN 'PENDING_REVIEW'    THEN 'draft'
    WHEN 'UNDER_NEGOTIATION' THEN 'negotiate'
    WHEN 'PENDING_APPROVAL'  THEN 'approve'
    WHEN 'APPROVED'          THEN 'approve'
    WHEN 'REJECTED'          THEN 'draft'
    WHEN 'PENDING_SIGNATURE' THEN 'sign'
    WHEN 'EXECUTED'          THEN 'active'
    WHEN 'EXPIRED'           THEN 'closed'
    WHEN 'TERMINATED'        THEN 'closed'
    WHEN 'ARCHIVED'          THEN 'closed'
    ELSE 'draft'
  END
$$;

CREATE OR REPLACE FUNCTION clm_state_for(status TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE status
    WHEN 'PENDING_REVIEW'    THEN 'ready'
    WHEN 'UNDER_NEGOTIATION' THEN 'with_us'
    WHEN 'PENDING_APPROVAL'  THEN 'pending'
    WHEN 'APPROVED'          THEN 'approved'
    WHEN 'REJECTED'          THEN 'returned'
    WHEN 'PENDING_SIGNATURE' THEN 'out_for_signature'
    WHEN 'EXECUTED'          THEN 'active'
    WHEN 'EXPIRED'           THEN 'expired'
    WHEN 'TERMINATED'        THEN 'terminated'
    WHEN 'ARCHIVED'          THEN 'archived'
    ELSE 'drafting'
  END
$$;

CREATE OR REPLACE FUNCTION clm_turn_for(stage TEXT, state TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE stage
    WHEN 'negotiate' THEN CASE WHEN state = 'with_counterparty' THEN 'counterparty' ELSE 'internal' END
    WHEN 'approve'   THEN CASE WHEN state = 'pending' THEN 'approvers' ELSE 'internal' END
    WHEN 'sign'      THEN CASE WHEN state = 'out_for_signature' THEN 'signers' ELSE 'internal' END
    WHEN 'active'    THEN 'none'
    WHEN 'closed'    THEN 'none'
    ELSE 'internal'
  END
$$;

-- Existing contracts: the stage their status stands for.
UPDATE "contracts" SET
  "stage"      = clm_stage_for("status"),
  "stageState" = clm_state_for("status");

-- Negotiations: the counterparty's turn when we sent it after the last
-- version (a share link, or a redline exported for them) and that version
-- wasn't theirs; otherwise ours.
UPDATE "contracts" c SET "stageState" = 'with_counterparty'
WHERE c."stage" = 'negotiate'
  AND EXISTS (
    SELECT 1 FROM "contract_versions" v
    WHERE v.id = c."currentVersionId"
      AND v."createdById" NOT LIKE 'portal:%' AND v."createdById" NOT LIKE 'email:%'
      AND (
        EXISTS (SELECT 1 FROM "contract_share_links" l WHERE l."contractId" = c.id AND l."createdAt" > v."createdAt" AND l."revokedAt" IS NULL)
        OR EXISTS (SELECT 1 FROM "audit_events" a WHERE a."orgId" = c."orgId" AND a."resourceType" = 'contract' AND a."resourceId" = c.id AND a.action = 'REDLINE_EXPORTED' AND a."createdAt" > v."createdAt")
      )
  );

UPDATE "contracts" c SET
  "turn"        = clm_turn_for(c."stage", c."stageState"),
  "turnOwnerId" = CASE WHEN clm_turn_for(c."stage", c."stageState") = 'internal' THEN c."ownerId" ELSE NULL END,
  "turnSince"   = COALESCE(
    (SELECT max(a."createdAt") FROM "audit_events" a
      WHERE a."orgId" = c."orgId" AND a."resourceType" = 'contract' AND a."resourceId" = c.id AND a.action = 'CONTRACT_STATUS_CHANGED'),
    c."updatedAt");

-- A writer that sets only the status (an import, a seed, a script, a route
-- not yet moved to lib/lifecycle.ts) gets the stage that status stands for;
-- a writer that moves the stage gets the status derived from it. The two
-- columns can't disagree.
CREATE OR REPLACE FUNCTION contracts_stage_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."stage" IS DISTINCT FROM OLD."stage" OR NEW."stageState" IS DISTINCT FROM OLD."stageState") THEN
    NEW."status" := clm_status_for(NEW."stage", NEW."stageState");
  ELSIF NEW."status" IS DISTINCT FROM clm_status_for(NEW."stage", NEW."stageState") THEN
    NEW."stage"      := clm_stage_for(NEW."status");
    NEW."stageState" := clm_state_for(NEW."status");
    NEW."turn"       := clm_turn_for(NEW."stage", NEW."stageState");
  END IF;
  IF NEW."turn" = 'internal' AND NEW."turnOwnerId" IS NULL THEN
    NEW."turnOwnerId" := NEW."ownerId";
  ELSIF NEW."turn" <> 'internal' THEN
    NEW."turnOwnerId" := NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."turn" IS DISTINCT FROM OLD."turn" AND NEW."turnSince" IS NOT DISTINCT FROM OLD."turnSince" THEN
    NEW."turnSince" := now();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER contracts_stage_sync
BEFORE INSERT OR UPDATE ON "contracts"
FOR EACH ROW EXECUTE FUNCTION contracts_stage_sync();

-- ─── docs/41 Part 4 / §6.12 — approvals in flight ────────────────────────────
-- Attach them to the version the contract stands on; don't reset them.
UPDATE "approval_instances" ai SET "versionId" = c."currentVersionId"
FROM "contracts" c
WHERE ai."contractId" = c.id AND ai."versionId" IS NULL AND c."currentVersionId" IS NOT NULL;

UPDATE "approval_instances" SET "outcome" = CASE "status"
  WHEN 'APPROVED' THEN 'approved'
  WHEN 'AUTO_APPROVED' THEN 'approved'
  WHEN 'REJECTED' THEN 'returned'
  WHEN 'CANCELLED' THEN 'cancelled'
  ELSE NULL END;

UPDATE "approval_steps" s SET "contractId" = ai."contractId",
  "versionId" = CASE WHEN s."decidedAt" IS NOT NULL THEN ai."versionId" ELSE NULL END
FROM "approval_instances" ai
WHERE s."approvalInstanceId" = ai.id;
