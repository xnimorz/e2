import { Die, squash, type Exit } from './cause.ts'
import { Cell } from './cell.ts'
import { DuplicateProvider, ProviderFailed } from './errors.ts'
import { Fiber } from './fiber.ts'
import { Raise, Recover, type AnyFx, type Fx } from './fx.ts'
import { interpretAsync, interpretSync, start } from './interpreter.ts'
import type {
  AnyProvider,
  Check,
  CheckAgainst,
  FailsWith,
  MissingMsg,
  MissingServices,
  ProvidesOf,
} from './provider.ts'
import { err, ok, type Result } from './result.ts'
import { Scope, ScopeService } from './scope.ts'
import { ServiceMap } from './service_map.ts'

interface Graph {
  readonly services: ServiceMap
  readonly cells: ReadonlyMap<string, Cell>
  readonly edges: ReadonlyMap<string, Set<string>>
}

/**
 * A lazy provider is built inside somebody's request. Its typed failure
 * cannot be in that request's signature, so it becomes a defect that names
 * the service. Eager providers keep their typed failure: the warm-up is what
 * `run`'s `FailsWith` describes.
 */
const asDefect = (name: string, effect: AnyFx): AnyFx =>
  new Recover(effect, (error: unknown) => new Raise(new Die(new ProviderFailed(name, error))))

/**
 * Registers every provider as a cell behind an empty root map.
 *
 * Nothing is built here. A duplicate name is the one thing that can be
 * wrong with a list before running it, and it is a defect: the types already
 * proved the graph at every statically written call site, so reaching it
 * means the provider array was assembled dynamically, and that is a bug.
 */
function prepare(providers: readonly AnyProvider[], scope: Scope): Result<Graph, Die> {
  const cells = new Map<string, Cell>()
  const edges = new Map<string, Set<string>>()
  const services = ServiceMap.root(cells)
  services.unsafeSet(ScopeService, scope)

  const firstIndex = new Map<string, number>()
  for (const [index, provider] of providers.entries()) {
    const name = provider.provides.id
    const existing = firstIndex.get(name)
    if (existing !== undefined) {
      return err(new Die(new DuplicateProvider(name, [existing, index])))
    }
    firstIndex.set(name, index)

    edges.set(name, new Set())
    const build = provider.lazy
      ? () => asDefect(name, provider.build())
      : provider.build
    cells.set(
      name,
      new Cell(name, build, services, (by, need) => edges.get(by)?.add(need))
    )
  }
  return ok({ services, cells, edges })
}

/**
 * Builds every provider not marked lazy, in list order, each on first demand.
 *
 * Demanding a provider is just interpreting its service key: the `Service`
 * instruction misses the map and falls through to the cell, which runs the
 * body, and every `yield* Other` inside does the same recursively. So the
 * order of construction is dependency order without anybody sorting, a cycle
 * is reported by the fiber chain, and a service nothing supplies is a
 * `MissingProvider` defect - all at startup, exactly where a pre-computed
 * plan used to report them.
 */
function warmSync(providers: readonly AnyProvider[], services: ServiceMap): Exit<void, unknown> {
  for (const provider of providers) {
    if (provider.lazy) continue
    const built = interpretSync(provider.provides, services)
    if (!built.ok) {
      return built
    }
  }
  return ok(undefined)
}

async function warmAsync(
  providers: readonly AnyProvider[],
  services: ServiceMap
): Promise<Exit<void, unknown>> {
  for (const provider of providers) {
    if (provider.lazy) continue
    const built = await interpretAsync(provider.provides, services)
    if (!built.ok) {
      // Everything built so far is torn down by the caller closing the scope.
      return built
    }
  }
  return ok(undefined)
}

// --- synchronous entry points ----------------------------------------------

/**
 * Runs an effect with no possibility of suspending, returning the outcome.
 *
 * Never throws. Reaching an asynchronous operation - in the effect or in any
 * provider - produces `Die(AsyncBoundary)` rather than a silent hang.
 */
export function runSyncExit<
  Value,
  Error,
  Dependency extends string,
  Providers extends readonly AnyProvider[],
