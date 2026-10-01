/**
 * docs/41 P1 (Part 5) — does edited text read as language? A deterministic
 * check, no model.
 *
 * Junk typed into the Miscellaneous clause and saved still showed "Aligned
 * with Market": the label came from a model that read "boilerplate + junk"
 * as boilerplate. Text added since the baseline is now checked word by
 * word. A word is junk when it can't be an English word: no vowel at four
 * letters or more, a run of six consonants, a letter three times in a row,
 * letters and digits mixed (other than 1st, 30th), a stretch of a keyboard
 * row, or a pair of letters no English word has ("qw", "kj", "zx"…).
 * Capitalised acronyms (GDPR, HIPAA) and numbers are left alone.
 *
 * The text reads as language unless at least two of its words are junk and
 * they are at least 30% of it, or it is eight words or more with none of the
 * small words every sentence has ("the", "of", "and"…) and some junk.
 */

const COMMON = new Set(`a an the of to in on at by for from with without and or nor but if then than that this these those which who whom whose what when where why how
is are was were be been being am has have had do does did shall will would should may might must can could not no any all each every either neither both
it its it's he she they them their his her we us our you your i me my as so such other into upon under over between within during after before until
party parties agreement contract hereby herein hereof thereof thereto`.split(/\s+/))

/** Letter pairs no English word has (or so rarely that typed text with them is mashing). */
const IMPOSSIBLE = new Set([
  'bx', 'cj', 'cv', 'cx', 'dx', 'fq', 'fx', 'gq', 'gx', 'hx', 'jc', 'jf', 'jg', 'jq', 'js', 'jv', 'jw', 'jx', 'jz', 'kq', 'kx',
  'mx', 'px', 'pz', 'qb', 'qc', 'qd', 'qf', 'qg', 'qh', 'qj', 'qk', 'ql', 'qm', 'qn', 'qp', 'qs', 'qt', 'qv', 'qw', 'qx', 'qy', 'qz',
  'sx', 'vb', 'vf', 'vh', 'vj', 'vm', 'vp', 'vq', 'vt', 'vw', 'vx', 'wx', 'xj', 'zj', 'zq', 'zx', 'kj', 'jh', 'hj', 'jk',
  'fz', 'kz', 'mz', 'qq', 'wq', 'xk', 'xz', 'zf', 'zk', 'zv',
])
const KEYBOARD = /(qwer|rtyu|tyui|yuio|uiop|asdf|sdfg|dfgh|fghj|ghjk|hjkl|zxcv|xcvb|cvbn|vbnm)/

/** Whether one word can't be a word. */
export function junkWord(word: string): boolean {
  if (/^\p{N}/u.test(word)) return false                       // a number, a section or clause reference
  if (word.length <= 5 && word === word.toUpperCase()) return false // an acronym (GDPR, HIPAA)
  const w = word.toLowerCase()
  // Only plain Latin letters and digits are judged: other scripts, and
  // accented words, are not guessed at.
  if (!/^[a-z0-9]+$/.test(w)) return false
  if (w.length <= 2) return false
  if (/[a-z][0-9]|[0-9][a-z]/.test(w) && !/^\d+(st|nd|rd|th)$/.test(w)) return true
  if (w.length >= 4 && !/[aeiouy]/.test(w)) return true
  if (/[bcdfghjklmnpqrstvwxz]{6,}/.test(w)) return true
  if (/([a-z])\1\1/.test(w)) return true
  if (KEYBOARD.test(w)) return true
  for (let i = 0; i + 1 < w.length; i++) if (IMPOSSIBLE.has(w.slice(i, i + 2))) return true
  return false
}

export interface Readability {
  readsAsLanguage: boolean
  words: number
  junk: string[]
}

export function readability(text: string): Readability {
  const words = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []
  const junk = words.filter(junkWord)
  const hasCommon = words.some(w => COMMON.has(w.toLowerCase()))
  const bad = (junk.length >= 2 && junk.length / Math.max(words.length, 1) >= 0.3)
    || (words.length >= 8 && !hasCommon && junk.length >= 1)
    || (words.length === 1 && junk.length === 1 && words[0].length >= 6)
  return { readsAsLanguage: !bad, words: words.length, junk }
}
