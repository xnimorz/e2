import { Die, type Exit } from './cause.ts'
import { CyclicDependency } from './errors.ts'
import { Fiber } from './fiber.ts'
import { Async, Raise, type AnyFx } from './fx.ts'
import { asyncAllowed, start } from './interpreter.ts'
import { Ok } from './result.ts'
import type { Resolvable, ServiceMap } from './service_map.ts'
import type { Maybe } from './types.ts'

const fromExit = (exit: Exit<unknown, unknown>): AnyFx =>
  exit.ok ? new Ok(exit.value) : new Raise(exit.error)

export type CellStatus = 'empty' | 'inflight' | 'done'

/**
 * Runs an effect at most once and shares the outcome.
 *
 * One mechanism behind two features. The runtime keeps a cell per provider,
 * so a service is built on first demand and never twice; `memo` hands out
 * anonymous cells, so a provider can keep an expensive resource behind one
 * and let the first *use* be the thing that waits. Because they are the same
 * class, construction and lazy initialisation cannot disagree about joining,
 * failure, interruption or teardown.
 *
 * Three rules, all visible from the outside:
 *
 * - The effect runs on a fiber of its own, **with no parent**, against the
 *   service map captured when the cell was made. A demander that is
 *   interrupted while waiting simply stops waiting; it cannot cancel a shared
 *   construction. An `acquire` inside registers on the scope the cell was
 *   created in, not on whichever request happened to be first.
 * - Concurrent demands join the one run. The value is written once.
 * - Failure is not cached. Every joiner receives it, the cell goes back to
 *   `empty`, and the next demand tries again.
 *
 * A demand from inside the cell's own construction - `Db` needs `Cache`
 * needs `Db` - is a `CyclicDependency` defect naming the loop, detected via
 * the demanding fiber's `chain`.
 */
export class Cell implements Resolvable {
  private state: CellStatus = 'empty'
  private fiber: Maybe<Fiber>
  private value: unknown

  constructor(
    readonly name: string,
    /** Called once per attempt: a fresh effect each time. */
    private readonly make: () => AnyFx,
    /** The map the effect runs against - the scope inside it is what `acquire` sees. */
    private readonly services: ServiceMap,
    /** Reports `demander -> this`, for the runtime's observed graph. */
    private readonly observe?: (by: string, name: string) => void
  ) {}

  get status(): CellStatus {
    return this.state
  }

  /**
   * An effect producing the cell's value, starting the run if nothing has.
   *
   * Resolves synchronously whenever it can: a value already built, or a run
   * that settles without parking. That is what lets `runSync` build a graph
   * of synchronous providers without ever touching an `Async` instruction.
   */
  demand(demander: Fiber): AnyFx {
    const by = demander.chain[demander.chain.length - 1]
    if (by !== undefined) {
      this.observe?.(by, this.name)
    }

    if (this.state === 'done') {
      return new Ok(this.value)
    }

    const at = demander.chain.indexOf(this.name)
    if (at !== -1) {
      return new Raise(
        new Die(new CyclicDependency([...demander.chain.slice(at), this.name]))
      )
    }

    const fiber =
      this.state === 'inflight' && this.fiber != null
        ? this.fiber
        : this.start(demander.chain, asyncAllowed(demander))

    if (fiber.exit != null) {
      return fromExit(fiber.exit)
    }
    return new Async<unknown, unknown>((resume) => {
      fiber.onSettle((exit) => resume(fromExit(exit) as never))
      return undefined
    })
  }

  /**
   * Starts the run without waiting for it. Idempotent while in flight.
   *
   * `allowAsync` follows the fiber that triggered the start, so a provider
   * that parks under `runSync` fails with `AsyncBoundary` exactly as it
   * would have when built in the caller's own fiber.
   */
  start(chain: readonly string[], allowAsync = true): Fiber {
    if (this.fiber != null) {
      return this.fiber
    }
    const fiber = new Fiber(this.make(), this.services)
    fiber.chain = [...chain, this.name]
    this.state = 'inflight'
    this.fiber = fiber

    fiber.onSettle((exit) => {
      this.fiber = undefined
      if (exit.ok) {
        this.state = 'done'
        this.value = exit.value
      } else {
        this.state = 'empty'
      }
    })

    start(fiber, allowAsync)
    return fiber
  }

  /** Interrupts a run in flight, if any. Joiners see the interruption. */
  interrupt(reason?: string): void {
    this.fiber?.interrupt(reason)
  }
}