>(
  effect: Fx<Value, Error, Dependency> & Check<Dependency, Providers>,
  providers: Providers
): Exit<Value, Error | FailsWith<Providers[number]>> {
  type Out = Exit<Value, Error | FailsWith<Providers[number]>>
  const scope = new Scope()
  const graph = prepare(providers, scope)
  if (!graph.ok) {
    return graph as Out
  }
  const { services } = graph.value
  const warmed = warmSync(providers, services)
  if (!warmed.ok) {
    interpretSync(scope.close(warmed), services)
    return warmed as Out
  }
  const outcome = interpretSync(effect as AnyFx, services)
  const closed = interpretSync(scope.close(outcome), services)
  return (closed.ok ? outcome : closed) as Out
}

/**
 * Runs an effect with no possibility of suspending.
 *
 * Expected failures come back as `Err`; defects and interruption are thrown,
 * because they are bugs rather than outcomes. Intended for tests and genuinely
 * synchronous pipelines - anything doing I/O wants `run`.
 */
export function runSync<
  Value,
  Error,
  Dependency extends string,
  Providers extends readonly AnyProvider[],
>(
  effect: Fx<Value, Error, Dependency> & Check<Dependency, Providers>,
  providers: Providers
): Result<Value, Error | FailsWith<Providers[number]>> {
  const exit = runSyncExit(effect, providers)
  if (exit.ok) {
    return exit
  }
  if (exit.error._tag === 'Fail') {
    return err(exit.error.error)
  }
  throw squash(exit.error)
}

// --- asynchronous entry points ---------------------------------------------

/**
 * Runs an effect, awaiting anything asynchronous. Never rejects.
 *
 * The `Check` intersection is what turns a missing service into a readable
 * compile error: when the graph is complete it resolves to `unknown` and the
 * intersection collapses, and when it is not the parameter becomes a literal
 * naming what is absent.
 */
export async function runExit<
  Value,
  Error,
  Dependency extends string,
  Providers extends readonly AnyProvider[],
>(
  effect: Fx<Value, Error, Dependency> & Check<Dependency, Providers>,
  providers: Providers
): Promise<Exit<Value, Error | FailsWith<Providers[number]>>> {
  type Out = Exit<Value, Error | FailsWith<Providers[number]>>
  const scope = new Scope()
  const graph = prepare(providers, scope)
  if (!graph.ok) {
    return graph as Out
  }
  const { services } = graph.value
  const warmed = await warmAsync(providers, services)
  if (!warmed.ok) {
    await interpretAsync(scope.close(warmed), services)
    return warmed as Out
  }
  const outcome = await interpretAsync(effect as AnyFx, services)
  const closed = await interpretAsync(scope.close(outcome), services)
  return (closed.ok ? outcome : closed) as Out
}

/**
 * Runs an effect, awaiting anything asynchronous.
 *
 * Expected failures come back as `Err`. Defects and interruption *reject*,
 * because they are bugs rather than outcomes - folding them into the error
 * channel would force every call site to handle `Error | Defect` and make
 * exhaustive recovery impossible. Use `runExit` to observe them.
 */
export async function run<
  Value,
  Error,
  Dependency extends string,
  Providers extends readonly AnyProvider[],
>(
  effect: Fx<Value, Error, Dependency> & Check<Dependency, Providers>,
  providers: Providers
): Promise<Result<Value, Error | FailsWith<Providers[number]>>> {
  const exit = await runExit(effect, providers)
  if (exit.ok) {
    return exit
  }
  if (exit.error._tag === 'Fail') {
    return err(exit.error.error)
  }
  throw squash(exit.error)
}

// --- long-lived runtimes ---------------------------------------------------

/** One service as the runtime has seen it so far. */
export interface ServiceReport {
  /** `done` once built; `inflight` while building; `empty` if lazy and unused, or reset by a failure. */
  readonly status: 'empty' | 'inflight' | 'done'
  /** Whether the warm-up skipped it. */
  readonly lazy: boolean
  /** The services its construction demanded, in the order first seen. */
  readonly demanded: readonly string[]
}

/**
 * A built service graph that survives across many runs.
 *
 * The production entry point: services are constructed once, and because the
 * provided set is concrete the missing-dependency diagnostic collapses to a
 * single line. Implements `AsyncDisposable`, so `await using` tears the graph
 * down in reverse acquisition order - but consuming it that way is optional,
 * `close()` does the same thing.
 */
