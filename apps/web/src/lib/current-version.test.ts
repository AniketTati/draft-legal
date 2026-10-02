/**
 * DD4 — the contract page shows the version the contract stands on. After
 * "Undo" on an applied redline it showed the newest (undone) version, and an
 * edit saved on top of it brought the undone change back.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentVersionOf } from './current-version'

describe('currentVersionOf', () => {
  const versions = [{ id: 'v5' }, { id: 'v4' }, { id: 'v3' }]   // newest first, as the API lists them
  it('is the version the contract points at, after an undo too', () => {
    expect(currentVersionOf(versions, 'v4')?.id).toBe('v4')
  })
  it('falls back to the newest only without a pointer', () => {
    expect(currentVersionOf(versions, null)?.id).toBe('v5')
    expect(currentVersionOf(versions, 'gone')?.id).toBe('v5')
    expect(currentVersionOf([], 'v4')).toBeNull()
  })
})

describe('the contract page', () => {
  const page = readFileSync(join(__dirname, '..', 'pages', 'ContractDetailPage.tsx'), 'utf8')
  it('shows and edits the current version, and opens its original', () => {
    const styled = page.slice(page.indexOf('// B.5.1 — Styled branch.'), page.indexOf('const rawHtml ='))
    expect(styled).toContain('currentVersionOf(contract.versions')
    const original = page.slice(page.indexOf('const hasOriginal ='), page.indexOf('const originalNotPdf ='))
    expect(original).not.toContain('versions[0]')
  })

  it('compares in the workspace, from the review\'s baseline by default (docs/41 Part 15)', () => {
    expect(page).toContain('workspacePath(id!, { changes: true })')
    expect(page).not.toContain('<RedlinePanel')
    const changes = readFileSync(join(__dirname, '../components/contracts/workspace/ChangesView.tsx'), 'utf8')
    expect(changes).toContain("params: baseline ? { baseline } : {}")
  })

  it('keeps the review drawer on its clause across a new version, and shows a mark the server moved there', () => {
    expect(page).toContain('focusedPlaceRef')
    const mark = page.slice(page.indexOf('const updateReviewState = useMutation({'), page.indexOf('const focusedPlaceRef'))
    expect(mark).toMatch(/requestedId[\s\S]*invalidateQueries\(\{ queryKey: \['contract-clauses', id\] \}\)/)
  })
})
