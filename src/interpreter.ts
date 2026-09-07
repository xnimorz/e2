import { Die, Fail, Interrupt, type AnyCause, type Exit } from './cause.ts'
import { AsyncBoundary } from './errors.ts'
import {
  Fiber,
  chainFrame,
  genFrame,
  recoverFrame,
  servicesFrame,
  transformFrame,
} from './fiber.ts'
import {
  Async,
  Chain,
  Gen,
  Recover,
  Suspend,
  Sync,
  Transform,
  Raise,
  WithFiber,
  WithServices,
  type AnyFx,
} from './fx.ts'
import { MissingProvider } from './errors.ts'
import { Err, Ok, err, ok } from './result.ts'
import { NOT_FOUND, type ServiceMap } from './service_map.ts'
import { Service } from './service.ts'
import type { Maybe } from './types.ts'

type Instruction =
  | Ok<unknown>
  | Err<unknown>
  | Sync<unknown>
  | Async<unknown, unknown>
  | Suspend<unknown, unknown, never>
  | Gen<unknown, unknown, never>
  | Transform<unknown, unknown, never>
  | Chain<unknown, unknown, never>
  | Recover<unknown, unknown, never>
  | WithServices<unknown, unknown, never>
  | WithFiber<unknown, unknown, never>
  | Raise<unknown, unknown, never>
  | Service<string, unknown>

type Step =
  | { readonly service: 'run'; readonly node: AnyFx }
  | { readonly service: 'ok'; readonly value: unknown }
  | { readonly service: 'fail'; readonly cause: AnyCause }

/** Returned by `reduce` when the fiber has parked on an async operation. */
const PARKED = Symbol('e2/parked')
const RUNNING = Symbol('e2/running')

/**
 * Reductions between yields to the event loop.
 *
 * Without this a hot pure loop would monopolise the thread. Only applies when
 * async is permitted; `runSync` has nowhere to yield to.
 */
const STEP_BUDGET = 2048

interface Driver {
  readonly allowAsync: boolean
  steps: number
}

const drivers = new WeakMap<Fiber, Driver>()

/**
 * Drives a fiber until it settles or parks.
 *
 * A single loop that either reduces one instruction, threads a success value
 * out through the continuation frames, or unwinds a failure to the nearest
 * handler. Nothing recurses, so effect depth is bounded by heap rather than by
 * the JS call stack.
 */
function drive(fiber: Fiber, initial: Step): void {
  const driver = drivers.get(fiber)
  if (driver === undefined) {
    return
  }

  let step = initial

  while (true) {
    if (fiber.state === 'done') {
      return
    }

    // Interruption is observed between instructions, and delivered once. The
    // frames are NOT discarded here: unwinding has to walk them so that
    // `scoped`, `ensuring` and generator `finally` blocks get their chance to
    // run. Only handlers marked `all` will actually catch an interrupt.
    if (fiber.interrupted && !interruptDelivered.has(fiber) && step.service !== 'fail') {
      interruptDelivered.add(fiber)
      step = {
        service: 'fail',
        cause: new Interrupt(String(fiber.signal.reason ?? 'interrupted')),
      }
    }

    if (driver.allowAsync && ++driver.steps >= STEP_BUDGET) {
      driver.steps = 0
      const resumeAt = step
      queueMicrotask(() => drive(fiber, resumeAt))
      return
    }

    if (step.service === 'run') {
      const reduced = reduce(fiber, step.node as Instruction, driver.allowAsync)
      if (reduced === PARKED) {
        return
      }
      step = reduced
      continue
    }

    if (step.service === 'ok') {
      const next = propagate(fiber, step.value)
      if (next === RUNNING) {
        step = { service: 'run', node: fiber.current as AnyFx }
        continue
      }
      if (next.service === 'settled') {
        const finished = complete(fiber, ok(next.value))
        if (finished === RUNNING) {
          step = { service: 'run', node: fiber.current as AnyFx }
          continue
        }
        return
      }
      step = { service: 'fail', cause: next.cause }
      continue
    }

    const handler = fiber.unwindToHandler(step.cause)
    if (handler == null) {
      const finished = complete(fiber, err(step.cause))
      if (finished === RUNNING) {
        step = { service: 'run', node: fiber.current as AnyFx }
        continue
      }
      return
    }

    try {
      const recovered = handler.all
        ? handler.apply(step.cause)
        : handler.apply((step.cause as Fail<unknown>).error)
      step = { service: 'run', node: recovered }
    } catch (thrown) {
      step = { service: 'fail', cause: new Die(thrown) }
    }
  }
}

// --- finalization ----------------------------------------------------------

const finalizing = new WeakSet<Fiber>()

/**
 * Fibers that have already been told they are interrupted.
 *
 * Interruption is delivered exactly once. Everything that runs afterwards -
 * scope finalizers, `ensuring` handlers, a generator's `finally` - runs to
 * completion rather than being re-interrupted on its next instruction. The
 * cost is that a finalizer which hangs cannot itself be cancelled; the
 * alternative is cleanup that silently never happens, which is worse.
 */
