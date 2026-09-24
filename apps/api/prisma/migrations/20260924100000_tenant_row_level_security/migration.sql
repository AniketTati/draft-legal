-- Y1 — Postgres row-level security for tenant data.
--
-- The API runs every query it makes for a signed-in organization as the role
-- clm_tenant_access, with app.tenant_id set for that transaction
-- (apps/api/src/lib/tenant-rls.ts). The policies below confine that role to
-- the tenant's rows, in every table that holds tenant data, whatever the query
-- says: raw SQL and rows loaded through relations included. Every other role
-- (migrations, background jobs, sign-in, the public signing and share links)
-- keeps its access; FORCE applies the policies to the tables' owner as well,
-- so they hold whichever role the application logs in as.
--
-- apps/api/src/lib/tenant-rls.integration.test.ts fails if a table with an
-- orgId column has no policy: a new tenant table needs its own statements here.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clm_tenant_access') THEN
    CREATE ROLE clm_tenant_access NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO clm_tenant_access;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO clm_tenant_access;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO clm_tenant_access;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO clm_tenant_access;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO clm_tenant_access;
-- The application's login switches to the role per transaction; a superuser
-- always can, any other login needs membership.
GRANT clm_tenant_access TO CURRENT_USER;

CREATE OR REPLACE FUNCTION clm_current_tenant() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '') $$;

-- Tables with an orgId column: the tenant's rows.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "users"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "counterparties" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "counterparties" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "counterparties"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contracts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contracts"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "contract_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_requests"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "contract_field_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_field_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_field_definitions"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "templates"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "clause_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clause_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clause_categories"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "clause_library_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clause_library_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clause_library_items"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "playbook_positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "playbook_positions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "playbook_positions"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_events"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "obligations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "obligations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "obligations"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoices"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "api_keys"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "webhooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhooks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhooks"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "diligence_rooms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diligence_rooms" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "diligence_rooms"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "contract_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_comments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_comments"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "contract_share_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_share_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_share_links"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "signature_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "signature_requests"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "workflow_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "workflow_definitions"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "approval_instances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_instances" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "approval_instances"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "approval_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_steps" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "approval_steps"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "matters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "matters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "matters"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "agent_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_threads" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_threads"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "skill_invocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_invocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "skill_invocations"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "org_ai_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_ai_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "org_ai_keys"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "org_ai_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_ai_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "org_ai_settings"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "org_usage_daily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_usage_daily" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "org_usage_daily"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

-- Built-in roles and skills have no org: every tenant reads them, none writes them.
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "roles"
  USING (current_user <> 'clm_tenant_access' OR ("orgId" = clm_current_tenant() OR "orgId" IS NULL))
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skills" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "skills"
  USING (current_user <> 'clm_tenant_access' OR ("orgId" = clm_current_tenant() OR "orgId" IS NULL))
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

-- Rows that belong to a tenant row: visible when their parent is.
ALTER TABLE "contract_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_versions"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "contracts" p WHERE p."id" = "contract_versions"."contractId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "contracts" p WHERE p."id" = "contract_versions"."contractId"));

ALTER TABLE "contract_clauses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_clauses" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_clauses"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "contract_versions" p WHERE p."id" = "contract_clauses"."versionId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "contract_versions" p WHERE p."id" = "contract_clauses"."versionId"));

ALTER TABLE "template_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "template_sections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "template_sections"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "templates" p WHERE p."id" = "template_sections"."templateId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "templates" p WHERE p."id" = "template_sections"."templateId"));

ALTER TABLE "signers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "signers"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "signature_requests" p WHERE p."id" = "signers"."signatureRequestId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "signature_requests" p WHERE p."id" = "signers"."signatureRequestId"));

ALTER TABLE "signature_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "signature_events"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "signature_requests" p WHERE p."id" = "signature_events"."signatureRequestId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "signature_requests" p WHERE p."id" = "signature_events"."signatureRequestId"));

ALTER TABLE "agent_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_messages"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "agent_threads" p WHERE p."id" = "agent_messages"."threadId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "agent_threads" p WHERE p."id" = "agent_messages"."threadId"));

ALTER TABLE "tool_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tool_calls"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "agent_threads" p WHERE p."id" = "tool_calls"."threadId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "agent_threads" p WHERE p."id" = "tool_calls"."threadId"));

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhook_deliveries"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "webhooks" p WHERE p."id" = "webhook_deliveries"."webhookId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "webhooks" p WHERE p."id" = "webhook_deliveries"."webhookId"));

ALTER TABLE "version_diff_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "version_diff_cache" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "version_diff_cache"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "contracts" p WHERE p."id" = "version_diff_cache"."contractId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "contracts" p WHERE p."id" = "version_diff_cache"."contractId"));

ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_roles"
  USING (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "users" p WHERE p."id" = "user_roles"."userId"))
  WITH CHECK (current_user <> 'clm_tenant_access' OR EXISTS (SELECT 1 FROM "users" p WHERE p."id" = "user_roles"."userId"));

-- The organization itself.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organizations"
  USING (current_user <> 'clm_tenant_access' OR "id" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "id" = clm_current_tenant());

-- Not tenant data: never touched by a tenant query.
ALTER TABLE "marketing_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketing_contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "marketing_contacts"
  USING (current_user <> 'clm_tenant_access' OR false)
  WITH CHECK (current_user <> 'clm_tenant_access' OR false);

ALTER TABLE "collab_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "collab_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "collab_states"
  USING (current_user <> 'clm_tenant_access' OR false)
  WITH CHECK (current_user <> 'clm_tenant_access' OR false);
