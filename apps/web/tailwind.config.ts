import type { Config } from 'tailwindcss'

/*
 * Theme — draftLegal Design System v1.
 *
 * Two kinds of color live here and they are not interchangeable:
 *
 *   Semantic tokens (primary, border, muted, brand, assist, …) read from CSS
 *   variables in index.css. Reach for these first — they are the contract.
 *
 *   Named scales (paper, ink, brand-N, assist-N, info-N, attention-N, risk-N)
 *   are the literal palette stops from the design system. They exist so a wash,
 *   a border and a foreground can be picked from the same family without
 *   inventing an opacity, and so no component ever needs a raw Tailwind hue
 *   again. `gray-*`, `blue-*`, `indigo-*`, `emerald-*` et al. are off-system:
 *   the palette below replaces them one-for-one.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },

        // ── Ink & paper ───────────────────────────────────────────────────────
        // Warm neutrals. Replaces every gray-*/slate-*/zinc-*/neutral-*/stone-*.
        paper: {
          0: '#FFFFFF',   // card, page
          50: '#FAFAF9',  // app ground
          100: '#F4F4F2', // hover, fill
          200: '#E7E6E3', // border
          300: '#D3D2CE', // input, rule
        },
        ink: {
          // 400 is darkened from the design system's #9A9893, which measures
          // 2.88:1 on white and 2.76:1 on paper-50 — well under WCAG AA. It
          // carries timestamps, metadata subtitles and column headers, so it is
          // body text in practice whatever the spec calls it. #757369 is the
          // lightest warm grey that clears 4.5:1 on BOTH surfaces (4.76 / 4.56);
          // note paper-50, not white, is the binding constraint here.
          // 350 exists only for the neutral status DOT, and only because a dot
          // and body text have different jobs: WCAG asks 3:1 of a meaningful
          // non-text element but 4.5:1 of text. Using one value for both forced
          // a choice — dark enough to read as text put neutral-grey close
          // enough to brand emerald that a deuteranope could not separate
          // "Draft" from "Executed" by dot (ΔE 5.9). At 350 the dot still
          // clears 3.18:1 and sits ΔE ~15 from emerald under both deuteranopia
          // and protanopia. Text keeps 400.
          350: '#8B8983', // neutral status dot
          400: '#757369', // placeholder, disabled text, metadata
          // 500 is darkened alongside 400. The design system's #7A7873 measures
          // 4.22:1 on paper-50 — under AA — and once 400 was corrected it would
          // also have left the ramp non-monotonic, with "500" lighter than
          // "400". Every step now decreases in luminance and clears 4.5:1.
          500: '#6A6862', // muted text
          700: '#57554F', // secondary text
          950: '#17161A', // text, button
        },

        // ── Meaning ───────────────────────────────────────────────────────────
        // brand: the wordmark, and "binding" — nothing else.
        brand: {
          DEFAULT: 'hsl(var(--brand) / <alpha-value>)',
          foreground: 'hsl(var(--brand-foreground) / <alpha-value>)',
          50: '#ECFDF5',  // wash
          100: '#D1FAE5', // pill
          200: '#A7F3D0', // pill border
          500: '#10B981', // meter
          700: '#047857', // wordmark, CTA
          800: '#065F46', // hover
        },
        // assist: machine-authored only — never a UI accent.
        assist: {
          DEFAULT: 'hsl(var(--assist) / <alpha-value>)',
          foreground: 'hsl(var(--assist-foreground) / <alpha-value>)',
          50: '#EEF2FF',  // card
          200: '#C7D2FE', // border
          600: '#4F46E5', // mark, CTA
          700: '#4338CA', // text
          900: '#312E81', // on wash
        },
        // info: in flight — moving, but someone else's turn.
        info: {
          DEFAULT: 'hsl(var(--info) / <alpha-value>)',
          50: '#EFF6FF',
          100: '#DBEAFE',
          200: '#BFDBFE',
          600: '#2563EB',
          700: '#1D4ED8',
        },
        // attention: your turn. The only meaning that earns a badge count.
        attention: {
          DEFAULT: 'hsl(var(--attention) / <alpha-value>)',
          50: '#FFFBEB',
          100: '#FEF3C7',
          200: '#FDE68A',
          // Darkened from the design system's #D97706, which is 2.89:1 against
          // the paper-100 pill it sits on — under the 3:1 WCAG 1.4.11 asks of a
          // meaningful non-text element. That mattered more here than anywhere
          // else: this is the "your turn" dot, the one signal the whole colour
          // model is built to make trustworthy. #CC7005 clears it at 3.24:1
          // while staying visibly distinct from 700 (going all the way to
          // #B45309 would have collapsed 600 and 700 into the same value).
          600: '#CC7005',
          700: '#B45309',
        },
        // risk: legal exposure, failure, expiry. Never decoration.
        risk: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          50: '#FEF2F2',
          100: '#FEE2E2',
          200: '#FECACA',
          600: '#DC2626',
          700: '#B91C1C',
          900: '#7F1D1D',
        },
      },

      fontFamily: {
        // One superfamily, three voices.
        sans: ["'IBM Plex Sans'", 'system-ui', '-apple-system', 'sans-serif'],
        serif: ["'IBM Plex Serif'", 'Georgia', 'Times New Roman', 'serif'],
        mono: ["'IBM Plex Mono'", 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },

      fontSize: {
        // The type scale, named. Second tuple member carries leading + tracking
        // so a size can never be used at the wrong rhythm.
        display: ['52px', { lineHeight: '1.2', letterSpacing: '-0.03em', fontWeight: '600' }],
        title: ['20px', { lineHeight: '1.25', letterSpacing: '-0.015em', fontWeight: '600' }],
        section: ['15px', { lineHeight: '1.4', letterSpacing: '-0.005em', fontWeight: '600' }],
        body: ['13.5px', { lineHeight: '1.6' }],
        dense: ['12.5px', { lineHeight: '1.45' }],
        eyebrow: ['11px', { lineHeight: '1.4', letterSpacing: '0.08em', fontWeight: '600' }],
        paper: ['15px', { lineHeight: '1.62' }],
        micro: ['11px', { lineHeight: '1.7' }],
      },

      borderRadius: {
        // --radius (6px) IS the system default, so it anchors `md` rather than
        // `lg`. Stock shadcn hangs the scale off `lg`, which would make
        // `rounded-md` 4px and quietly under-round every button and field.
        sm: 'calc(var(--radius) - 2px)', // 4px — chip
        md: 'var(--radius)',             // 6px — button, field, the default
        lg: 'calc(var(--radius) + 2px)', // 8px — card
        paper: '2px',                    // the document page
        chip: '4px',
        card: '8px',
      },

      boxShadow: {
        // Borders before shadows. e3 is for overlays only — nothing on a page
        // surface lifts more than e1.
        e0: 'none',
        e1: '0 1px 2px rgba(23,22,26,0.05)',
        e2: '0 4px 12px -2px rgba(23,22,26,0.08)',
        e3: '0 12px 32px -8px rgba(23,22,26,0.16)',
        // The document page is the one surface allowed a shadow on paper.
        page: '0 0 0 1px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.04)',
      },

      spacing: {
        // Fixed shell dimensions — so nothing has to be re-decided per page.
        nav: '240px',
        'nav-collapsed': '56px',
        assist: '420px',
        'assist-collapsed': '32px',
        rail: '320px',
        facets: '208px',
        page: '820px',
      },

      height: {
        header: '56px',
        crumbs: '36px',
        row: '32px',
      },
    },
  },
  plugins: [],
}

export default config
