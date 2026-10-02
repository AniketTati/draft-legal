/**
 * HTML sanitization (Wave 2.6, 2026-07).
 *
 * Every `dangerouslySetInnerHTML` sink in the app renders HTML that can
 * originate from an untrusted source — counterparty-uploaded contract text,
 * agent/LLM output, org-authored playbook/template content. Before this,
 * those sinks rendered raw HTML with no sanitization, so one crafted upload
 * could execute script in a legal team's browser (and tokens sat in
 * localStorage). Route every sink through `sanitizeHtml`.
 */
import DOMPurify from 'dompurify'

// Preserve the diff/redline markup (<ins>/<del> + our data-* hooks) and clause
// anchors while DOMPurify strips <script>, event handlers, <iframe>, etc.
const CONFIG = {
  ADD_ATTR: ['data-change-id', 'data-clause-id', 'data-author', 'data-author-id', 'data-time', 'data-color'],
  FORBID_TAGS: ['style', 'form'],
  FORBID_ATTR: ['style'],
}

export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return ''
  // Cast through unknown: with the default config DOMPurify returns a string,
  // but its type union includes TrustedHTML.
  return DOMPurify.sanitize(html, CONFIG) as unknown as string
}
