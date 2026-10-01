-- docs/41 Parts 17 and 20 — the integration layer (connections, field
-- mappings, sync log, conflicts), OIDC single sign-on and SCIM provisioning.

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "externalOrgId" TEXT,
    "instanceUrl" TEXT,
    "loginUrl" TEXT,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "config" JSONB NOT NULL DEFAULT '{}',
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_field_mappings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "contractType" TEXT,
    "externalObject" TEXT NOT NULL,
    "externalField" TEXT NOT NULL,
    "dlField" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_logs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "externalId" TEXT,
    "contractId" TEXT,
    "requestId" TEXT,
    "event" TEXT,
    "payloadHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "integration_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_conflicts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "externalObject" TEXT NOT NULL,
    "externalField" TEXT NOT NULL,
    "dlField" TEXT NOT NULL,
    "currentValue" JSONB,
    "incomingValue" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_connections" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'oidc',
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedClientSecret" TEXT NOT NULL,
    "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "jitProvisioning" BOOLEAN NOT NULL DEFAULT true,
    "defaultRole" TEXT NOT NULL DEFAULT 'VIEWER',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_tokens" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_groups" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "externalId" TEXT,
    "displayName" TEXT NOT NULL,
    "roleName" TEXT,
    "memberIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_links" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_connections_provider_externalOrgId_idx" ON "integration_connections"("provider", "externalOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_orgId_provider_key" ON "integration_connections"("orgId", "provider");

-- CreateIndex
CREATE INDEX "integration_field_mappings_orgId_provider_contractType_idx" ON "integration_field_mappings"("orgId", "provider", "contractType");

-- CreateIndex
CREATE INDEX "integration_sync_logs_orgId_provider_at_idx" ON "integration_sync_logs"("orgId", "provider", "at");

-- CreateIndex
CREATE INDEX "integration_sync_logs_orgId_status_idx" ON "integration_sync_logs"("orgId", "status");

-- CreateIndex
CREATE INDEX "integration_sync_logs_contractId_idx" ON "integration_sync_logs"("contractId");

-- CreateIndex
CREATE INDEX "integration_conflicts_orgId_status_idx" ON "integration_conflicts"("orgId", "status");

-- CreateIndex
CREATE INDEX "integration_conflicts_contractId_idx" ON "integration_conflicts"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "sso_connections_orgId_key" ON "sso_connections"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "scim_tokens_tokenHash_key" ON "scim_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "scim_tokens_orgId_revokedAt_idx" ON "scim_tokens"("orgId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_orgId_displayName_key" ON "scim_groups"("orgId", "displayName");

-- CreateIndex
CREATE INDEX "identity_links_userId_idx" ON "identity_links"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "identity_links_orgId_provider_subject_key" ON "identity_links"("orgId", "provider", "subject");

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_connections" TO clm_tenant_access;
ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "integration_connections"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_field_mappings" TO clm_tenant_access;
ALTER TABLE "integration_field_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_field_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "integration_field_mappings"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_sync_logs" TO clm_tenant_access;
ALTER TABLE "integration_sync_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_sync_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "integration_sync_logs"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_conflicts" TO clm_tenant_access;
ALTER TABLE "integration_conflicts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_conflicts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "integration_conflicts"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "sso_connections" TO clm_tenant_access;
ALTER TABLE "sso_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sso_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sso_connections"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "scim_tokens" TO clm_tenant_access;
ALTER TABLE "scim_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scim_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scim_tokens"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "scim_groups" TO clm_tenant_access;
ALTER TABLE "scim_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scim_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scim_groups"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "identity_links" TO clm_tenant_access;
ALTER TABLE "identity_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "identity_links"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

