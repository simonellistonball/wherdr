// Two guards for requests the app makes on its own (polls), so a connection
// that stalls without failing (a laptop asleep, a Wi-Fi change, a stuck
// HTTP/2 connection behind a proxy) cannot pile up requests that never end:
// the browser then refuses every new one (net::ERR_INSUFFICIENT_RESOURCES)
// until the tab is reloaded.
//  - withDeadline: a signal that also aborts after `ms` (api() gives every
//    GET one); the caller's own signal still aborts it first.
//  - skipWhileBusy: a poll tick starts nothing while the previous call runs.

// GETs only: an action (Start, a bd write) may take a minute and must not be
// cut halfway; a read that has not answered in this time never will.
export const GET_DEADLINE_MS = 45_000

export function withDeadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal, done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('The server did not answer in time', 'TimeoutError')), ms)
  const follow = () => controller.abort(signal!.reason)
  if (signal?.aborted) follow()
  else signal?.addEventListener('abort', follow, { once: true })
  return {
    signal: controller.signal,
    done: () => { clearTimeout(timer); signal?.removeEventListener('abort', follow) },
  }
}

export function skipWhileBusy<A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown): (...a: A) => void {
  let busy = false
  return (...a: A) => {
    if (busy) return
    busy = true
    Promise.resolve().then(() => fn(...a)).catch(() => {}).finally(() => { busy = false })
  }
}
