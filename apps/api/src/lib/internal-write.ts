/**
 * The request the agent worker sends to save what a job read through this
 * API's own routes (PATCH the contract, POST its clauses, POST the chunk
 * request), as the agents service did when it ran there.
 */
export function internalWriteInit(method: 'PATCH' | 'POST', orgId: string, secret: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      // Only with a body: Fastify refuses an empty JSON body with 400, which
      // is what the bodiless chunk request got, so no analysis finished.
      ...(body !== undefined && { 'content-type': 'application/json' }),
      'x-internal-service': 'agents',
      'x-internal-secret': secret,
      // Y1 — the write runs in the contract's tenant.
      'x-org-id': orgId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}
