/**
 * Request control — single AbortController that every `/api/hermes`
 * fetch shares.  Any state-change action (load save, new story, reset,
 * switch seed) calls ``abortAll()`` and a fresh controller is armed.
 *
 * Why it matters:
 *
 * 1. **Cost safety.**  A brainstorm skill call takes 30-60s.  If the
 *    user switches stories mid-flight, without abort the call still
 *    completes on the gateway AND the client still parses the result —
 *    that orphan brainstorm has been billed AND its children get
 *    grafted into the NEW story's tree (Marvel children landing under
 *    an Avatar root, exactly the bug we hit on first test).
 *
 * 2. **State integrity.**  Every hermes-client action reads
 *    ``useStory.getState()`` at commit time.  If an old call finishes
 *    AFTER a state swap, it overwrites the new tree with stale data.
 *    Aborting kills the response stream before that happens.
 *
 * Note: aborting the client fetch does NOT cancel the Anthropic
 * inference — the server still completes the prompt and you still pay
 * for the output tokens.  But the bigger wins are the state integrity
 * ones; the cost savings on aborted calls are a smaller bonus.
 */

class RequestControl {
  private controller: AbortController = new AbortController()

  /** Signal to pass into `fetch({ signal })`.  Read fresh on every call
   *  so calls started after `abortAll()` use the new controller. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Abort every inflight hermes fetch sharing this controller, then
   *  arm a fresh controller for subsequent calls. */
  abortAll(reason = 'state-change'): void {
    try {
      this.controller.abort(reason)
    } catch {
      /* ignore — controller may already be aborted */
    }
    this.controller = new AbortController()
  }
}

export const requestControl = new RequestControl()
