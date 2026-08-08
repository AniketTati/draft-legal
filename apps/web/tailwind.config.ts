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
          400: '#9A9893', // placeholder, disabled text
          500: '#7A7873', // muted text
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
          600: '#D97706',
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
