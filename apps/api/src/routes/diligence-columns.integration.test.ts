/**
 * docs/39 D6 — a diligence room's own columns: a question asked of every
 * document (each answer with the words it came from), or any field the
 * contracts hold (the documents without it read for it, and undone); a
 * person's answer or confirmation never asked over; a spent budget pausing
 * the run where it stopped; a document read later asked on its own; a
 * reworded question asked again (a stale run stopping); and the export
 * carrying every column with its sources.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'

// Kept off the shared Redis queue, which the dev API's workers also consume.
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueAnswerDiligenceColumn: vi.fn(),
  queueAnswerDiligenceDocument: vi.fn(),
  queueEmbedContract: vi.fn(),
}))
vi.mock('../lib/elasticsearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/elasticsearch.js')>()),
  reindexContract: vi.fn(async () => {}),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { queueAnswerDiligenceColumn } from '../lib/queue.js'
import { answerColumn, answerDocument, questionKey, type AskFields, type ExtractedAnswer } from '../lib/diligence-columns.js'
import { applyExtraction } from '../lib/field-store.js'
import { CostCapExceededError } from '../lib/costCap.js'

let app: TestApp
let org: string, owner: string, room: string, otherRoom: string, editor: string
const docs: Record<string, string> = {}

const admin = () => auth(org, ['ADMIN'], owner)
const url = (path = '') => `/api/v1/diligence/${room}${path}`

const TEXT = {
  msa: 'MASTER SERVICES AGREEMENT. 12. Assignment. Neither party may assign this Agreement without the prior written consent of the other party. 14. This Agreement is governed by the laws of the State of Delaware.',
  supply: 'SUPPLY AGREEMENT. 9. Assignment. Supplier may assign this Agreement to an affiliate without consent. 10. Payment within 30 days.',
}

/** Analysed a while ago: a document read moments ago is being asked on its own (JUST_READ_MS). */
const settled = () => prisma.contract.updateMany({ where: { diligenceRoomId: room }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } })

async function doc(name: string, text: string, status = 'DONE') {
  const id = await makeContract(org, owner, { title: name, type: 'MSA' })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: text } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: status, diligenceRoomId: room } })
  docs[name] = id
  await settled()
  return id
}

/** The agents service, as a stand-in: answers the assignment question from the words, and reads governing law. */
function fakeAsk(opts: { capAfter?: number; flip?: boolean } = {}): AskFields & { asked: string[] } {
  const asked: string[] = []
  const ask = (async ({ contractId, body }) => {
    if (opts.capAfter !== undefined && asked.length >= opts.capAfter) throw new CostCapExceededError(org, 5, 5, 'block')
    asked.push(contractId)
    const out: Record<string, ExtractedAnswer> = {}
    for (const f of body.fields as Array<{ fieldKey: string; question?: string }>) {
      if (f.question) {
        const text = body.plainText
        if (text.includes('Supplier may assign')) out[f.fieldKey] = { value: opts.flip ? 'no' : true, confidence: 0.9, quote: 'Supplier may assign this Agreement to an affiliate without consent.' }
        else if (text.includes('Neither party may assign')) out[f.fieldKey] = { value: opts.flip ? 'yes' : false, confidence: 0.85, quote: 'Neither party may assign this Agreement without the prior written consent of the other party.' }
      } else if (f.fieldKey === 'governingLaw' && body.plainText.includes('laws of the State of New York')) {
        out.governingLaw = { value: 'New York', confidence: 0.8, quote: 'governed by the laws of the State of New York' }
      }
    }
    return out
  }) as AskFields & { asked: string[] }
  ask.asked = asked
  return ask
}

const results = async () => (await app.inject({ method: 'GET', url: url('/results'), headers: admin() })).json() as {
  data: Array<{ id: string; cells: Record<string, { state: string; display: string; quote: string | null; confidence: number | null; source: string | null; checked: boolean; error: string | null; issue: string | null }> }>
  columns: Array<{ id: string; label: string; kind: string; run: { status: string; cursor: string | null; token: string; processed: number; answered: number } | null; counts: Record<string, number> }>
}
const cell = (r: Awaited<ReturnType<typeof results>>, name: string, columnId: string) => r.data.find(d => d.id === docs[name])!.cells[columnId]
const column = async (columnId: string) => (await results()).columns.find(c => c.id === columnId)!
const tokenOf = async (columnId: string) => (await column(columnId)).run!.token

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Diligence Columns Org')
  owner = await makeUser(org)
  room = (await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Project Falcon', createdById: owner } })).id
  otherRoom = (await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Someone else’s room', createdById: await makeUser(org) } })).id
  // Own-scope write access (no default role has it): made before any request, as roles are cached.
  editor = await makeUser(org)
  await prisma.role.create({ data: { orgId: org, name: 'OWN_ROOM_EDITOR', permissions: [
    { action: 'view', resource: 'contract', scope: 'own' }, { action: 'edit', resource: 'contract', scope: 'own' },
  ] } })
  await doc('Falcon MSA', TEXT.msa)
  await doc('Falcon Supply', TEXT.supply)
  await doc('Falcon Lease', '', 'EXTRACTING')
})

