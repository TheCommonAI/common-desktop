import { Component, type ErrorInfo, type ReactNode } from "react";
import Feedback from "./chat/Feedback";
import { describeCrash, recordReportEvent } from "./chat/reporting";

interface CrashBoundaryState {
  failed: boolean;
}

export default class CrashBoundary extends Component<
  { children: ReactNode },
  CrashBoundaryState
> {
  state: CrashBoundaryState = { failed: false };

  static getDerivedStateFromError(): CrashBoundaryState {
    return { failed: true };
  }

  componentDidMount() {
    window.addEventListener("error", this.onError);
    window.addEventListener("unhandledrejection", this.onRejection);
  }

  componentWillUnmount() {
    window.removeEventListener("error", this.onError);
    window.removeEventListener("unhandledrejection", this.onRejection);
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    recordReportEvent("crash", `${describeCrash(error)}\n${info.componentStack ?? ""}`);
  }

  private onError = (event: ErrorEvent) => {
    recordReportEvent(
      "crash",
      event.error === undefined
        ? `${event.message} (${event.filename}:${event.lineno}:${event.colno})`
        : describeCrash(event.error),
    );
  };

  private onRejection = (event: PromiseRejectionEvent) => {
    recordReportEvent("crash", `Unhandled promise rejection: ${describeCrash(event.reason)}`);
  };

  render() {
    if (this.state.failed) {
      return (
        <main className="crash">
          <h1>Common ran into a problem.</h1>
          <p>
            Recent crash details are kept on this device when storage is available. Nothing is
            sent automatically. Copy the diagnostics from Settings after restarting, or report the
            issue below.
          </p>
          <button className="feedback__button" onClick={() => window.location.reload()}>
            Restart Common
          </button>
          <Feedback />
        </main>
      );
    }
    return this.props.children;
  }
}
