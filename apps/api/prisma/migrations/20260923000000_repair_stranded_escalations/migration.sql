-- C2 (2026-09-23): repair approvals stranded by an escalation with no target.
--
-- The old escalation handler set the overdue step AND its instance to
-- ESCALATED when the workflow named no one to escalate to. No queue shows an
-- ESCALATED step and /decide only accepts PENDING ones, so the contract could
-- never leave PENDING_APPROVAL. Only that branch ever set an INSTANCE to
-- ESCALATED (escalating to a named user keeps the instance PENDING and adds a
-- replacement step), so hand each such step back to its approver, then
-- reopen the instance. Data only: no schema change.
UPDATE approval_steps s
SET    status = 'PENDING', "decidedAt" = NULL
FROM   approval_instances i
WHERE  i.id = s."approvalInstanceId"
  AND  i.status = 'ESCALATED'
  AND  s.status = 'ESCALATED'
  AND  s."stepOrder" = i."currentStepOrder"
  AND  NOT EXISTS (
         SELECT 1 FROM approval_steps t
         WHERE  t."approvalInstanceId" = s."approvalInstanceId"
           AND  t."stepOrder" = s."stepOrder"
           AND  t.id <> s.id
           AND  t.status = 'PENDING'
       );

UPDATE approval_instances SET status = 'PENDING' WHERE status = 'ESCALATED';