beforeEach(() => vi.mocked(queueAnswerDiligenceColumn).mockClear())

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('a question column', () => {
  let q: string

  it('is added, asked of every document read so far, each cell with its answer and the words it rests on', async () => {
    const r = await app.inject({ method: 'POST', url: url('/columns'), headers: admin(), payload: {
      kind: 'question', question: 'Can the supplier assign the agreement without the customer’s consent?', answerType: 'boolean',
    } })
    expect(r.statusCode).toBe(201)
    const col = r.json().column
    q = col.id
    expect(col).toMatchObject({ kind: 'question', answerType: 'boolean', run: { status: 'QUEUED', scope: 'missing' } })
    expect(col.label).toBe('Can supplier assign agreement without customer’s…')
    expect(queueAnswerDiligenceColumn).toHaveBeenCalledWith({ orgId: org, roomId: room, columnId: q, token: col.run.token })

    const ask = fakeAsk()
    const run = await answerColumn({ orgId: org, roomId: room, columnId: q, token: col.run.token }, ask)
    expect(run).toMatchObject({ status: 'DONE', processed: 2, answered: 2, failed: 0 })
    expect(ask.asked.sort()).toEqual([docs['Falcon MSA'], docs['Falcon Supply']].sort())

    const t = await results()
    expect(cell(t, 'Falcon MSA', q)).toMatchObject({ state: 'answered', display: 'No', confidence: 0.85, source: 'ai', checked: false })
    expect(cell(t, 'Falcon MSA', q).quote).toContain('Neither party may assign')
    expect(cell(t, 'Falcon Supply', q)).toMatchObject({ state: 'answered', display: 'Yes' })
    // Still being read: asked when it is.
    expect(cell(t, 'Falcon Lease', q).state).toBe('waiting')
    expect(t.columns.find(c => c.id === q)!.counts).toMatchObject({ answered: 2, waiting: 1 })
  })

  it('is asked of a document read later, and again when it has a new version', async () => {
    const lease = docs['Falcon Lease']
    const v = await prisma.contractVersion.findFirstOrThrow({ where: { contractId: lease } })
    await prisma.contractVersion.update({ where: { id: v.id }, data: { plainText: 'LEASE. 20. Tenant may not assign this lease. Neither party may assign this Agreement without the prior written consent of the other party.' } })
    await prisma.contract.update({ where: { id: lease }, data: { analysisStatus: 'DONE' } })
    // Just read, it's about to be asked on its own: said so, not "not asked yet".
    expect(cell(await results(), 'Falcon Lease', q).state).toBe('asking')
    const ask = fakeAsk()
    expect(await answerDocument({ orgId: org, contractId: lease }, ask)).toBe(1)
    expect(cell(await results(), 'Falcon Lease', q)).toMatchObject({ state: 'answered', display: 'No' })
    // Read from this version already: not asked again.
    expect(await answerDocument({ orgId: org, contractId: lease }, ask)).toBe(0)
    // A new version: asked of the words it has now.
    const v2 = await prisma.contractVersion.create({ data: { contractId: lease, versionNumber: 2, createdById: owner, plainText: 'LEASE v2. Supplier may assign this Agreement to an affiliate without consent.', createdAt: new Date(Date.now() + 1000) } })
    await prisma.contract.update({ where: { id: lease }, data: { currentVersionId: v2.id } })
    expect(await answerDocument({ orgId: org, contractId: lease }, ask)).toBe(1)
    expect(cell(await results(), 'Falcon Lease', q).display).toBe('Yes')
  })

  it('keeps a person’s answer and a confirmed one when asked again; the AI’s are asked over', async () => {
    const put = await app.inject({ method: 'PUT', url: url(`/columns/${q}/cells/${docs['Falcon MSA']}`), headers: admin(), payload: { value: 'yes' } })
    expect(put.statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: url(`/columns/${q}/cells/${docs['Falcon MSA']}`), headers: admin(), payload: { value: 'perhaps' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: url(`/columns/${q}/cells/${docs['Falcon Supply']}/check`), headers: admin(), payload: { checked: true } })).statusCode).toBe(200)
    let t = await results()
    expect(cell(t, 'Falcon MSA', q)).toMatchObject({ display: 'Yes', source: 'user', checked: true, quote: null })
    expect(cell(t, 'Falcon Supply', q)).toMatchObject({ display: 'Yes', checked: true })

    const again = await app.inject({ method: 'POST', url: url(`/columns/${q}/run`), headers: admin(), payload: { scope: 'all' } })
    expect(again.statusCode).toBe(202)
    // Already under way: not twice.
    expect((await app.inject({ method: 'POST', url: url(`/columns/${q}/run`), headers: admin(), payload: { scope: 'all' } })).statusCode).toBe(409)
    const ask = fakeAsk({ flip: true })
    await answerColumn({ orgId: org, roomId: room, columnId: q, token: again.json().run.token }, ask)
    expect(ask.asked).toEqual([docs['Falcon Lease']])
    t = await results()
    expect(cell(t, 'Falcon MSA', q)).toMatchObject({ display: 'Yes', source: 'user' })
    expect(cell(t, 'Falcon Supply', q)).toMatchObject({ display: 'Yes', checked: true })
    expect(cell(t, 'Falcon Lease', q)).toMatchObject({ display: 'No', source: 'ai' })
  })

  it('pauses where a spent AI budget stops it, and carries on from there when asked', async () => {
    const r = await app.inject({ method: 'POST', url: url('/columns'), headers: admin(), payload: {
      kind: 'question', question: 'Is assignment to an affiliate allowed?', label: 'Affiliate assignment', answerType: 'select', options: ['Allowed', 'Needs consent', 'Allowed', 'Not stated'],
    } })
    expect(r.statusCode).toBe(201)
    const col = r.json().column
    expect(col.options).toEqual(['Allowed', 'Needs consent', 'Not stated'])
    await settled()
    const first = await answerColumn({ orgId: org, roomId: room, columnId: col.id, token: col.run.token }, fakeAsk({ capAfter: 1 }))
    expect(first).toMatchObject({ status: 'PAUSED', processed: 1 })
    expect(first!.error).toContain('budget')
    let t = await results()
    const view = t.columns.find(c => c.id === col.id)!
    expect(view.run!.status).toBe('PAUSED')
    expect(view.counts.unasked).toBe(2)

    const resume = await app.inject({ method: 'POST', url: url(`/columns/${col.id}/run`), headers: admin(), payload: { scope: 'missing' } })
    expect(resume.statusCode).toBe(202)
    expect(resume.json().run).toMatchObject({ status: 'QUEUED', processed: 1, cursor: first!.cursor })
    const ask = fakeAsk()
    const done = await answerColumn({ orgId: org, roomId: room, columnId: col.id, token: resume.json().run.token }, ask)
    expect(done).toMatchObject({ status: 'DONE', processed: 3 })
    expect(ask.asked).toHaveLength(2)
    t = await results()
    expect(t.columns.find(c => c.id === col.id)!.counts.unasked).toBe(0)
    // "true" isn't one of the choices: kept as the AI said it, doubted.
    const odd = cell(t, 'Falcon Supply', col.id)
    expect(odd).toMatchObject({ state: 'answered', display: 'true' })
    expect(odd.issue).toContain('isn\'t one of the choices')
    expect(odd.confidence!).toBeLessThanOrEqual(0.4)
  })

  it('reworded, is asked again (a person’s answers kept) and a run asking the old wording stops', async () => {
    const before = await tokenOf(q)
    const r = await app.inject({ method: 'PATCH', url: url(`/columns/${q}`), headers: admin(), payload: { question: 'Can either party assign without consent?' } })
    expect(r.json()).toEqual({ ok: true, asked: true })
    const after = await tokenOf(q)
    expect(after).not.toBe(before)
    expect(queueAnswerDiligenceColumn).toHaveBeenCalledWith({ orgId: org, roomId: room, columnId: q, token: after })
    // The AI's answers to the old question are gone; the person's stays.
    expect(await prisma.diligenceCell.count({ where: { roomId: room, columnId: q } })).toBe(2)

    const stale = fakeAsk()
    expect(await answerColumn({ orgId: org, roomId: room, columnId: q, token: before }, stale)).toBeNull()
    expect(stale.asked).toEqual([])
    const ask = fakeAsk()
    await answerColumn({ orgId: org, roomId: room, columnId: q, token: after }, ask)
    expect(ask.asked).toEqual([docs['Falcon Lease']])

    // A new form of answer: every answer goes, a person's too.
    expect((await app.inject({ method: 'PATCH', url: url(`/columns/${q}`), headers: admin(), payload: { answerType: 'text', label: 'Assignment' } })).json().asked).toBe(true)
    expect(await prisma.diligenceCell.count({ where: { roomId: room, columnId: q } })).toBe(0)
    expect((await column(q)).label).toBe('Assignment')
  })

  it('is refused when it is malformed, and to someone who can only view', async () => {
    const add = (payload: object, headers = admin()) => app.inject({ method: 'POST', url: url('/columns'), headers, payload })
    expect((await add({ kind: 'question', question: 'Which region?', answerType: 'select', options: ['EMEA'] })).statusCode).toBe(400)
    expect((await add({ kind: 'question', question: 'Which region?', answerType: 'colour' })).statusCode).toBe(400)
    expect((await add({ kind: 'question', question: 'Is it assignable?', answerType: 'boolean' }, auth(org, ['VIEWER'], owner))).statusCode).toBe(403)
    expect((await add({ kind: 'field', key: 'no_such_field' })).statusCode).toBe(422)
  })
})

