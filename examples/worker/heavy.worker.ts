/// <reference lib="webworker" />
import type { Request, Response } from './protocol.ts'

/**
 * The worker side.
 *
 * The important detail here is that the handlers are **time-sliced**, not just
 * signal-aware. A worker sitting in a synchronous loop never reaches its event
 * loop, so a `cancel` message sits undelivered in the queue and `signal.aborted`
 * stays false no matter how often you check it. Cancellation would stop dead at
 * the thread boundary while a core kept burning on abandoned work.
 *
 * Yielding to the macrotask queue periodically is what lets the message land.
 * The alternative, for work that genuinely cannot be chunked, is a
 * SharedArrayBuffer flag polled with `Atomics.load` - which works while
 * blocked, but needs cross-origin isolation in a browser.
 */

const inFlight = new Map<number, AbortController>()

const aborted = (): DOMException => new DOMException('aborted', 'AbortError')

/** Hands control back so queued messages - notably `cancel` - can dispatch. */
const breathe = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

/**
 * Yields on a time budget rather than an iteration count, so the pause rate
 * self-tunes to how fast the machine actually is.
 */
class Slicer {
  private last = performance.now()

  async check(signal: AbortSignal): Promise<void> {
    if (performance.now() - this.last < 8) {
      return
    }
    await breathe()
    this.last = performance.now()
    if (signal.aborted) {
      throw aborted()
    }
  }
}

async function digest(
  input: string,
  rounds: number,
  signal: AbortSignal
): Promise<string> {
  const slicer = new Slicer()
  let hash = 0x811c9dc5
  for (let round = 0; round < rounds; round++) {
    if ((round & 0x3fff) === 0) {
      await slicer.check(signal)
    }
    for (let index = 0; index < input.length; index++) {
      hash ^= input.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return hash.toString(16).padStart(8, '0')
}

async function countPrimes(limit: number, signal: AbortSignal): Promise<number> {
  if (limit < 2) {
    // An expected failure: plain, cloneable data, tagged for the caller.
    throw { expected: true, reason: `limit must be at least 2, received ${limit}` }
  }
  const slicer = new Slicer()
  const sieve = new Uint8Array(limit + 1)
  let found = 0
  for (let candidate = 2; candidate <= limit; candidate++) {
    if ((candidate & 0xffff) === 0) {
      await slicer.check(signal)
    }
    if (sieve[candidate] === 1) continue
    found += 1
    for (let multiple = candidate * candidate; multiple <= limit; multiple += candidate) {
      sieve[multiple] = 1
    }
  }
  return found
}

const handlers: Record<
  string,
  (args: readonly unknown[], signal: AbortSignal) => Promise<unknown>
> = {
  digest: ([input, rounds], signal) => digest(input as string, rounds as number, signal),
  countPrimes: ([limit], signal) => countPrimes(limit as number, signal),
  /** Protocol probes, used by the tests. */
  refuse: async ([reason]) => {
    throw { expected: true, reason }
  },
  crash: async () => {
    throw new Error('worker bug')
  },
}

const reply = (response: Response): void => {
  ;(self as unknown as { postMessage: (message: Response) => void }).postMessage(response)
}

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const request = event.data

  if (request.kind === 'cancel') {
    inFlight.get(request.id)?.abort()
    inFlight.delete(request.id)
    return
  }

  const handler = handlers[request.method]
  if (handler === undefined) {
    reply({ kind: 'defect', id: request.id, message: `no method ${request.method}` })
    return
  }

  const controller = new AbortController()
  inFlight.set(request.id, controller)

  handler(request.args, controller.signal).then(
    (value) => {
      inFlight.delete(request.id)
      reply({ kind: 'ok', id: request.id, value })
    },
    (thrown: unknown) => {
      inFlight.delete(request.id)
      if (thrown instanceof DOMException && thrown.name === 'AbortError') {
        // Cancelled: the caller is already gone, so there is nobody to answer.
        return
      }
      // Structured clone drops prototypes, so an expected failure travels as
      // plain data and the caller decides what class it becomes.
      if (typeof thrown === 'object' && thrown !== null && 'expected' in thrown) {
        reply({ kind: 'err', id: request.id, error: thrown })
        return
      }
      reply({
        kind: 'defect',
        id: request.id,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      })
    }
  )
})
