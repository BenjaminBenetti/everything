import { Component, type ReactNode } from "react";
import { Brand } from "@everything/ui/brand";

/** Keep unexpected rendering failures recoverable without revealing internal errors. */
export class ApplicationErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  // ===========================================
  // State
  // ===========================================

  override state = { failed: false };

  // ===========================================
  // React lifecycle
  // ===========================================

  /** Switch to a safe recovery surface when a descendant cannot render. */
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  /** Render the application or a reload action after an unexpected failure. */
  override render(): ReactNode {
    return this.state.failed ? (
      <main className="startup-screen">
        <Brand />
        <p role="alert">Your workspace couldn’t open.</p>
        <button className="button primary" onClick={() => location.reload()}>
          Try again
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
