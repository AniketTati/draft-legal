// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) } }))
const success = vi.fn()
const error = vi.fn()
vi.mock('@/components/common/Toaster', () => ({ toast: { success: (...a: unknown[]) => success(...a), error: (...a: unknown[]) => error(...a) } }))
const download = vi.fn()
vi.mock('./GoogleDocsEdit', () => ({ downloadForCounterparty: (...a: unknown[]) => download(...a) }))

import { followUpSend } from './sendAfterSave'
import type { SaveVersionResult } from '@/lib/working-copy'

const result = (send: SaveVersionResult['send']): SaveVersionResult => ({
  version: { id: 'v9', versionNumber: 3 }, created: true, approvals: 'rules', send, contract: null,
})

describe('followUpSend (Save and send)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('downloads the Word file and says so when the page has no banner', async () => {
    download.mockResolvedValue({ name: 'msa.docx', stats: { verified: true } })
    await followUpSend('c1', result({ method: 'word', ok: true }))
    expect(download).toHaveBeenCalledWith('c1')
    expect(success).toHaveBeenCalledWith('Downloaded msa.docx', expect.anything())
  })

  it('hands the Word notice to the page banner when it has one', async () => {
    download.mockResolvedValue({ name: 'msa.docx', stats: null })
    const onRedline = vi.fn()
    await followUpSend('c1', result({ method: 'word', ok: true }), { onRedline })
    expect(onRedline).toHaveBeenCalledWith({ name: 'msa.docx', stats: null })
    expect(success).not.toHaveBeenCalled()
  })

  it('shows why the Word file could not be made', async () => {
    download.mockResolvedValue({ name: '', stats: null, error: 'Their file is missing.' })
    await followUpSend('c1', result({ method: 'word', ok: true }))
    expect(error).toHaveBeenCalledWith('The Word file could not be made', expect.objectContaining({ description: 'Their file is missing.' }))
  })

  it('opens the PDF of the saved version', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    get.mockResolvedValue({ data: { url: 'https://files/x.pdf' } })
    await followUpSend('c1', result({ method: 'pdf', ok: true }))
    expect(get).toHaveBeenCalledWith('/contracts/c1/download', { params: { versionId: 'v9' } })
    expect(open).toHaveBeenCalledWith('https://files/x.pdf', '_blank', 'noopener')
  })

  it('says when the PDF could not be downloaded', async () => {
    get.mockRejectedValue(new Error('boom'))
    await followUpSend('c1', result({ method: 'pdf', ok: true }))
    expect(error).toHaveBeenCalledWith('The PDF could not be downloaded', expect.anything())
  })

  it('says a failed send failed, with the server reason', async () => {
    await followUpSend('c1', result({ method: 'share_link', ok: false, detail: 'You may not share this contract.' }))
    expect(error).toHaveBeenCalledWith('Saved as v3, but not sent', expect.objectContaining({ description: 'You may not share this contract.' }))
    expect(download).not.toHaveBeenCalled()
  })
})
