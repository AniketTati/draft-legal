/** The analytics charts' palette and tooltip styles, shared by the Analytics page and its decision sections. */

/*
 * Recharts paints with literal colors, not classes, so the palette has to be
 * restated as hex. Every value below is a stop from tailwind.config.ts — a bar
 * on this page carries exactly the same five meanings as a pill anywhere else,
 * so a reader who has learned the colors once does not relearn them here.
 */
export const PAINT = {
  brand:     '#047857', // brand-700  — binding: approved, executed
  info:      '#2563EB', // info-600   — in flight: someone else's turn
  attention: '#CC7005', // attention-600 — your turn
  risk:      '#DC2626', // risk-600   — exposure
  riskDeep:  '#B91C1C', // risk-700   — the far end of the same family
  neutral:   '#757369', // ink-400    — nothing is happening
  grid:      '#E7E6E3', // paper-200
  // Axis ticks are text, so they answer to 4.5:1, not the 3:1 a bar or a dot
  // gets. ink-400 measures 4.76:1 on white but only 4.56:1 on paper-50, and at
  // 11px inside a busy plot it reads as a smudge — ink-500 is the same voice
  // with 5.6:1 behind it.
  axis:      '#6A6862', // ink-500
  ink:       '#17161A', // ink-950
  inkMuted:  '#57554F', // ink-700
  card:      '#FFFFFF', // paper-0
} as const

/** Meaning → series color, so status bars agree with the status pills. */
/*
 * Recharts styles the tooltip inline, so the tokens are restated literally:
 * paper-200 border, rounded-md (6px), shadow-e2. A tooltip floats above the
 * page but is not a dialog, so it stops at e2 — e3 stays for overlays.
 */
export const TOOLTIP_CONTENT: React.CSSProperties = {
  background:   PAINT.card,
  border:       `1px solid ${PAINT.grid}`,
  borderRadius: 6,
  boxShadow:    '0 4px 12px -2px rgba(23,22,26,0.08)',
  fontSize:     12.5,
  padding:      '8px 10px',
}
export const TOOLTIP_LABEL: React.CSSProperties = { color: PAINT.ink, fontWeight: 600, marginBottom: 2 }
export const TOOLTIP_ITEM:  React.CSSProperties = { color: PAINT.inkMuted }
export const AXIS_TICK = { fontSize: 11.5, fill: PAINT.axis }
export const LEGEND_STYLE: React.CSSProperties = { fontSize: 11.5, color: PAINT.inkMuted }
