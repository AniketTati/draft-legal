import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/*
 * Button — design system §04.
 *
 * "One primary per view." Ink is the only default, so no chromatic hue has to
 * fight for the button. `brand` (emerald) and `danger` (red) are DECISION
 * buttons: they belong on approval and signature surfaces and nowhere else.
 * `assist` is indigo and is reserved for asking the machine to do something.
 *
 * The focus ring is emerald — the brand shows up in interaction rather than in
 * fills. It is at FULL opacity, which is a deliberate deviation from the design
 * system's "emerald at 35%": composited over the page, 35% emerald measures
 * 1.69:1 against bg-card and 1.67:1 against paper-50, roughly half the 3:1 that
 * WCAG 1.4.11 requires of a focus indicator — i.e. it would be less visible
 * than the browser default it replaces. Full emerald is 5.48:1 and reads the
 * same way at a glance. The white ring-offset preserves the spec's two-ring
 * look. Revisit only with a designer, not by reverting to /35.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap font-semibold transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
    'focus-visible:ring-offset-background disabled:pointer-events-none ' +
    'disabled:border-paper-200 disabled:bg-paper-100 disabled:text-ink-400 ' +
    '[&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Ink. The default, and the only default.
        default: 'border border-ink-950 bg-ink-950 text-white hover:bg-ink-700 hover:border-ink-700',
        outline: 'border border-input bg-card text-ink-700 hover:bg-paper-100 hover:text-ink-950',
        ghost: 'border border-transparent text-ink-700 hover:bg-paper-100 hover:text-ink-950',
        // Decision — approval + signature surfaces only.
        brand: 'border border-brand-700 bg-brand-700 text-white hover:bg-brand-800 hover:border-brand-800',
        danger: 'border border-risk-200 bg-card text-risk-700 hover:bg-risk-50',
        // Destructive fill. For irreversible deletes, not for "Reject".
        destructive: 'border border-risk-600 bg-risk-600 text-white hover:bg-risk-700 hover:border-risk-700',
        // Machine. Pair with <AssistMark /> so the glyph rule holds.
        assist: 'border border-assist-600 bg-assist-600 text-white hover:bg-assist-700 hover:border-assist-700',
        assistOutline: 'border border-assist-200 bg-card text-assist-700 hover:bg-assist-50',
        link: 'border border-transparent text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700',
      },
      size: {
        xs: 'h-[26px] gap-1.5 rounded-sm px-2.5 text-[11.5px] [&_svg]:size-3',
        sm: 'h-8 gap-[7px] rounded-md px-3.5 text-[12.5px] [&_svg]:size-3.5',
        md: 'h-[38px] gap-2 rounded-md px-[18px] text-[13.5px] [&_svg]:size-4',
        icon: 'size-8 rounded-md [&_svg]:size-4',
        'icon-xs': 'size-[26px] rounded-sm [&_svg]:size-3.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      // 32px is the system default — legal ops spend the day in rows.
      size: 'sm',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
