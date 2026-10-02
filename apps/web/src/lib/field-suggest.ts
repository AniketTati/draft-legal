/**
 * docs/39 C3 — what a new field made from a highlight is probably called, and
 * what type its value is: "Purchase Order No.: PO-7781" is a field called
 * "Purchase Order No." holding text; "(the "Launch Date")" after a date names
 * the field; "thirty (30) days" is a length of time.
 */
import { parseDate, parseDuration, type FieldValueType } from '@clm/types'

const UNIT = /\b(days?|weeks?|months?|years?)\b/i
const MONEY = /[$€£¥₹]|\b[A-Z]{3}\s?\d|\d\s?[A-Z]{3}\b/
const PERCENT = /%|\bper\s?cent\b/i

/** The field type the selected words read as. */
export function inferFieldType(text: string): FieldValueType {
  const t = text.replace(/\s+/g, ' ').trim()
  if (/^(yes|no|true|false|y|n)$/i.test(t)) return 'boolean'
  if (t.length > 80) return 'longtext'
  if (PERCENT.test(t) && /\d/.test(t)) return 'percentage'
  if (MONEY.test(t)) return 'currency'
  if (UNIT.test(t) && parseDuration(t)) return 'duration'
  if (parseDate(t)) return 'date'
  if (/^[-+]?\(?[\d.,\s]+\)?$/.test(t) && /\d/.test(t)) return 'number'
  return 'text'
}

// A defined term right after the words: (the "Launch Date"), (hereinafter "Fees").
const DEFINED_AFTER = /^\s*,?\s*\(\s*(?:the\s+|hereinafter\s+(?:the\s+)?|each\s+a\s+)?["“'‘]([^"”'’]{2,48})["”'’]\s*\)/i
// A label right before them: "Purchase Order No.:", "Account number -".
const LABEL_BEFORE = /([A-Z][A-Za-z0-9&'./ ]{1,48}?)\s*[:–—-]\s*$/

/** A name for the field the selected words are the value of, from the words around them; '' when nothing reads as one. */
export function labelFromContext(before = '', after = ''): string {
  const defined = after.match(DEFINED_AFTER)
  if (defined) return defined[1].trim()
  // Only the last line or sentence before the words.
  const tail = before.split(/[\n.;](?=\s|$)/).pop() ?? ''
  const label = tail.match(LABEL_BEFORE)
  if (label) {
    const words = label[1].trim()
    // A whole sentence before a colon isn't a label.
    if (words.split(/\s+/).length <= 6) return words
  }
  return ''
}