export class Runtime<Provided extends string> {
  constructor(
    private readonly services: ServiceMap,
    private readonly scope: Scope,
    private readonly cells: ReadonlyMap<string, Cell>,
    private readonly edges: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly lazyNames: ReadonlySet<string>
  ) {}

  runExit<Value, Error, Dependency extends string>(
    effect: Fx<Value, Error, Dependency> & CheckAgainst<Dependency, Provided>
  ): Promise<Exit<Value, Error>> {
    return interpretAsync(effect as AnyFx, this.services) as Promise<Exit<Value, Error>>
  }

  async run<Value, Error, Dependency extends string>(
    effect: Fx<Value, Error, Dependency> & CheckAgainst<Dependency, Provided>
  ): Promise<Result<Value, Error>> {
    const exit = await this.runExit(effect)
    if (exit.ok) {
      return exit
    }
    if (exit.error._tag === 'Fail') {
      return err(exit.error.error)
    }
    throw squash(exit.error)
  }

  /** Runs an effect on a detached fiber and hands back its handle. */
  fork<Value, Error, Dependency extends string>(
    effect: Fx<Value, Error, Dependency> & CheckAgainst<Dependency, Provided>
  ): Fiber {
    const fiber = new Fiber(effect as AnyFx, this.services)
    start(fiber, true)
    return fiber
  }

  /**
   * The graph as it was actually exercised.
   *
   * Observed, not declared: each entry lists the services a provider's body
   * demanded while building, so it shows which conditional branches ran and
   * which lazy providers nobody has touched yet.
   */
  graph(): Record<string, ServiceReport> {
    const report: Record<string, ServiceReport> = {}
    for (const [name, cell] of this.cells) {
      report[name] = {
        status: cell.status,
        lazy: this.lazyNames.has(name),
        demanded: [...(this.edges.get(name) ?? [])],
      }
    }
    return report
  }

  /** Releases every resource, most recently acquired first. */
  async close(): Promise<void> {
    for (const cell of this.cells.values()) {
      cell.interrupt('runtime closed')
    }
    await interpretAsync(this.scope.close(ok(undefined)), this.services)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

/**
 * The type `runtime` returns: the built runtime when the list is closed,
 * otherwise a literal naming what is missing.
 *
 * A conditional *return* type is the one shape that both names the service
 * and cannot be bypassed. Intersecting the check into the providers argument
 * produces `Provider<...> & string` noise; a conditional rest parameter says
 * only "expected 2 arguments"; a check on an optional options argument is
 * silent when the argument is omitted. With this shape the next line reads
 * `Property 'run' does not exist on type '"e2: missing service Logger"'`.
 */
export type RuntimeOf<Providers extends readonly AnyProvider[]> = [
  MissingServices<never, Providers>,
] extends [never]
  ? Promise<Runtime<ProvidesOf<Providers[number]>>>
  : MissingMsg<MissingServices<never, Providers>>

/**
 * Builds a service graph once, for repeated use.
 *
 * Every provider not marked `lazy` is built now, in list order; a lazy one is
 * built by whoever demands it first. Rejects if a provider fails during
 * construction, tearing down whatever was already built - a half-constructed
 * application is not something to hand back to a caller.
 */
export function runtime<Providers extends readonly AnyProvider[]>(
  providers: Providers
): RuntimeOf<Providers> {
  return build(providers) as RuntimeOf<Providers>
}

async function build(providers: readonly AnyProvider[]): Promise<Runtime<string>> {
  const scope = new Scope()
  const graph = prepare(providers, scope)
  if (!graph.ok) {
    throw squash(graph.error)
  }
  const { services, cells, edges } = graph.value
  const warmed = await warmAsync(providers, services)
  if (!warmed.ok) {
    await interpretAsync(scope.close(warmed), services)
    throw squash(warmed.error)
  }
  const lazyNames = new Set(
    providers.filter((provider) => provider.lazy).map((provider) => provider.provides.id)
  )
  return new Runtime(services, scope, cells, edges, lazyNames)
}
