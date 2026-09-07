# DI v2: dropping `provider`

Design note for the spike in [`di_v2.ts`](di_v2.ts). Every diagnostic quoted
below was produced by `tsc` 5.9.3 against that file, not recalled.

**Status: implemented** on 2026-09-06. `src/` now matches this note
(`service.ts`, `provider.ts`, `cell.ts`, `run.ts`, `ops.ts#memo`), the
diagnostics fixture pins the new wording, and `prototype/e2` is ported. The
spike stays as the type-level reference and is still part of the typecheck.

## The finding

The explicit dependency tuple in `provider(Target, [Config, Logger], (config,
log) => …)` exists for exactly one reason: `Plan.from` sorts the graph
topologically **before** building anything, and a sort needs its edges up
front. Nothing at the type level needs it. `gen` already infers a body's
dependencies from what it `yield*`s, and `Needs` can be inferred the same way.

So the change is one decision: **build services on demand instead of in a
pre-computed order.** A `yield* Db` inside a provider body builds `Db` on the
spot if it is not built yet, memoised in the runtime. Once construction is
demand-driven:

- the tuple has no job, and goes;
- positional injection goes with it, and a service body reads like every
  other e2 body;
- the "provider uses an undeclared dependency" error class stops existing,
  along with its eight-level diagnostic (README, *Honest limitations*);
- `Plan` goes. Cycles and missing providers are still caught at startup,
  because the runtime demands every provider in list order;
- call-time dependencies become expressible, per method of a contract.

`Check`, `MissingServices`, the flat unordered list, "every service named
once" and the missing-service diagnostic are all unchanged.

## Surface

The whole of DI, plus the one control-flow primitive it leans on:

| | |
|---|---|
| `service<Api>()('Name')` | a contract and its key. Unchanged. |
| `service('Name', function* () { … })` | the same, carrying a default. New. |
| `Db.make(function* () { … })` | an implementation. Dependencies are what the body yields. |
| `Db.of(value)` | an already-built implementation: config, a test double. |
| `memo(fx)` | run `fx` at most once, on first use, sharing the outcome. The lazy-init primitive. |
| `memo(Service)` | the same primitive over a key: record the dependency now, resolve it on first use. Not a new name; a key is an `Fx`. |
| `lazy(provider)` | at the composition root: do not build this one at startup. New. |
| `run(effect, providers)` | unchanged |
| `runtime(providers)` | now also checks the list is closed |

Gone: `provider`, `provider.of`, `provider.sync`, `Provider.make/.of/.sync`,
`Service.make` (duplicate of `service`), `Runtime.make` (duplicate of
`runtime`), `Plan`, positional injection. `Provider` remains as the *type*
`.make`/`.of` return; nobody constructs one by hand. There is deliberately no
whole-graph lazy mode on `runtime`; laziness is declared per provider, at the
root, with `lazy()`. See *Async initialisation*.

Two conventions, no API:

- `interface Db { … }` and `const Db = service<Db>()('Db')` in the same file.
  Type `Db` is the contract, value `Db` is the key, `yield* Db` gives a `Db`,
  helpers take `(db: Db)`. This replaces `DbApi` and `type Db = typeof Db`.
  Measured in the prototype: the `typeof` alias is never referenced; the
  `…Api` names are used only as parameter types, which is what the interface
  now is.
- Implementation-first (`service('Config', function* () { … })`) for leaves
  whose shape *is* the value: config, clocks, an in-memory index.
  Contract-first for anything with more than a couple of methods, so hovers
  say `Mps` rather than a structural type.

## What the prototype looks like

`prototype/e2/src/services/send.ts`, before:

```ts
export interface SendApi { readonly send: (threadId: string, payload: Payload) => Fx<readonly Message[], SendError> }
export const Send = service<SendApi>()('Send')
export type Send = typeof Send

export const SendLive = provider(
  Send,
  [Config, Crypto, Network, Mps],
  function* (config, crypto, network, mps) {
    let counter = 0
    return { send: (threadId, payload) => gen(function* () { … }) }
  }
)
```

After:

```ts
export interface Send { readonly send: (threadId: string, payload: Payload) => Fx<readonly Message[], DomainError> }
export const Send = service<Send>()('Send')

export const SendLive = Send.make(function* () {
  const config = yield* Config
  const crypto = yield* Crypto
  const network = yield* Network
  const mps = yield* Mps
  let counter = 0
  return { send: (threadId, payload) => gen(function* () { … }) }
})
```

