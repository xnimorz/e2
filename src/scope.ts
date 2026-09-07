import type { Exit } from './cause.ts'
import { Chain, Recover, Suspend, type AnyFx, type Fx } from './fx.ts'
import { Ok } from './result.ts'
import { service } from './service.ts'

export type Finalizer = (exit: Exit<unknown, unknown>) => AnyFx

/**
 * A LIFO stack of finalizers, closed with the outcome that triggered it.
 *
 * Finalizers receive the `Exit` so they can tell success from failure from
 * interruption - commit versus rollback, or "the request was cancelled, do not
 * bill for it". That distinction is the whole reason a scope is not just an
 * array of cleanup callbacks.
 *
 * Closing is resilient: a finalizer that fails, or throws, does not prevent
 * the remaining ones from running. Silent cleanup skipping is far worse than a
 * swallowed cleanup error.
 */
export class Scope {
  /** A fresh, open scope. */
  static readonly make = (): Scope => new Scope()

  private readonly finalizers: Finalizer[] = []
  private closed = false

  get isClosed(): boolean {
    return this.closed
  }

  get size(): number {
    return this.finalizers.length
  }

  addFinalizer(finalizer: Finalizer): void {
    if (this.closed) {
      throw new Error('e2: cannot add a finalizer to a closed scope')
    }
    this.finalizers.push(finalizer)
  }

  /** Runs every finalizer, most recently added first. */
  close(exit: Exit<unknown, unknown>): Fx<void> {
    return new Suspend(() => {
      if (this.closed) {
        return new Ok(undefined) as Fx<void>
      }
      this.closed = true
      const pending = [...this.finalizers].reverse()
      this.finalizers.length = 0

      const step = (index: number): AnyFx => {
        if (index >= pending.length) {
          return new Ok(undefined)
        }
        const finalizer = pending[index] as Finalizer
        // `all` catches defects too, so one broken finalizer cannot strand
        // the rest of the stack.
        const guarded = new Recover(
          new Suspend(() => finalizer(exit)),
          () => new Ok(undefined),
          true
        )
        return new Chain(guarded, () => step(index + 1))
      }

      return step(0) as Fx<void>
    })
  }
}

/**
 * The one dependency a provider may use without declaring it.
 *
 * Every runtime and every scoped effect supplies it, so requiring it to be
 * declared would be noise on every resourceful provider.
 */
export const ScopeService = service<Scope>()('Scope')
export type ScopeService = typeof ScopeService
