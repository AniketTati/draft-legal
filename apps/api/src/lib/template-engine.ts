/**
 * Template Engine — Phase 4.1
 *
 * Assembles contract HTML from a Template + variable values.
 * Handles:
 *   - Variable interpolation: {{variable_key}} tokens → values
 *   - Conditional section logic: include/exclude sections based on field comparisons
 *   - Clause library embedding: resolves clauseRefs into clause HTML
 */

import type { Template, TemplateSection, ClauseLibraryItem } from '@prisma/client'

// ─── Types ─────────────────────────────────────────────────────────────────

export type VariableValue = string | number | boolean | null | undefined

export interface VariableMap {
  [key: string]: VariableValue
}

export interface ConditionalLogic {
  field: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_empty' | 'empty'
  value?: VariableValue
}

export interface TemplateWithSections extends Template {
  sections: TemplateSection[]
}

export interface GenerateResult {
  html: string
  sectionsIncluded: number
  sectionsExcluded: number
  unfilledVariables: string[]
}

// ─── Variable Interpolation ─────────────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Replace {{key}} tokens in HTML with values from the variable map.
 * Unfilled tokens are left with a visible placeholder.
 *
 * docs/39 H2 — each value stays marked with its variable (a span with
 * data-variable, which the contract's editor keeps as a mark), so a draft's
 * terms can be changed everywhere they appear, once; the value is escaped
 * (it went into the HTML raw).
 */
export function interpolateVariables(html: string, variables: VariableMap): { html: string; unfilled: string[] } {
  const unfilled: string[] = []

  const result = html.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_match, key) => {
    const value = variables[key]
    if (value === undefined || value === null || value === '') {
      unfilled.push(key)
      return `<span class="template-variable-unfilled" data-variable="${key}" data-key="${key}">[[${key}]]</span>`
    }
    return `<span data-variable="${key}">${escapeHtml(String(value))}</span>`
  })

  return { html: result, unfilled }
}

// ─── Conditional Logic Evaluator ────────────────────────────────────────────

/**
 * Evaluate whether a section should be included based on its conditionalLogic.
 * Returns true if the section should be included.
 */
export function evaluateCondition(logic: ConditionalLogic, variables: VariableMap): boolean {
  const fieldValue = variables[logic.field]

  switch (logic.operator) {
    case 'empty':
      return fieldValue === undefined || fieldValue === null || fieldValue === ''
    case 'not_empty':
      return fieldValue !== undefined && fieldValue !== null && fieldValue !== ''
    case 'eq':
      return String(fieldValue) === String(logic.value)
    case 'neq':
      return String(fieldValue) !== String(logic.value)
    case 'gt':
      return Number(fieldValue) > Number(logic.value)
    case 'gte':
      return Number(fieldValue) >= Number(logic.value)
    case 'lt':
      return Number(fieldValue) < Number(logic.value)
    case 'lte':
      return Number(fieldValue) <= Number(logic.value)
    case 'contains':
      return String(fieldValue).toLowerCase().includes(String(logic.value).toLowerCase())
    default:
      return true
  }
}

// ─── Section Inclusion ───────────────────────────────────────────────────────

function shouldIncludeSection(section: TemplateSection, variables: VariableMap): boolean {
  if (!section.conditionalLogic) return true

  let logic: ConditionalLogic
  try {
    logic = typeof section.conditionalLogic === 'string'
      ? JSON.parse(section.conditionalLogic as string)
      : section.conditionalLogic as unknown as ConditionalLogic
  } catch {
    return true // if logic is malformed, include the section
  }

  return evaluateCondition(logic, variables)
}

// ─── Clause Ref Resolution ──────────────────────────────────────────────────

/**
 * Replace clause ref markers in section content with actual clause HTML.
 * Clause refs are stored as a JSON array of clause library item IDs.
 * The section content already contains the clause HTML (written at template build time),
 * so this function handles the case where content references external clause IDs
 * that need fresh content fetched from the library.
 */
export function resolveClauseRefs(
  sectionContent: string,
  clauseRefs: string[],
  clauseMap: Map<string, ClauseLibraryItem>,
): string {
  if (!clauseRefs.length) return sectionContent

  // Append any referenced clauses that aren't already in the section content
  let additionalContent = ''
  for (const clauseId of clauseRefs) {
    const clause = clauseMap.get(clauseId)
    if (clause && !sectionContent.includes(clauseId)) {
      additionalContent += `\n<div class="clause-library-ref" data-clause-id="${clause.id}">\n${clause.content}\n</div>\n`
    }
  }

  return sectionContent + additionalContent
}

// ─── Main Assembly ───────────────────────────────────────────────────────────

export interface GenerateOptions {
  template: TemplateWithSections
  variables: VariableMap
  clauseMap?: Map<string, ClauseLibraryItem>
}

export function generateDocument(options: GenerateOptions): GenerateResult {
  const { template, variables, clauseMap = new Map() } = options

  const sortedSections = [...template.sections].sort((a, b) => a.sortOrder - b.sortOrder)

  let sectionsIncluded = 0
  let sectionsExcluded = 0
  const allUnfilled: string[] = []
  const htmlParts: string[] = []

  // Opening wrapper with template metadata
  htmlParts.push(
    `<div class="generated-contract" data-template-id="${template.id}" data-template-version="${template.version}">`,
  )

  for (const section of sortedSections) {
    if (!shouldIncludeSection(section, variables)) {
      sectionsExcluded++
      continue
    }

    sectionsIncluded++

    // Resolve clause refs
    const clauseRefs: string[] = Array.isArray(section.clauseRefs)
      ? (section.clauseRefs as string[])
      : []
    let sectionContent = resolveClauseRefs(section.content, clauseRefs, clauseMap)

    // Interpolate variables
    const { html: interpolated, unfilled } = interpolateVariables(sectionContent, variables)
    allUnfilled.push(...unfilled)

    htmlParts.push(
      `<section class="contract-section" data-section-id="${section.id}">`,
      section.title ? `<h2 class="section-title">${section.title}</h2>` : '',
      interpolated,
      `</section>`,
    )
  }

  htmlParts.push(`</div>`)

  return {
    html: htmlParts.filter(Boolean).join('\n'),
    sectionsIncluded,
    sectionsExcluded,
    unfilledVariables: [...new Set(allUnfilled)],
  }
}

// ─── Preview Helpers ─────────────────────────────────────────────────────────

/**
 * Generate sample variable values from a template's variable definitions
 * for use in preview mode.
 */
export function buildSampleVariables(
  variableDefs: Array<{ key: string; type: string; defaultValue?: string }>,
): VariableMap {
  const samples: VariableMap = {}

  for (const def of variableDefs) {
    if (def.defaultValue !== undefined && def.defaultValue !== '') {
      samples[def.key] = def.defaultValue
      continue
    }

    switch (def.type) {
      case 'text':
        samples[def.key] = `[${def.key}]`
        break
      case 'number':
        samples[def.key] = 100000
        break
      case 'date':
        samples[def.key] = new Date().toISOString().split('T')[0]
        break
      case 'boolean':
        samples[def.key] = true
        break
      default:
        samples[def.key] = `[${def.key}]`
    }
  }

  return samples
}
