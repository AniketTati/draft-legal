import * as React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/*
 * Field — design system §04. 32px tall, 13px text, 6px radius.
 * Focus is an emerald hairline plus a 12% halo, not a heavy glow: the field
 * should look like it's been inked, not lit up.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        'flex h-8 w-full rounded-md border border-input bg-card px-[11px] text-[13px] text-ink-950 transition-colors',
        'file:border-0 file:bg-transparent file:text-[13px] file:font-semibold',
        'placeholder:text-ink-400',
        'focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12',
        'disabled:cursor-not-allowed disabled:bg-paper-100 disabled:text-ink-400',
        'aria-[invalid=true]:border-risk-600 aria-[invalid=true]:focus-visible:ring-risk-600/12',
        className
      )}
      ref={ref}
      {...props}
    />
  )
)
Input.displayName = 'Input'

export { Input }