const interruptDelivered = new WeakSet<Fiber>()
const pendingExits = new WeakMap<Fiber, Exit<unknown, unknown>>()

const isFinalizing = (fiber: Fiber): boolean => finalizing.has(fiber)

/**
 * Runs the fiber's finalization, then settles it.
 *
 * Structured concurrency lives here: a fiber cannot complete while it still
 * has children, so forked work can never outlive the thing that forked it.
 * Children are interrupted and awaited, then the scope's finalizers run with
 * the outcome that triggered them.
 */
function complete(
  fiber: Fiber,
  exit: Exit<unknown, unknown>
): typeof RUNNING | undefined {
  if (isFinalizing(fiber)) {
    fiber.settle(pendingExits.get(fiber) ?? exit)
    return undefined
  }

  const nothingToDo = fiber.children.size === 0 && fiber.scope.size === 0
  if (nothingToDo) {
    fiber.settle(exit)
    return undefined
  }

  finalizing.add(fiber)
  pendingExits.set(fiber, exit)
  fiber.stack.length = 0
  fiber.current = new Suspend(() => finalizeEffect(fiber, exit))
  return RUNNING
}

function finalizeEffect(fiber: Fiber, exit: Exit<unknown, unknown>): AnyFx {
  const children = [...fiber.children]
  for (const child of children) {
    child.interrupt('parent completed')
  }

  const awaitChildren = new Async<void, never>((resume) => {
    let remaining = children.length
    if (remaining === 0) {
      resume(new Ok(undefined))
      return undefined
    }
    for (const child of children) {
      child.onSettle(() => {
        remaining -= 1
        if (remaining === 0) {
          resume(new Ok(undefined))
        }
      })
    }
    return undefined
  })

  return new Chain(awaitChildren, () => fiber.scope.close(exit))
}

// --- reduction -------------------------------------------------------------

function reduce(
  fiber: Fiber,
  node: Instruction,
  allowAsync: boolean
): Step | typeof PARKED {
  switch (node._tag) {
    case 'Ok':
      return { service: 'ok', value: node.value }

    case 'Err':
      return { service: 'fail', cause: new Fail(node.error) }

    case 'Raise':
      return { service: 'fail', cause: node.cause as AnyCause }

    case 'Sync':
      try {
        return { service: 'ok', value: node.run() }
      } catch (thrown) {
        return { service: 'fail', cause: new Die(thrown) }
      }

    case 'Service': {
      const found = fiber.services.lookup(node.id)
      if (found !== NOT_FOUND) {
        return { service: 'ok', value: found }
      }
      // Not built yet: hand the instruction to the provider's cell, which
      // builds it on this demand or joins a build already in flight.
      const cell = fiber.services.resolvable(node.id)
      if (cell == null) {
        // The types already proved this service was provided, so reaching
        // here means the graph was assembled dynamically. That is a defect.
        return { service: 'fail', cause: new Die(new MissingProvider(node.id)) }
      }
      try {
        fiber.current = cell.demand(fiber)
        return { service: 'run', node: fiber.current }
      } catch (thrown) {
        return { service: 'fail', cause: new Die(thrown) }
      }
    }

    case 'Suspend':
      try {
        fiber.current = node.make()
        return { service: 'run', node: fiber.current }
      } catch (thrown) {
        return { service: 'fail', cause: new Die(thrown) }
      }

    case 'WithFiber':
      try {
        fiber.current = node.use(fiber)
        return { service: 'run', node: fiber.current }
      } catch (thrown) {
        return { service: 'fail', cause: new Die(thrown) }
      }

    case 'Gen':
      try {
        // A fresh generator per reduction: generator objects are single-use.
        fiber.stack.push(genFrame(node.body() as Iterator<unknown, unknown, unknown>))
      } catch (thrown) {
        return { service: 'fail', cause: new Die(thrown) }
      }
      return { service: 'ok', value: undefined }

    case 'Transform':
      fiber.stack.push(transformFrame(node.transform))
      fiber.current = node.source
      return { service: 'run', node: node.source }

    case 'Chain':
      fiber.stack.push(chainFrame(node.transform))
      fiber.current = node.source
      return { service: 'run', node: node.source }

    case 'Recover':
      fiber.stack.push(recoverFrame(node.recover, node.all))
      fiber.current = node.source
      return { service: 'run', node: node.source }

    case 'WithServices':
      fiber.stack.push(servicesFrame(fiber.services))
      fiber.services = fiber.services.withAll(
        node.overrides as readonly (readonly [Service<string, unknown>, unknown])[]
      )
      fiber.current = node.source
      return { service: 'run', node: node.source }

    case 'Async':
      return park(fiber, node, allowAsync)

    default:
      return {
        service: 'fail',
        cause: new Die(
          new Error(`e2: unknown instruction ${String((node as { _tag?: unknown })._tag)}`)
        ),
      }
  }
}

/**
 * Suspends the fiber on the one asynchronous instruction.
 *
 * Handles three cases: `register` resuming synchronously (common for an
 * already-resolved promise), resuming later, and the fiber being interrupted
 * while parked - in which case the registered cleanup runs and any late resume
 * is ignored.
 */
