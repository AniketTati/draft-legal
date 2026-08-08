/**
 * Minimal Radix DropdownMenu wrapper. Used by B.1 to collapse secondary
 * action buttons behind a kebab (⋯) on the contract detail page.
 */
import * as React from 'react'
import * as Radix from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/utils'

export const DropdownMenu = Radix.Root
export const DropdownMenuTrigger = Radix.Trigger
export const DropdownMenuPortal = Radix.Portal

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof Radix.Content>,
  React.ComponentPropsWithoutRef<typeof Radix.Content>
>(({ className, sideOffset = 6, align = 'end', ...props }, ref) => (
  <Radix.Portal>
    <Radix.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      className={cn(
        'z-50 min-w-[12rem] overflow-hidden rounded-md border border-paper-200 bg-card p-1 shadow-e2',
        'animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-1',
        className,
      )}
      {...props}
    />
  </Radix.Portal>
))
DropdownMenuContent.displayName = 'DropdownMenuContent'

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof Radix.Item>,
  React.ComponentPropsWithoutRef<typeof Radix.Item>
>(({ className, ...props }, ref) => (
  <Radix.Item
    ref={ref}
    className={cn(
      'flex items-center gap-2 rounded-md px-3 py-2 text-dense text-ink-700 cursor-pointer outline-none',
      'hover:bg-paper-100 focus:bg-paper-100 hover:text-ink-950 focus:text-ink-950',
      'data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed',
      // Destructive rows opt in with `data-variant="destructive"` — risk is the
      // one meaning a menu row is allowed to carry, and it must not be a hover
      // surprise, so the color is on the resting state too.
      'data-[variant=destructive]:text-risk-700 data-[variant=destructive]:hover:bg-risk-50',
      'data-[variant=destructive]:focus:bg-risk-50 data-[variant=destructive]:hover:text-risk-700',
      className,
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'

export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof Radix.Separator>,
  React.ComponentPropsWithoutRef<typeof Radix.Separator>
>(({ className, ...props }, ref) => (
  <Radix.Separator
    ref={ref}
    className={cn('my-1 h-px bg-paper-200', className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'

export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof Radix.Label>,
  React.ComponentPropsWithoutRef<typeof Radix.Label>
>(({ className, ...props }, ref) => (
  <Radix.Label
    ref={ref}
    className={cn('px-3 py-1.5 text-eyebrow uppercase text-ink-400', className)}
    {...props}
  />
))
DropdownMenuLabel.displayName = 'DropdownMenuLabel'