describe('a field column', () => {
  let f: string

  it('shows the field’s values with their words; the documents without one are read for it, and can be undone', async () => {
    await applyExtraction(docs['Falcon MSA'], [{ key: 'governingLaw', kind: 'core', value: 'Delaware', confidence: 0.9, quote: 'governed by the laws of the State of Delaware' }], { mode: 'replace_ai' })
    const r = await app.inject({ method: 'POST', url: url('/columns'), headers: admin(), payload: { kind: 'field', key: 'governingLaw' } })
    expect(r.statusCode).toBe(201)
    f = r.json().column.id
    expect(r.json().column).toMatchObject({ kind: 'field', key: 'governingLaw', label: 'Governing law', run: null })
    // Nothing to ask: the values are the contracts'.
    expect(queueAnswerDiligenceColumn).not.toHaveBeenCalled()
    expect((await app.inject({ method: 'POST', url: url('/columns'), headers: admin(), payload: { kind: 'field', key: 'governingLaw' } })).statusCode).toBe(409)

    let t = await results()
    expect(cell(t, 'Falcon MSA', f)).toMatchObject({ state: 'answered', display: 'Delaware', source: 'ai' })
    expect(cell(t, 'Falcon MSA', f).quote).toContain('State of Delaware')
    expect(cell(t, 'Falcon Supply', f).state).toBe('none')

    // Asking again over every value is a question's; a field only fills the empty ones.
    expect((await app.inject({ method: 'POST', url: url(`/columns/${f}/run`), headers: admin(), payload: { scope: 'all' } })).statusCode).toBe(400)
    const supply = await prisma.contractVersion.findFirstOrThrow({ where: { contractId: docs['Falcon Supply'] } })
    await prisma.contractVersion.update({ where: { id: supply.id }, data: { plainText: `${TEXT.supply} 11. This Agreement is governed by the laws of the State of New York.` } })
    const run = await app.inject({ method: 'POST', url: url(`/columns/${f}/run`), headers: admin(), payload: { scope: 'missing' } })
    expect(run.statusCode).toBe(202)
    const ask = fakeAsk()
    const done = await answerColumn({ orgId: org, roomId: room, columnId: f, token: run.json().run.token }, ask)
    expect(done).toMatchObject({ status: 'DONE', answered: 1 })
    expect(ask.asked).not.toContain(docs['Falcon MSA'])
    t = await results()
    expect(cell(t, 'Falcon Supply', f)).toMatchObject({ state: 'answered', display: 'New York', source: 'ai' })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: docs['Falcon Supply'] } })).jurisdiction).toBe('New York')

    // Confirmed from the room, as the Fields panel confirms it.
    expect((await app.inject({ method: 'POST', url: url(`/columns/${f}/cells/${docs['Falcon MSA']}/check`), headers: admin(), payload: { checked: true } })).statusCode).toBe(200)
    expect(cell(await results(), 'Falcon MSA', f).checked).toBe(true)
    // A field's value is set on the contract, not in the room.
    expect((await app.inject({ method: 'PUT', url: url(`/columns/${f}/cells/${docs['Falcon MSA']}`), headers: admin(), payload: { value: 'Texas' } })).statusCode).toBe(400)

    const undo = await app.inject({ method: 'POST', url: url(`/columns/${f}/undo`), headers: admin() })
    expect(undo.json()).toMatchObject({ restored: 1 })
    expect(cell(await results(), 'Falcon Supply', f).state).toBe('none')
    expect((await app.inject({ method: 'POST', url: url(`/columns/${f}/undo`), headers: admin() })).statusCode).toBe(409)
  })
})

