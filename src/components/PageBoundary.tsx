import React from 'react';

interface Props {
  /** The page's name, so the sentence says which one failed and the key remounts it on a page change. */
  page: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * A render error inside a page unmounted the whole React tree and left a blank window on the
 * first laptop (2026-09-19: React #310 from the Headroom section when its switch was turned
 * on); the title bar, the bottom bar and the other pages were fine and had no reason to go.
 * This boundary keeps them: the page that failed shows what happened in one sentence and a
 * button that mounts it again. The error goes to the console for the log.
 */
export class PageBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[page ${this.props.page}] render error:`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.page !== this.props.page && this.state.error) this.setState({ error: null });
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-4 space-y-2">
        <p className="text-mini text-rose-200">This page stopped drawing: {this.state.error.message}</p>
        <p className="text-micro text-studio-subtle">The rest of Strata Tune is unaffected; the collector and any capture keep running. The details are in the app log.</p>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
