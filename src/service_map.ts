import type { Fiber } from './fiber.ts'
import type { AnyFx } from './fx.ts'
import type { AnyService, Service } from './service.ts'
import { MissingProvider } from './errors.ts'
import type { Maybe } from './types.ts'

/**
 * The runtime side of dependency injection: service name -> implementation.
 *
 * Keyed by `id` (a string) rather than by object identity, so two copies of a
 * service module in one bundle still resolve to the same entry instead of
 * silently producing two disjoint keys.
 *
 * A map is a copy-on-write overlay over an optional parent. Creating an
 * override is O(1) and reading is O(depth), where depth is 1 or 2 in practice
 * (a runtime, plus a request scope or a set of test doubles). That is what
 * makes `scoped` and test substitution cheap.
 *
 * The root of a runtime's chain also carries the **registry**: one cell per
 * provider, built on first demand. A lookup that misses every layer falls
 * through to the registry, which is how a `yield* Db` builds `Db` on the spot.
 */

/** Distinguishes "absent" from a value that really is undefined. */
export const NOT_FOUND: unique symbol = Symbol('e2/not-found')
export type NotFound = typeof NOT_FOUND

/** Something the interpreter can ask to produce a service: a cell. */
export interface Resolvable {
  demand(fiber: Fiber): AnyFx
}

export class ServiceMap {
  private constructor(
    private readonly parent: Maybe<ServiceMap>,
    private readonly own: Map<string, unknown>,
    private readonly cells: Maybe<ReadonlyMap<string, Resolvable>>
  ) {}

  static empty(): ServiceMap {
    return new ServiceMap(undefined, new Map(), undefined)
  }

  static of(entries: Map<string, unknown>): ServiceMap {
    return new ServiceMap(undefined, entries, undefined)
  }

  /** The root of a runtime: empty, with a registry of providers behind it. */
  static root(cells: ReadonlyMap<string, Resolvable>): ServiceMap {
    return new ServiceMap(undefined, new Map(), cells)
  }

  /**
   * Walks the overlay chain. Presence is decided by `Map.has`, not by the
   * value being non-undefined, so an implementation that is legitimately
   * `undefined` or `null` does not read as absent and fall through to a
   * parent layer.
   */
  lookup(id: string): unknown | NotFound {
    let current: Maybe<ServiceMap> = this
    while (current != null) {
      if (current.own.has(id)) {
        return current.own.get(id)
      }
      current = current.parent
    }
    return NOT_FOUND
  }

  /** The registry entry for a service nobody has built yet, if there is one. */
  resolvable(id: string): Maybe<Resolvable> {
    let current: Maybe<ServiceMap> = this
    while (current != null) {
      const cell = current.cells?.get(id)
      if (cell !== undefined) {
        return cell
      }
      current = current.parent
    }
    return undefined
  }

  getMaybe<Name extends string, Api>(key: Service<Name, Api>): Maybe<Api> {
    const found = this.lookup(key.id)
    return found === NOT_FOUND ? undefined : (found as Api)
  }

  get<Name extends string, Api>(key: Service<Name, Api>): Api {
    const found = this.lookup(key.id)
    if (found === NOT_FOUND) {
      throw new MissingProvider(key.id)
    }
    return found as Api
  }

  /** Whether the service has been built or overlaid. A registered but unbuilt provider is not `has`. */
  has(key: AnyService): boolean {
    return this.lookup(key.id) !== NOT_FOUND
  }

  /** A child map overriding a single service. The receiver is untouched. */
  with<Name extends string, Api>(
    key: Service<Name, Api>,
    implementation: NoInfer<Api>
  ): ServiceMap {
    return new ServiceMap(this, new Map([[key.id, implementation]]), undefined)
  }

  /** A child map overriding several services at once. */
  withAll(overrides: readonly (readonly [AnyService, unknown])[]): ServiceMap {
    return new ServiceMap(
      this,
      new Map(overrides.map(([key, implementation]) => [key.id, implementation])),
      undefined
    )
  }

  /** An empty child, for a request or fiber scope to write into. */
  child(): ServiceMap {
    return new ServiceMap(this, new Map(), undefined)
  }

  /**
   * Writes into this map's own layer.
   *
   * The runtime uses this for the scope and for each service as its cell
   * settles. Everything downstream goes through `with`.
   */
  unsafeSet<Name extends string, Api>(
    key: Service<Name, Api>,
    implementation: NoInfer<Api>
  ): void {
    this.own.set(key.id, implementation)
  }

  /** Every service name visible from here, nearest layer winning. */
  names(): string[] {
    const seen = new Set<string>()
    let current: Maybe<ServiceMap> = this
    while (current != null) {
      for (const name of current.own.keys()) {
        seen.add(name)
      }
      current = current.parent
    }
    return [...seen].sort()
  }
}

/** Convenience for tests: a map built from service/implementation pairs. */
export function services(
  ...entries: readonly (readonly [AnyService, unknown])[]
): ServiceMap {
  return ServiceMap.of(
    new Map(entries.map(([key, implementation]) => [key.id, implementation]))
  )
}
