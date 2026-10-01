/**
 * docs/41 Part 20 — sample deliveries for REST-hook subscribers (Zapier's
 * trigger test step), one per webhook event, in the envelope the webhook
 * worker sends (workers/webhook.worker.ts): { event, timestamp, data }.
 * Each `data` matches what the emitting route passes to fireWebhook.
 */

/** A sample of each event's `data`, as the webhook worker delivers it. */
export const SAMPLE_DATA: Record<string, Record<string, unknown>> = {
  'contract.created':     { contractId: 'cmb1example0contract', title: 'Mutual NDA — Acme Corp', type: 'NDA', status: 'DRAFT', counterpartyName: 'Acme Corp' },
  'contract.uploaded':    { contractId: 'cmb1example0contract', title: 'Master Services Agreement', filename: 'msa.pdf', mimeType: 'application/pdf', fileSize: 248113 },
  'contract.updated':     { contractId: 'cmb1example0contract', title: 'Mutual NDA — Acme Corp', status: 'UNDER_NEGOTIATION', changes: ['status'], source: 'user' },
  'contract.executed':    { contractId: 'cmb1example0contract', executedAt: '2026-10-01T14:03:00.000Z' },
  'signature.sent':       { contractId: 'cmb1example0contract', signatureRequestId: 'cmb1example0sigreq', signerCount: 2, signOrder: 'parallel', expiresAt: '2026-10-31T00:00:00.000Z' },
  'signature.completed':  { contractId: 'cmb1example0contract', signatureRequestId: 'cmb1example0sigreq', signerCount: 2, completedAt: '2026-10-01T14:03:00.000Z' },
  'signature.voided':     { contractId: 'cmb1example0contract', signatureRequestId: 'cmb1example0sigreq', reason: 'Jane Doe declined: wrong entity' },
  'approval.submitted':   { contractId: 'cmb1example0contract', title: 'Order Form — Acme Corp', type: 'ORDER_FORM', value: 45000, currency: 'USD', instanceId: 'cmb1example0approval', stepId: 'cmb1example0step', stepName: 'Legal review', approverId: 'cmb1example0user' },
  'approval.decided':     { instanceId: 'cmb1example0approval', contractId: 'cmb1example0contract', stepId: 'cmb1example0step', decision: 'APPROVED', instanceStatus: 'APPROVED', decidedBy: 'cmb1example0user' },
  'obligation.extracted': { contractId: 'cmb1example0contract', count: 4 },
  'obligation.completed': { obligationId: 'cmb1example0obligation', contractId: 'cmb1example0contract', type: 'PAYMENT', completedAt: '2026-10-01T09:00:00.000Z', hasEvidence: true },
  'obligation.overdue':   { contractId: 'cmb1example0contract', obligationId: 'cmb1example0obligation', description: 'Deliver the quarterly security report', dueDate: '2026-09-30', daysOverdue: 1 },
  'invoice.created':      { invoiceId: 'cmb1example0invoice', contractId: 'cmb1example0contract', vendorName: 'Acme Corp', amount: 12000, currency: 'USD', status: 'PENDING' },
  'invoice.reconciled':   { invoiceId: 'cmb1example0invoice', contractId: 'cmb1example0contract', obligationId: 'cmb1example0obligation', reconciledAt: '2026-10-01T09:00:00.000Z' },
  'amendment.created':    { contractId: 'cmb1example0amendment', parentContractId: 'cmb1example0contract', relationshipType: 'amendment', title: 'Amendment No. 1', type: 'AMENDMENT' },
}

/** The envelope a delivery carries (workers/webhook.worker.ts), around a sample. */
export function hookSample(event: string): Record<string, unknown> | null {
  const data = SAMPLE_DATA[event]
  return data ? { id: `sample-${event}`, event, timestamp: '2026-10-01T14:03:00.000Z', data } : null
}