function park(
  fiber: Fiber,
  node: Async<unknown, unknown>,
  allowAsync: boolean
): Step | typeof PARKED {
  if (!allowAsync) {
    // Not unwound: finalizers still deserve to run before this surfaces.
    return { service: 'fail', cause: new Die(new AsyncBoundary()) }
  }

  let done = false
  let immediate: Maybe<AnyFx>
  let cleanup: Maybe<() => void>

  const onAbort = (): void => {
    if (done) {
      return
    }
    done = true
    interruptDelivered.add(fiber)
    try {
      cleanup?.()
    } catch {
      // A failing cleanup must not mask the interruption.
    }
    fiber.state = 'running'
    drive(fiber, {
      service: 'fail',
      cause: new Interrupt(String(fiber.signal.reason ?? 'interrupted')),
    })
  }

  const resume = (result: AnyFx): void => {
    if (done) {
      return
    }
    done = true
    fiber.signal.removeEventListener('abort', onAbort)
    if (fiber.state === 'suspended') {
      fiber.state = 'running'
      drive(fiber, { service: 'run', node: result })
    } else {
      immediate = result
    }
  }

  try {
    cleanup = node.register(resume as (result: AnyFx) => void, fiber.signal) ?? undefined
  } catch (thrown) {
    done = true
    return { service: 'fail', cause: new Die(thrown) }
  }

  if (immediate != null) {
    return { service: 'run', node: immediate }
  }
  if (done) {
    // Resumed synchronously with a value we already consumed, or aborted.
    return PARKED
  }

  // Once interruption has been delivered the signal is spent: work parked
  // during cleanup must be allowed to finish.
  if (!interruptDelivered.has(fiber)) {
    if (fiber.signal.aborted) {
      onAbort()
      return PARKED
    }
    fiber.signal.addEventListener('abort', onAbort, { once: true })
  }

  fiber.state = 'suspended'
  return PARKED
}

// --- propagation -----------------------------------------------------------

type Propagated =
  | typeof RUNNING
  | { readonly service: 'settled'; readonly value: unknown }
  | { readonly service: 'failed'; readonly cause: AnyCause }

/**
 * Threads a success value out through the continuation frames.
 *
 * Generator frames are peeked rather than popped, because a generator that is
 * not done stays on the stack to receive the next value. That is what keeps
 * native `yield*` delegation depth at one: the interpreter, not the engine,
 * holds the chain.
 */
function propagate(fiber: Fiber, initial: unknown): Propagated {
  let value = initial

  while (fiber.stack.length > 0) {
    const frame = fiber.stack[fiber.stack.length - 1] as NonNullable<
      (typeof fiber.stack)[number]
    >

    if (frame.kind === 'gen') {
      let progress: IteratorResult<unknown, unknown>
      try {
        progress = frame.iterator.next(value)
      } catch (thrown) {
        fiber.stack.pop()
        return { service: 'failed', cause: new Die(thrown) }
      }
      if (progress.done === true) {
        fiber.stack.pop()
        value = progress.value
        continue
      }
      fiber.current = progress.value as AnyFx
      return RUNNING
    }

    fiber.stack.pop()

    switch (frame.kind) {
      case 'transform':
        try {
          value = frame.apply(value)
        } catch (thrown) {
          return { service: 'failed', cause: new Die(thrown) }
        }
        continue

      case 'chain':
        try {
          fiber.current = frame.apply(value)
        } catch (thrown) {
          return { service: 'failed', cause: new Die(thrown) }
        }
        return RUNNING

      case 'recover':
        continue

      case 'services':
        fiber.services = frame.restore
        continue
    }
  }

  return { service: 'settled', value }
}

// --- entry points ----------------------------------------------------------

/** Whether the fiber may park. A fiber nobody has started yet may. */
export function asyncAllowed(fiber: Fiber): boolean {
  return drivers.get(fiber)?.allowAsync ?? true
}

/** Starts a fiber. Returns once it settles or parks. */
export function start(fiber: Fiber, allowAsync: boolean): void {
  drivers.set(fiber, { allowAsync, steps: 0 })
  const first = fiber.current
  if (first == null) {
    fiber.settle(err(new Die(new Error('e2: started a fiber with no instruction'))))
    return
  }
  drive(fiber, { service: 'run', node: first })
}

/** Runs an effect to completion without ever suspending. */
export function interpretSync(
  effect: AnyFx,
  services: ServiceMap
): Exit<unknown, unknown> {
  const fiber = new Fiber(effect, services)
  start(fiber, false)
  return (
    fiber.exit ??
    err(new Die(new AsyncBoundary('the fiber parked despite async being disallowed')))
  )
}

/** Runs an effect to completion, awaiting anything asynchronous. */
export function interpretAsync(
  effect: AnyFx,
  services: ServiceMap,
  scope?: import('./scope.ts').Scope
): Promise<Exit<unknown, unknown>> {
  const fiber = new Fiber(effect, services, scope)
  return new Promise((resolve) => {
    fiber.onSettle(resolve)
    start(fiber, true)
  })
}

export { Fiber }
