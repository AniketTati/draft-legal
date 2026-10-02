/**
 * docs/41 Part 20 — an org's connection to an outside system, shared by every
 * integration: its status, the outside org it is bound to, and its tokens.
 *
 * Tokens are encrypted at rest with the BYOK key helper (lib/encryption.ts,
 * AI_KEY_ENCRYPTION_KEY) and never leave this module in a route's response:
 * `publicConnection` is what the admin page sees.
 */
import type { IntegrationConnection } from '@prisma/client'
import { prisma } from '../prisma.js'
import { encrypt, decrypt } from '../encryption.js'

export type IntegrationProvider = 'salesforce'
export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = ['salesforce']

export async function getConnection(orgId: string, provider: IntegrationProvider): Promise<IntegrationConnection | null> {
  return prisma.integrationConnection.findFirst({ where: { orgId, provider } })
}

/** A connected connection, or null when there is none or it's disconnected. */
export async function liveConnection(orgId: string, provider: IntegrationProvider): Promise<IntegrationConnection | null> {
  const c = await getConnection(orgId, provider)
  return c && (c.status === 'connected' || c.status === 'error') && c.encryptedRefreshToken ? c : null
}

export interface ConnectionTokens {
  accessToken: string | null
  refreshToken: string | null
}

export function connectionTokens(c: Pick<IntegrationConnection, 'encryptedAccessToken' | 'encryptedRefreshToken'>): ConnectionTokens {
  return {
    accessToken:  c.encryptedAccessToken ? decrypt(c.encryptedAccessToken) : null,
    refreshToken: c.encryptedRefreshToken ? decrypt(c.encryptedRefreshToken) : null,
  }
}

/** Store fresh tokens (a refresh token only when the provider sent a new one). */
export async function storeTokens(connectionId: string, orgId: string, tokens: { accessToken: string; refreshToken?: string | null; expiresAt?: Date | null }): Promise<void> {
  await prisma.integrationConnection.updateMany({
    where: { id: connectionId, orgId },
    data: {
      encryptedAccessToken: encrypt(tokens.accessToken),
      ...(tokens.refreshToken ? { encryptedRefreshToken: encrypt(tokens.refreshToken) } : {}),
      ...(tokens.expiresAt !== undefined ? { tokenExpiresAt: tokens.expiresAt } : {}),
    },
  })
}

/** What the admin page may see of a connection: no token, ever. */
export function publicConnection(c: IntegrationConnection | null) {
  if (!c) return { connected: false as const, status: 'disconnected' }
  return {
    connected:     c.status === 'connected' || c.status === 'error',
    status:        c.status,
    provider:      c.provider,
    externalOrgId: c.externalOrgId,
    instanceUrl:   c.instanceUrl,
    loginUrl:      c.loginUrl,
    connectedAt:   c.connectedAt,
    connectedById: c.connectedById,
    lastSyncAt:    c.lastSyncAt,
    lastError:     c.lastError,
    config:        c.config,
  }
}
