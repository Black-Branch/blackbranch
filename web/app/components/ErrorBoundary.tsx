"use client";

import React from "react";
import { reportClientError } from "@/app/lib/clientError";
import { shouldReloadForChunkError } from "@/app/lib/chunkReload";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/** sessionStorage, or null where touching it throws (private mode, blocked site
 *  data, thumbnail capture). Never let telemetry plumbing crash the boundary
 *  that exists to catch crashes. */
function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo) {
    // Both lines, deliberately: the sink is where a crash becomes a readable row
    // (this boundary wraps the chat sidebar and the whole community view); the
    // console line is what remains when the sink itself is down, and it carries
    // the componentStack the report does not.
    console.error("[ErrorBoundary]", err, info.componentStack);
    // Report FIRST, always. reportClientError sends with keepalive: true so
    // the reload below cannot cut it off mid-flight, and the count of how often
    // a deploy strands an open tab is the only signal that it happens at all.
    reportClientError("component-boundary", err);
    const store = typeof window === "undefined" ? null : safeSessionStorage();
    if (shouldReloadForChunkError(err, store)) window.location.reload();
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center justify-center h-full p-4 text-center">
          <div>
            <p className="text-secondary text-sm mb-2">Something went wrong here.</p>
            <button
              className="text-xs text-muted hover:text-secondary underline"
              onClick={() => this.setState({ hasError: false, message: "" })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