Be honest about the line count: it does not go down. Four `yield*` lines
replace one tuple line, exactly as in the Effect version. What goes away is
the double bookkeeping (tuple ↔ parameter list ↔ body), two ceremony lines
per service, and one concept. What arrives is the ability to write
`Fx<Message, DomainError, 'ServerFetch'>` on a single method of a contract and
have only the programs that take that path require it.

The `Prototype` namespace at the bottom of the spike ports `config`, `crypto`,
`network`, `local_store` (on IndexedDB), the four extension points, `mps`,
`send`, the externally owned stages, `registries.ts` and the worker's
`runtime([...])` list, and asserts the inferred `Needs` of each. Compare it
with the real files; the bodies are the same.

## Async initialisation: once, lazily, with the read as the sync point

The case that decides how many laziness knobs there are: MPS reads from a
local store backed by IndexedDB. Opening it is asynchronous, must happen once,
and nothing should wait for it at startup; the first read should wait, and
later reads should find it open. MPS must not know.

Two mechanisms already cover "once": a provider body is an `Fx`, so an
asynchronous open is already expressible as construction, and the runtime
memoises every provider. The only thing missing is moving the *sync point*
from construction to first use without leaking that decision into MPS's
contract. That is one primitive:

```ts
export const LocalStoreLive = LocalStore.make(function* () {
  const config = yield* Config
  // Opened once, on the first read, closed with the runtime.
  const db = yield* memo(
    acquire(
      () => openMessages('messages-' + config.userId),
      (store) => store.close(),
      (reason) => new IdbError(reason)
    )
  )
  return {
    get: (id) => gen(function* () {
      const store = yield* db
      return yield* fromPromise(() => store.get(id), (reason) => new IdbError(reason))
    }),
    …
  }
})
// Provider<'LocalStore', 'Config', never>
```

- `memo(fx)` is `Fx<Fx<Value, Error>, never, Dependency>`. Yielding it does
  not run `fx`; it records `fx`'s requirements against the body it is in (so
  they land in `Needs`), captures the current service map and scope, and hands
  back a **dependency-free** handle. That is why `LocalStore.get` is
  `Fx<Message | undefined, IdbError>` with nothing in the third slot, and why
  MPS's contract and provider are byte-for-byte what they would be over an
  in-memory map.
- Yielding the handle runs `fx` on first demand and joins every concurrent
  demand to that one run. Later demands get the value.
- The run happens against the *captured* map and scope, on a fiber rooted
  there. So the `acquire` registers its close on the runtime scope, not on
  whichever request came first, and a caller that is interrupted while
  waiting simply stops waiting: it does not cancel a shared open.
- Failure is not cached. Joiners receive it, the cell resets, the next demand
  retries. Backoff is composition: `memo(retry(policy)(open))`.
- `memo(fx, { eager: true })` starts the run at the point of creation, in the
  background. Reads that arrive before it settles wait; reads after do not.
  This is the "start it now, but do not block startup on it" shape.
- Outside a provider body it captures the request: `const user = yield*
  memo(db.query(id))` is one query no matter how many times the handle is
  yielded, and it is gone with the request.

The runtime memoises providers with **the same cell**. `resolve(name)` is the
cell for that name; `memo` is an anonymous one. One implementation, so
construction and lazy init cannot disagree about joining, failure,
interruption or teardown.

Consequences for the surface:

- **No lazy *mode* on `runtime`.** Construction stays eager and in list
  order by default, which is what makes a bad graph fail at startup. A
  service keeps whatever is expensive behind `memo`, at the granularity of
  the resource rather than the service.
- **`lazy(provider)` at the root** for the services that should not be built
  at boot at all: a `Send` nobody has used yet, a `Crypto` whose code is
  worth not loading until the first seal. It is the same cell, only skipped
  by the warm-up; the first demander builds it and later demanders join. The
  trade is local and explicit: that service's construction failure reaches
  the first demander as a defect instead of failing startup, and the cell
  resets so the next demand retries.
- **No new name for consumer-side deferral.** `memo(Mps)` is `memo` over a
  key, because a key is an `Fx`. See the next subsection.
- A per-key cache (one open per thread, say) is a `Map` of `memo` handles,
  not a new primitive.

