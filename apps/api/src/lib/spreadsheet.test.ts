/**
 * docs/39 A16 — a spreadsheet read as text rows: a CSV whatever it was saved
 * with, an Excel workbook's first sheet with its dates as dates.
 */
import { describe, it, expect } from 'vitest'
import { readSpreadsheet, delimiterOf, IMPORT_MAX_ROWS } from './spreadsheet.js'
import { buildXlsx } from '../test-support/xlsx.js'

const csv = (s: string) => Buffer.from(s, 'utf8')

describe('a CSV', () => {
  it('is read with the separator it was saved with', async () => {
    expect(delimiterOf('title;value;"a, b"\n1;2;3')).toBe(';')
    expect(delimiterOf('title\tvalue\n')).toBe('\t')
    expect(delimiterOf('title,"x;y;z",value\n')).toBe(',')
    const r = await readSpreadsheet(csv('﻿Title;Counterparty;Value\r\nAcme MSA;"Acme; Inc.";250000\r\n'))
    expect(r).toEqual({ ok: true, headers: ['Title', 'Counterparty', 'Value'], rows: [['Acme MSA', 'Acme; Inc.', '250000']], total: 1 })
  })

  it('leaves out empty rows and columns, and names a column that has data but no header', async () => {
    const r = await readSpreadsheet(csv('Title,,Value,\n\nAcme,, 1 ,\n,,,\nGlobex,x,2,\n'))
    expect(r).toMatchObject({ ok: true, headers: ['Title', 'Column B', 'Value'], rows: [['Acme', '', '1'], ['Globex', 'x', '2']] })
  })

  it('in UTF-16 (Excel’s Unicode text) reads too', async () => {
    const text = 'Title\tCounterparty\nZürich Lease\tSociété Générale\n'
    const r = await readSpreadsheet(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    expect(r).toMatchObject({ ok: true, headers: ['Title', 'Counterparty'], rows: [['Zürich Lease', 'Société Générale']] })
  })

  it('is refused when it isn’t one, or has nothing under its header', async () => {
    expect(await readSpreadsheet(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toMatchObject({ ok: false, detail: expect.stringContaining('.xls') })
    expect(await readSpreadsheet(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))).toMatchObject({ ok: false })
    expect(await readSpreadsheet(csv('Title\n'))).toMatchObject({ ok: false, detail: expect.stringContaining('header row') })
  })

  it('says how many rows it has past the most one import reads', async () => {
    const r = await readSpreadsheet(csv(`Title\n${Array.from({ length: IMPORT_MAX_ROWS + 5 }, (_, i) => `C${i}`).join('\n')}\n`))
    expect(r).toMatchObject({ ok: true, total: IMPORT_MAX_ROWS + 5 })
    expect(r.ok && r.rows.length).toBe(IMPORT_MAX_ROWS)
  })
})

describe('an Excel workbook', () => {
  it('is read from its first sheet: text, numbers, dates as dates, yes/no, strings kept in the cell', async () => {
    const file = await buildXlsx([
      ['Contract', 'Vendor', 'Start date', 'Value', 'Auto renew', 'Notes'],
      ['Acme MSA', 'Acme & Sons <UK>', { date: '2024-03-01' }, 250000, true, { inline: 'first' }],
      ['Globex SOW', null, { date: '2025-12-31' }, 1250.5, false, 'second'],
    ], { sheetName: 'Contracts 2024' })
    const r = await readSpreadsheet(file)
    expect(r).toEqual({
      ok: true, sheetName: 'Contracts 2024', total: 2,
      headers: ['Contract', 'Vendor', 'Start date', 'Value', 'Auto renew', 'Notes'],
      rows: [
        ['Acme MSA', 'Acme & Sons <UK>', '2024-03-01', '250000', 'TRUE', 'first'],
        ['Globex SOW', '', '2025-12-31', '1250.5', 'FALSE', 'second'],
      ],
    })
  })

  it('starting lower down the sheet, starts at its first row with anything in it', async () => {
    const r = await readSpreadsheet(await buildXlsx([['Title', 'Type'], ['Initech NDA', 'NDA']], { startRow: 4 }))
    expect(r).toMatchObject({ ok: true, headers: ['Title', 'Type'], rows: [['Initech NDA', 'NDA']] })
  })

  it('that isn’t a workbook (a Word file is a zip too) is refused', async () => {
    const JSZip = (await import('jszip')).default
    const docx = await new JSZip().file('word/document.xml', '<w:document/>').generateAsync({ type: 'nodebuffer' })
    expect(await readSpreadsheet(docx)).toMatchObject({ ok: false, detail: expect.stringContaining('Excel workbook') })
  })
})
