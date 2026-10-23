/**
 * Where the help desk's load-time greeting needs the chat to be: the live pane, when a phone's
 * pager is showing something else (the greeting renders in the live column, so off screen it
 * could be neither seen nor answered). A computer shows the live column beside the rest: null.
 */
export function paneForGreeting(pagerOn: boolean, activePane: string): "live" | null {
  return pagerOn && activePane !== "live" ? "live" : null;
}
