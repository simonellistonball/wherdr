// app/utils/requestGuards.ts: no poll piles up requests on a stalled connection.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { skipWhileBusy, withDeadline } from '../app/utils/requestGuards'

afterEach(() => { vi.useRealTimers() })

describe('withDeadline', () => {
  it('aborts after its time, as a timeout', () => {
    vi.useFakeTimers()
    const d = withDeadline(undefined, 1000)
    vi.advanceTimersByTime(999)
    expect(d.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(d.signal.aborted).toBe(true)
    expect((d.signal.reason as DOMException).name).toBe('TimeoutError')
  })
  it('follows the caller’s own signal, already aborted or later', () => {
    const early = new AbortController()
    early.abort('gone')
    expect(withDeadline(early.signal, 1000).signal.reason).toBe('gone')
    const late = new AbortController()
    const d = withDeadline(late.signal, 1000)
    late.abort('later')
    expect(d.signal.reason).toBe('later')
    d.done()
  })
  it('never fires once done', () => {
    vi.useFakeTimers()
    const d = withDeadline(undefined, 1000)
    d.done()
    vi.advanceTimersByTime(5000)
    expect(d.signal.aborted).toBe(false)
  })
})

describe('skipWhileBusy', () => {
  it('starts nothing while the last call is out, then runs again once it ends', async () => {
    let calls = 0
    let finish!: () => void
    const tick = skipWhileBusy(() => { calls++; return new Promise<void>((r) => { finish = r }) })
    tick(); await Promise.resolve()
    tick(); tick(); await Promise.resolve()
    expect(calls).toBe(1)
    finish(); await new Promise(r => setTimeout(r, 0))
    tick(); await Promise.resolve()
    expect(calls).toBe(2)
  })
  it('frees itself after a failure', async () => {
    let calls = 0
    const tick = skipWhileBusy(async () => { calls++; throw new Error('down') })
    tick(); await new Promise(r => setTimeout(r, 0))
    tick(); await new Promise(r => setTimeout(r, 0))
    expect(calls).toBe(2)
  })
})
