/**
 * ErrorBoundary — generic safety net.
 *
 * Wrap any subtree that depends on remote-shape data (chat messages,
 * tool-call envelopes, JSON metadata) so a single bad row can't blank
 * the whole page. Renders a small inline card with the error message
 * and a "try again" CTA that resets the boundary.
 *
 * NOTE: this is intentionally minimal. The catch shows a useful card
 * to the user instead of a white screen, and forwards the error to
 * console.error so dev still sees it. We don't ship a global handler
 * here — call sites pick the right granularity (thread shell, page
 * shell, etc.).
 */
import { Component, type ReactNode, type ErrorInfo } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  children: ReactNode
  /** What this boundary protects — used in the fallback message. */
  label?: string
  /** Optional custom fallback renderer. Receives the error + a reset fn. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.label ?? '(unlabeled)', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return (
      /*
       * Risk, not attention: a subtree that failed to render is a failure, not
       * something waiting on the user. Amber in this system means "your turn".
       */
      <div className="m-6 max-w-lg rounded-card border border-risk-200 bg-risk-50 p-5" role="alert">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-md bg-risk-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="size-5 text-risk-700" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-body font-semibold text-ink-950">
              Something went wrong{this.props.label ? ` rendering ${this.props.label}` : ''}
            </h3>
            <p className="mt-1 text-dense text-ink-700">
              The page caught an error before it could blank. You can retry, or
              navigate elsewhere and come back.
            </p>
            <pre className="mt-2 text-[11px] text-risk-900 bg-card border border-risk-200 rounded-chip px-2 py-1.5 overflow-x-auto whitespace-pre-wrap">
              {error.message.slice(0, 600)}
            </pre>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={this.reset}
              className="mt-3"
            >
              <RefreshCw className="size-3" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