### Send: a dependency needed only after the wire

`send` seals, transmits, then persists. MPS is needed only for the last step,
and at the moment a send happens it may be unbuilt, or halfway through
construction because `Receive` is building it. The consumer says so in one
line, and the resolution happens exactly where the code reaches for it:

```ts
export const SendLive = Send.make(function* () {
  const config = yield* Config
  const crypto = yield* Crypto
  const network = yield* Network
  const lazyMps = yield* memo(Mps)   // recorded in Needs now; resolved later
  …
  send: (threadId, payload) => gen(function* () {
    const envelope = yield* crypto.seal(inbound)
    yield* network.send(envelope)
    const mps = yield* lazyMps       // empty → builds it; inflight → joins; done → returns it
    return yield* mps.ingest(inbound)
  })
})
// Provider<'Send', 'Config' | 'Crypto' | 'Network' | 'Mps', never>   the list is still checked
// Send.send: Fx<readonly Message[], DomainError>                      the contract is untouched
```

`Needs` cannot tell an eager dependency from a deferred one, and should not:
the static check only needs to know the list must contain `Mps`. The runtime
can: `rt.graph()` records who built what, when, and whether it was the
warm-up or a demand. CASE 10 in the spike pins the types, including that
`lazy()` is transparent to the closure check.

## Runtime: demand-driven construction

```
Runtime
  registry : Map<name, Provider>     from the list; a duplicate name is DuplicateProvider, as today
  cells    : Map<name, Cell>         Cell = empty | inflight(fiber, joiners) | done(value)
                                     the same Cell `memo` uses

resolve(name, demander)              the interpreter's `Service` case
  cell done               → the value
  registry lacks name     → Die(MissingProvider(name))       types already ruled this out
  name ∈ demander.chain   → Die(CyclicDependency(chain, name))
  cell inflight           → join                              concurrent demand waits, never rebuilds
  cell empty              → fork provider.build() rooted in the runtime scope, chain = demander.chain + name;
                            on success → done; on failure → empty, joiners get the failure

startup          for each provider not wrapped in lazy(), in list order: resolve(its name)
                 → cycles and missing providers surface at startup, exactly where Plan.from surfaced them
                 → a lazy provider's cell simply stays empty until somebody demands it
teardown         the runtime scope closes in reverse acquisition order, which is dependency order by construction
```

The synchronous interpreter does the same with a nested `interpretSync`
instead of a fiber; an async boundary inside a provider under `runSync` is
`Die(AsyncBoundary)`, as today. `run(effect, providers)` is build, run, close,
as today.

`chain` has to be inherited by fibers a provider forks during construction, so
a cycle that crosses a `fork` is still a cycle rather than a hang. That is the
one genuinely new piece of fiber state.

Because each provider can record which names it demanded while building, the
runtime can expose the *observed* graph (`rt.graph()`), which is a better
debugging tool than `Plan.toString()` was: it shows what actually happened,
including which conditional branches were taken.

## Diagnostics, measured

Missing service, on `run`. Byte-for-byte what e2 prints today:

```
Type 'Fx<User, DbError, "Logger" | "Db">' is not assignable to type '"e2: missing service Logger"'.
```

An open provider list, on `runtime`. **New: today's `runtime` has no static
check at all** and relies on `Plan.from` at startup:

```
Property 'run' does not exist on type '"e2: missing service Clock"'.
```

An abstract service passed where a provider is needed:

```
Type 'Service<"Db", Db>' is missing the following properties from type
'Provider<any, any, any>': provides, build, _Provides, _Needs, _Error
```

An implementation that reaches for a service inside a method the contract
says needs none. This is the successor of the old "undeclared dependency"
error, and it is now a real contract violation rather than bookkeeping. It is
still nine levels deep, and still bottoms out on the useful line:

```
Type 'Fx<{ id: string; }, never, "Logger">' is not assignable to type 'Fx<User, DbError, never>'.
  Type '"Logger"' is not assignable to type 'never'.
```

### How `runtime` got its check

Four shapes were tried (scratch file, same `tsc`):

| shape | result |
|---|---|
| conditional **return** type: `Promise<Runtime<…>>` or the literal | `Property 'run' does not exist on type '"e2: missing service Logger"'.` **Chosen.** |
| intersection on the providers argument | `Provider<"Config", never, never> is not assignable to (… \| …) & string` — the noise NOTES §6 of the first spike predicted |
| rest parameter present only when the graph is open | `Expected 2 arguments, but got 1.` — does not name the service |
| check intersected into the optional `options` argument | silent when `options` is omitted |