describe('the room’s columns', () => {
  it('go into the export, each answer beside the words it came from', async () => {
    const q = (await app.inject({ method: 'POST', url: url('/columns'), headers: admin(), payload: {
      kind: 'question', question: 'Who may assign?', label: 'Who assigns', answerType: 'text',
    } })).json().column
    await prisma.diligenceCell.create({ data: {
      orgId: org, roomId: room, columnId: q.id, contractId: docs['Falcon MSA'], value: '=HYPERLINK("x")', display: '=HYPERLINK("x")', quote: 'Neither party may assign', confidence: 0.8,
    } })
    const r = await app.inject({ method: 'GET', url: url('/export?format=csv'), headers: admin() })
    expect(r.statusCode).toBe(200)
    const [header, ...rows] = r.body.split('\n')
    expect(header).toContain('Governing law,Governing law (source)')
    expect(header).toContain('Who assigns,Who assigns (source)')
    const msa = rows.find(l => l.startsWith('Falcon MSA'))!
    expect(msa).toContain('Delaware')
    // A spreadsheet reads it as text, not a formula.
    expect(msa).toContain(`"'=HYPERLINK(""x"")",Neither party may assign`)
    // Its run is queued: said so, not left blank.
    expect(rows.find(l => l.startsWith('Falcon Supply'))).toContain('Being asked')
    // Quotes are carried as a passage, not a whole clause.
    await prisma.diligenceCell.update({ where: { roomId_columnId_contractId: { roomId: room, columnId: q.id, contractId: docs['Falcon MSA'] } }, data: { quote: 'x'.repeat(900) } })
    expect(cell(await results(), 'Falcon MSA', q.id).quote).toHaveLength(601)
  })

  it('are removed with their answers', async () => {
    const t = await results()
    const q = t.columns.find(c => c.label === 'Who assigns')!
    expect((await app.inject({ method: 'DELETE', url: url(`/columns/${q.id}`), headers: admin() })).statusCode).toBe(204)
    expect(await prisma.diligenceCell.count({ where: { roomId: room, columnId: q.id } })).toBe(0)
    expect((await results()).columns.map(c => c.id)).not.toContain(q.id)
    expect((await app.inject({ method: 'DELETE', url: url(`/columns/${q.id}`), headers: admin() })).statusCode).toBe(404)
  })

  it('stop at twenty, and a question key is a field key the agents service can use', async () => {
    const have = (await results()).columns.length
    for (let i = have; i < 20; i++) {
      expect((await app.inject({ method: 'POST', url: url('/columns'), headers: admin(), payload: { kind: 'question', question: `Question number ${i}?`, answerType: 'text' } })).statusCode).toBe(201)
    }
    const r = await app.inject({ method: 'POST', url: url('/columns'), headers: admin(), payload: { kind: 'question', question: 'One too many?', answerType: 'text' } })
    expect(r.statusCode).toBe(422)
    expect(r.json().detail).toContain('up to 20')
    expect(questionKey('col_1a2b-3c')).toBe('question_col1a2b3c')
  })

  it('of a room someone else made are out of reach of an own-scope editor', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/diligence/${otherRoom}/columns`, headers: auth(org, ['OWN_ROOM_EDITOR'], editor), payload: {
      kind: 'question', question: 'Is it assignable?', answerType: 'boolean',
    } })
    expect(r.statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/diligence/${otherRoom}/ask-estimate`, headers: auth(org, ['OWN_ROOM_EDITOR'], editor) })).statusCode).toBe(404)
    const mine = await app.inject({ method: 'GET', url: url('/ask-estimate'), headers: admin() })
    expect(mine.json()).toMatchObject({ documents: 3 })
  })
})
