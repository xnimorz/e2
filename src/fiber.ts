import type { AnyCause, Exit } from './cause.ts'
import type { AnyFx } from './fx.ts'
import { Scope } from './scope.ts'
import type { ServiceMap } from './service_map.ts'
import type { Maybe } from './types.ts'

/**
 * A continuation waiting on the fiber's own stack.
 *
 * These replace the JS call stack. A twenty-deep chain of `fx`-defined
 * functions costs twenty array entries here, not twenty levels of native
 * `yield*` delegation for the engine to re-walk on every step.
 */
export type Frame =
  | { readonly kind: 'transform'; readonly apply: (value: any) => unknown }
  | { readonly kind: 'chain'; readonly apply: (value: any) => AnyFx }
  | {
      readonly kind: 'recover'
      readonly apply: (errorOrCause: any) => AnyFx
      /** When set, defects and interrupts are caught too. */
      readonly all: boolean
    }
  | { readonly kind: 'gen'; readonly iterator: Iterator<unknown, unknown, unknown> }
  | { readonly kind: 'services'; readonly restore: ServiceMap }

export const transformFrame = (apply: (value: any) => unknown): Frame => ({
  kind: 'transform',
  apply,
})
export const chainFrame = (apply: (value: any) => AnyFx): Frame => ({ kind: 'chain', apply })
export const recoverFrame = (apply: (error: any) => AnyFx, all = false): Frame => ({
  kind: 'recover',
  apply,
  all,
})
export const genFrame = (iterator: Iterator<unknown, unknown, unknown>): Frame => ({
  kind: 'gen',
  iterator,
})
export const servicesFrame = (restore: ServiceMap): Frame => ({
  kind: 'services',
  restore,
})

export type FiberState = 'running' | 'suspended' | 'done'

let nextFiberId = 0

/**
 * One running computation: its continuation stack, its services, its scope,
 * its cancellation signal and its children.
 *
 * Nodes are immutable and shared. Everything that changes as a program runs
 * lives here, which is what makes an effect safely re-runnable.
 */
export class Fiber {
  readonly id = nextFiberId++

  /** The instruction about to be reduced, or undefined once settled. */
  current: Maybe<AnyFx>
  /** Continuations, innermost last. */
  readonly stack: Frame[] = []
  /** Services visible to the instruction being reduced. */
  services: ServiceMap
  /** Finalizers owned by this fiber, closed when it settles. */
  readonly scope: Scope

  readonly controller = new AbortController()
  readonly children = new Set<Fiber>()
  parent: Maybe<Fiber>

  /**
   * The services whose construction this fiber is running, outermost first.
   *
   * A fiber building `Db` that reaches for `Cache`, whose construction
   * reaches for `Db`, would otherwise wait on itself forever. The chain is
   * inherited across `fork`, so a cycle that crosses a forked fiber is still
   * reported as a cycle rather than becoming a hang.
   */
  chain: readonly string[] = []

  state: FiberState = 'running'
  exit: Maybe<Exit<unknown, unknown>>

  private observers: ((exit: Exit<unknown, unknown>) => void)[] = []
  private detach: Maybe<() => void>

  constructor(start: AnyFx, services: ServiceMap, scope: Scope = new Scope()) {
    this.current = start
    this.services = services
    this.scope = scope
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get interrupted(): boolean {
    return this.controller.signal.aborted
  }

  /**
   * Forks a child whose lifetime is bound to this fiber's.
   *
   * The parent's abort is forwarded by an explicit listener rather than by
   * `AbortSignal.any`, because the listener has to come off *deterministically*
   * when the child settles. Relying on the composite signal being collected
   * would leak one listener per fork on a long-lived parent - one per request,
   * in a server.
   */
  fork(effect: AnyFx): Fiber {
    const child = new Fiber(effect, this.services)
    child.parent = this
    child.chain = this.chain
    this.children.add(child)

    const onParentAbort = (): void => {
      child.controller.abort(this.controller.signal.reason)
    }
    this.signal.addEventListener('abort', onParentAbort, { once: true })

    child.detach = (): void => {
      this.signal.removeEventListener('abort', onParentAbort)
      this.children.delete(child)
    }

    return child
  }

  /** Requests interruption of this fiber and, transitively, its children. */
  interrupt(reason?: string): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason ?? 'interrupted')
    }
  }

  /** Marks the fiber finished and notifies everyone waiting on it. */
  settle(exit: Exit<unknown, unknown>): void {
    if (this.state === 'done') {
      return
    }
    this.state = 'done'
    this.exit = exit
    this.current = undefined

    this.detach?.()
    this.detach = undefined

    const waiting = this.observers
    this.observers = []
    for (const observe of waiting) {
      observe(exit)
    }
  }

  /** Calls back when the fiber settles, immediately if it already has. */
  onSettle(observe: (exit: Exit<unknown, unknown>) => void): void {
    if (this.state === 'done' && this.exit != null) {
      observe(this.exit)
      return
    }
    this.observers.push(observe)
  }

  /**
   * Unwinds to the nearest handler for `cause`, running generator `finally`
   * blocks on the way out.
   *
   * The `iterator.return()` call is what makes `try/finally` inside an `fx`
   * body fire when an effect fails - which is exactly when cleanup matters.
   */
  unwindToHandler(cause: AnyCause): Maybe<{
    apply: (errorOrCause: any) => AnyFx
    all: boolean
  }> {
    while (this.stack.length > 0) {
      const frame = this.stack.pop() as Frame
      if (frame.kind === 'recover' && (frame.all || cause._tag === 'Fail')) {
        return { apply: frame.apply, all: frame.all }
      }
      if (frame.kind === 'gen') {
        frame.iterator.return?.(undefined)
      }
      if (frame.kind === 'services') {
        this.services = frame.restore
      }
    }
    return undefined
  }

  /** Unwinds everything, running `finally` blocks. */
  unwindAll(): void {
    while (this.stack.length > 0) {
      const frame = this.stack.pop() as Frame
      if (frame.kind === 'gen') {
        frame.iterator.return?.(undefined)
      }
      if (frame.kind === 'services') {
        this.services = frame.restore
      }
    }
  }
}
