// Flat ESLint config (eslint 9). Wave 5 — the repo referenced `eslint` in its
// lint scripts but never installed it, so `pnpm lint` failed.
//
// Deliberately LEAN, high-signal ruleset: catches real bugs (duplicate keys,
// unreachable code, bad regex/typeof, accidental assignment in conditions)
// without the style-nit flood that would make lint noise. Type-level checks
// (unused vars, any) are left to `tsc` (noUnusedLocals) so lint and typecheck
// don't fight. Tighten over time.
//
// Note: glob patterns avoid brace-expansion (`{a,b}`) on purpose — a hoisted
// legacy minimatch in the tree throws on braceExpand.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.venv/**',
      '**/build/**',
      '**/coverage/**',
      // The Salesforce package: LWC decorators and Apex, linted by the Salesforce CLI.
      'integrations/salesforce/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    // Register the typescript-eslint + react-hooks plugins so the pre-existing
    // inline `// eslint-disable @typescript-eslint/* | react-hooks/*` directives
    // scattered through the code resolve to a defined rule instead of erroring.
    // Their rules stay OFF for now (tsc + review own that ground); the value
    // here is the js.configs.recommended real-bug set below. Tighten over time.
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    linterOptions: {
      // Don't fail on the many now-redundant inline disable comments; a lone
      // warning is enough signal to clean them up later.
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'off',        // tsc noUnusedLocals owns this
      'no-undef': 'off',              // TS resolves types + globals
      'no-redeclare': 'off',          // TS function overloads
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',      // legitimate in magic-byte / OCR paths
      'preserve-caught-error': 'off', // too opinionated for a lean bug set
    },
  },
)
