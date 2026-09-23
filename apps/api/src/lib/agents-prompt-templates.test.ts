/**
 * Agents prompt-template tripwire (C8 follow-up) — a source-level guard, like
 * agents-internal-headers.test.ts.
 *
 * The agents service fills its prompts with str.format(), which reads every
 * `{` as the start of a field. A JSON example written with single braces
 * raises KeyError before the model is called: the Negotiate tab's redline
 * analysis and the portfolio query never got past it. There is no Python
 * test runner in CI, so this reads the sources: a module-level prompt that is
 * `.format()`ed may use only fields the call supplies, and literal braces
 * must be doubled.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const AGENTS = join(process.cwd(), '..', 'agents', 'app')

function pythonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__pycache__' ? [] : pythonFiles(path)
    return name.endsWith('.py') ? [path] : []
  })
}

/** The fields str.format() looks up in `template`, or the error it raises (Python's Formatter.parse). */
function formatFields(template: string): { fields: string[]; error?: string } {
  const fields: string[] = []
  for (let i = 0; i < template.length; i++) {
    if (template[i] === '{') {
      if (template[i + 1] === '{') { i++; continue }
      const end = template.indexOf('}', i)
      if (end === -1) return { fields, error: "Single '{' encountered in format string" }
      fields.push(template.slice(i + 1, end).split(/[!:]/)[0])
      i = end
    } else if (template[i] === '}') {
      if (template[i + 1] === '}') { i++; continue }
      return { fields, error: "Single '}' encountered in format string" }
    }
  }
  return { fields }
}

/** The keyword names passed in every `name.format(...)` call in `src`, or null if there is none. */
function formatKeywords(src: string, name: string): Set<string> | null {
  const calls: Set<string>[] = []
  for (const m of src.matchAll(new RegExp(`\\b${name}\\.format\\(`, 'g'))) {
    let depth = 1, i = m.index! + m[0].length
    const start = i
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
    }
    const args = src.slice(start, i - 1)
    // Top-level keyword names only: `name=` not inside a nested call.
    const keywords = new Set<string>()
    let level = 0
    for (let j = 0; j < args.length; j++) {
      if (args[j] === '(' || args[j] === '[' || args[j] === '{') level++
      else if (args[j] === ')' || args[j] === ']' || args[j] === '}') level--
      else if (level === 0) {
        const kw = /^(\w+)\s*=(?!=)/.exec(args.slice(j))
        if (kw && (j === 0 || /[\s,(]/.test(args[j - 1]))) { keywords.add(kw[1]); j += kw[1].length }
      }
    }
    calls.push(keywords)
  }
  return calls.length ? new Set([...calls[0]].filter(k => calls.every(c => c.has(k)))) : null
}

describe('agents prompt templates', () => {
  const checked: string[] = []
  const problems: string[] = []
  for (const path of pythonFiles(AGENTS)) {
    const src = readFileSync(path, 'utf8')
    for (const m of src.matchAll(/^([A-Za-z_]\w*)\s*=\s*([rRuU]?)"""([\s\S]*?)"""/gm)) {
      const [, name, , template] = m
      const keywords = formatKeywords(src, name)
      if (!keywords) continue
      const where = `${relative(AGENTS, path)} ${name}`
      checked.push(where)
      const { fields, error } = formatFields(template)
      if (error) problems.push(`${where}: ${error}`)
      for (const field of fields) {
        if (!/^[A-Za-z_]\w*$/.test(field)) problems.push(`${where}: ${JSON.stringify(field)} is read as a field — double the braces`)
        else if (!keywords.has(field)) problems.push(`${where}: {${field}} is not passed to .format()`)
      }
    }
  }

  it('finds the prompts it guards', () => {
    expect(checked).toEqual(expect.arrayContaining([
      'agents/redline_agent.py _EXTRACT_PROMPT',
      'agents/redline_agent.py _SCORE_PROMPT',
      'agents/redline_agent.py _COUNTER_PROMPT',
      'agents/portfolio_agent.py _PARSE_PROMPT',
    ]))
  })

  it('every .format()ed prompt uses only the fields its call supplies, with literal braces doubled', () => {
    expect(problems).toEqual([])
  })
})
