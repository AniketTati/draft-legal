/**
 * docs/41 Part 17 — a small Salesforce REST client: just the calls the sync
 * needs, over fetch, with the two failure modes Salesforce has that matter:
 *
 *   - 401 (an expired access token, every couple of hours): refresh once with
 *     the stored refresh token and send the call again;
 *   - the org's API limit (429, or 403 `REQUEST_LIMIT_EXCEEDED`): stop and let
 *     the sync queue back off, never spin against the limit.
 *
 * Writes use the Composite sObject collections API (up to 200 records a call)
 * and upsert by our external id `DL_Contract_Id__c`, so a sync sent twice
 * updates the same record instead of making a second one.
 */

export const SALESFORCE_API_VERSION = 'v61.0'
export const CONTRACT_OBJECT = 'DL_Contract__c'
export const CONTRACT_EXTERNAL_ID = 'DL_Contract_Id__c'
const COMPOSITE_LIMIT = 200

type Fetch = typeof fetch

export class SalesforceApiError extends Error {
  constructor(message: string, readonly status: number, readonly errorCode?: string) {
    super(message)
    this.name = 'SalesforceApiError'
  }
  /** Worth another attempt later: a server error or a timeout, not a bad request. */
  get retryable(): boolean { return this.status >= 500 || this.status === 0 }
}

export class SalesforceRateLimitError extends SalesforceApiError {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message, 429, 'REQUEST_LIMIT_EXCEEDED')
    this.name = 'SalesforceRateLimitError'
  }
}

export interface SalesforceClientDeps {
  /** Gets (and stores) a fresh access token; called once on a 401. */
  refresh: () => Promise<string>
  fetch?: Fetch
  timeoutMs?: number
}

export interface UpsertResult { id?: string; success: boolean; created?: boolean; errors?: Array<{ statusCode?: string; message?: string; fields?: string[] }> }

export interface DescribeField {
  name: string
  label: string
  type: string
  updateable: boolean
  createable: boolean
  custom: boolean
  referenceTo?: string[]
  picklistValues?: Array<{ value: string; label: string; active: boolean }>
}

export class SalesforceClient {
  private readonly fetch: Fetch

  constructor(private readonly instanceUrl: string, private accessToken: string, private readonly deps: SalesforceClientDeps) {
    this.fetch = deps.fetch ?? fetch
  }

  private base(): string { return `${this.instanceUrl.replace(/\/$/, '')}/services/data/${SALESFORCE_API_VERSION}` }

  async request<T = unknown>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.deps.timeoutMs ?? 30_000)
    let res: Response
    try {
      res = await this.fetch(`${this.base()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        redirect: 'manual',
      })
    } catch (err) {
      throw new SalesforceApiError(`Salesforce unreachable: ${(err as Error).message}`, 0)
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 401 && !retried) {
      this.accessToken = await this.deps.refresh()
      return this.request<T>(method, path, body, true)
    }
    if (res.status === 204) return null as T

    const text = await res.text()
    let parsed: unknown = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    const first = Array.isArray(parsed) ? parsed[0] as { errorCode?: string; message?: string } | undefined : undefined
    const errorCode = first?.errorCode

    if (res.status === 429 || errorCode === 'REQUEST_LIMIT_EXCEEDED') {
      const after = Number(res.headers.get('retry-after'))
      throw new SalesforceRateLimitError(first?.message ?? 'Salesforce API limit reached', Number.isFinite(after) && after > 0 ? after * 1000 : 60_000)
    }
    if (!res.ok) {
      throw new SalesforceApiError(first?.message ?? `Salesforce answered ${res.status}`, res.status, errorCode)
    }
    return parsed as T
  }

  /**
   * Upsert draftLegal contract records by their external id, 200 a call.
   * One bad record doesn't fail the rest (`allOrNone: false`); each result is
   * returned in the order sent.
   */
  async upsertContracts(records: Array<Record<string, unknown>>): Promise<UpsertResult[]> {
    const results: UpsertResult[] = []
    for (let i = 0; i < records.length; i += COMPOSITE_LIMIT) {
      const chunk = records.slice(i, i + COMPOSITE_LIMIT)
      const r = await this.request<UpsertResult[]>('PATCH', `/composite/sobjects/${CONTRACT_OBJECT}/${CONTRACT_EXTERNAL_ID}`, {
        allOrNone: false,
        records: chunk.map(fields => ({ attributes: { type: CONTRACT_OBJECT }, ...fields })),
      })
      results.push(...(r ?? []))
    }
    return results
  }

  async updateRecord(sobject: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`, fields)
  }

  async describeGlobal(): Promise<Array<{ name: string; label: string; custom: boolean; queryable: boolean; updateable: boolean }>> {
    const r = await this.request<{ sobjects: Array<{ name: string; label: string; custom: boolean; queryable: boolean; updateable: boolean }> }>('GET', '/sobjects')
    return r?.sobjects ?? []
  }

  async describe(sobject: string): Promise<{ name: string; label: string; fields: DescribeField[] }> {
    return this.request('GET', `/sobjects/${encodeURIComponent(sobject)}/describe`)
  }

  /**
   * Upload a file to Salesforce Files and share it on each record in
   * `linkTo` (the contract record, the Opportunity). Returns the
   * ContentDocument id.
   */
  async uploadFile(input: { title: string; fileName: string; data: Buffer; linkTo: string[] }): Promise<string> {
    const [first, ...rest] = input.linkTo
    const created = await this.request<{ id: string }>('POST', '/sobjects/ContentVersion', {
      Title: input.title,
      PathOnClient: input.fileName,
      VersionData: input.data.toString('base64'),
      ...(first ? { FirstPublishLocationId: first } : {}),
    })
    const version = await this.request<{ ContentDocumentId: string }>('GET', `/sobjects/ContentVersion/${encodeURIComponent(created.id)}?fields=ContentDocumentId`)
    for (const entity of rest) {
      await this.request('POST', '/sobjects/ContentDocumentLink', {
        ContentDocumentId: version.ContentDocumentId, LinkedEntityId: entity, ShareType: 'V', Visibility: 'AllUsers',
      }).catch(err => {
        // Already shared there (a re-sync): that's the outcome we wanted.
        if (!(err instanceof SalesforceApiError && err.errorCode === 'DUPLICATE_VALUE')) throw err
      })
    }
    return version.ContentDocumentId
  }
}
