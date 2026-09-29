import { cn } from '@/lib/utils'

type Props = {
  src: string
  alt: string
  url?: string
  className?: string
  imgClassName?: string
  shadow?: 'none' | 'soft' | 'lifted'
}

export function BrowserFrame({
  src,
  alt,
  url = 'app.draft-legal.com',
  className,
  imgClassName,
  shadow = 'soft',
}: Props) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-slate-200 bg-white',
        shadow === 'soft' && 'shadow-[0_24px_64px_-32px_rgba(15,23,42,0.25)]',
        shadow === 'lifted' &&
          'shadow-[0_50px_100px_-32px_rgba(4,120,87,0.18),0_24px_48px_-24px_rgba(15,23,42,0.25)]',
        className
      )}
    >
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
        </span>
        <div className="ml-2 flex h-6 flex-1 items-center justify-center rounded-md bg-white px-3 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {url}
        </div>
        <span className="h-1 w-1 rounded-full bg-slate-300" />
        <span className="h-1 w-1 rounded-full bg-slate-300" />
        <span className="h-1 w-1 rounded-full bg-slate-300" />
      </div>
      {/* Every product screenshot is 1680×900. The size reserves each image's
          space before it loads, so the page doesn't shift and /product#stage
          links land on their stage. */}
      <img
        src={src}
        alt={alt}
        width={1680}
        height={900}
        loading="lazy"
        className={cn('block h-auto w-full', imgClassName)}
      />
    </div>
  )
}
