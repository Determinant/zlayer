import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode; fallback: (error: Error) => ReactNode; resetKey?: unknown; onError?: (error: Error) => void };

/** A failed render or lazy import must not unmount unrelated workspace products. */
export class ErrorBoundary extends Component<Props, { error: Error | undefined }> {
  override state: { error: Error | undefined } = { error: undefined };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error('Product unavailable') };
  }

  override componentDidCatch(error: Error) { this.props.onError?.(error); }

  override componentDidUpdate(previous: Props) {
    if (this.state.error && !Object.is(previous.resetKey, this.props.resetKey)) {
      this.setState({ error: undefined });
    }
  }

  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