The chosen shape has one hole: a `runtime(...)` whose result is never used
compiles. That is the same class as the forgotten-`yield*` guard already
listed under *Honest limitations*, and every real call site uses the result.

## What changes in `src/`

| file | action |
|---|---|
| `service.ts` | add `make` and `of` as methods; add the `(name, body)` overload returning a defaulted service; drop `Service.make` |
| `provider.ts` | becomes the `Provider` type plus two private constructors; delete `MakeProvider`'s constraint, `ProviderSync`, `ServicesFor`, `provider` |
| `plan.ts` | delete, with `plan.spec.ts`. Keep `DuplicateProvider`, `CyclicDependency`, `MissingProvider` in `errors.ts` |
| new `cell.ts` | the memo cell: empty / inflight / done, join, failure resets, rooted fiber |
| `ops.ts` | `memo(fx, { eager })` and `lazy(provider)` on top of the cell |
| `run.ts` | replace `buildSync`/`buildAsync` with the registry + cells + `resolve`; the warm-up skips lazy providers; `runtime` gains the conditional return; drop `Runtime.make` |
| `interpreter.ts` | the `Service` case calls `resolve` instead of `services.get` |
| `fiber.ts` | carry `chain: readonly string[]`, inherited on fork |
| `tests/diagnostics/missing_service.fixture.ts` | CASE 4 (undeclared dependency) is replaced by "contract violated" and "open runtime list"; the spec's expected count and wording follow |
| `README.md` | the *One way to compose providers* section gets simpler; two *Honest limitations* entries go; a short *Lazy initialisation* section |
| `prototype/e2` | mechanical port; the spike shows every shape it needs |

## Trade-offs to decide with eyes open

1. **`of` shares the instance across runtimes.** `LocalStore.of(new Map())`
   in two runtimes is one map. Same as `Layer.succeed`. Stateful doubles use
   `make`.
2. **Conditional dependencies over-approximate.** `if (cfg.cache) yield*
   Cache` puts `Cache` in `Needs` whether or not the branch runs, so the list
   must contain it. Correct, and the price of a static check.
3. **Construction order changes** from Kahn order to list-order,
   demand-first. Any dependency-respecting order is valid and teardown
   reverses whichever happened, so nothing observable depends on it, but a
   test that pins log order will move.
4. **Defaults are never pulled in transitively.** `runtime([Send])` does not
   drag in `Config`. The check works on names, and a name cannot know whether
   it has a default. This keeps "named once" true and is the deliberate
   difference from `Effect.Service`'s `dependencies`.
5. **Mutually dependent services at call time** (CASE 4 in the spike) work
   with no cycle, but each contract must declare the transitive set: `ping`
   needs `'Ping' | 'Pong'`, not just `'Pong'`. The first draft got this wrong
   and `tsc` caught it, which is the point.
6. **`memo` does not cache failure.** A store that fails to open is retried
   by the next read. The opposite policy (cache the failure, fail fast
   forever) is a one-line change in the cell and should be decided once, for
   providers and `memo` alike, since they share it.
7. **`lazy()` trades fail-fast for one service.** A provider wrapped at the
   root is not exercised at startup, so a construction bug in it is found by
   the first user, as a defect. Use it for services that are genuinely
   optional at boot, not as a default.
8. **Not included, deliberately:** a plain-thunk overload for `make`
   (`Db.make(() => value)`). Generator-only keeps one form; `of` covers
   constants. Easy to add later if the `function*` with no `yield*` grates.

## Recommendation

Go. The spike passes, the diagnostic e2 exists for is unchanged, `runtime`
gains a check it was missing, lazy initialisation costs one primitive plus a
root-level marker rather than a runtime mode, and the DI surface drops from
twelve names to eight.
Suggested order: `service.ts` and `provider.ts` types first (the spike is the
reference), then `cell.ts` with the demand-driven `resolve` in
`run.ts`/`interpreter.ts` and `memo` in `ops.ts`, with `di.spec.ts` plus a new
`cell.spec.ts` for joining, failure reset, interrupted joiners, eager start
and scope capture, then delete `plan.ts`, then the diagnostics fixture, then
the prototype port and README.
