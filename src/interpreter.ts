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

/**
 * What the drive loop does next.
 *
 * `RUN` reduces `fiber.current`. `OK` threads `out` as a success value through
 * the frames; `FAIL` unwinds with `out` as the cause. These were `Step` objects,
 * one allocated per instruction - on a sync run, a measurable share of the
 * total - so the kind is a small integer and the payload travels separately.
 */
const RUN = 0
const OK = 1
const FAIL = 2
type Mode = typeof RUN | typeof OK | typeof FAIL

/**
 * The payload of the `Mode` that `reduce`, `park` or `propagate` just
 * returned: a value for `OK`, a cause for `FAIL`.
 *
 * A register rather than a return value, so that returning one costs nothing.
 * Each writer assigns it as its very last act, after any user code that might
 * re-enter the interpreter, and `drive` reads it straight back - so a nested
 * run can never leave its payload for the outer one to pick up.
 */
let out: unknown

/** Returned by `reduce` when the fiber has parked on an async operation. */
const PARKED = 3
const RUNNING = Symbol('e2/running')

/**
 * Reductions between yields to the event loop.
 *
 * Without this a hot pure loop would monopolise the thread. Only applies when
 * async is permitted; `runSync` has nowhere to yield to.
 */
const STEP_BUDGET = 2048

/**
 * Drives a fiber until it settles or parks.
 *
 * A single loop that either reduces one instruction, threads a success value
 * out through the continuation frames, or unwinds a failure to the nearest
 * handler. Nothing recurses, so effect depth is bounded by heap rather than by
 * the JS call stack.
 */
function drive(fiber: Fiber, initial: Mode, payload: unknown): void {
  if (!fiber.started) {
    return
  }

  let mode = initial

  while (true) {
    if (fiber.state === 'done') {
      return
    }

    // Interruption is observed between instructions, and delivered once. The
    // frames are NOT discarded here: unwinding has to walk them so that
    // `scoped`, `ensuring` and generator `finally` blocks get their chance to
    // run. Only handlers marked `all` will actually catch an interrupt.
    if (fiber.interrupted && !fiber.interruptDelivered && mode !== FAIL) {
      fiber.interruptDelivered = true
      mode = FAIL
      payload = new Interrupt(String(fiber.signal.reason ?? 'interrupted'))
    }

    if (fiber.allowAsync && ++fiber.steps >= STEP_BUDGET) {
      fiber.steps = 0
      const resumeMode = mode
      const resumePayload = payload
      queueMicrotask(() => drive(fiber, resumeMode, resumePayload))
      return
    }

    if (mode === RUN) {
      const reduced = reduce(fiber, fiber.current as Instruction, fiber.allowAsync)
      if (reduced === PARKED) {
        return
      }
      mode = reduced
      payload = out
      continue
    }

    if (mode === OK) {
      const next = propagate(fiber, payload)
      if (next === RUN) {
        mode = RUN
        continue
      }
      if (next === OK) {
        if (complete(fiber, ok(out)) === RUNNING) {
          mode = RUN
          continue
        }
        return
      }
      mode = FAIL
      payload = out
      continue
    }

    const cause = payload as AnyCause
    const handler = fiber.unwindToHandler(cause)
    if (handler == null) {
      if (complete(fiber, err(cause)) === RUNNING) {
        mode = RUN
        continue
      }
      return
    }

    try {
      fiber.current = handler.all
        ? handler.apply(cause)
        : handler.apply((cause as Fail<unknown>).error)
      mode = RUN
    } catch (thrown) {
      payload = new Die(thrown)
    }
  }
}

// --- finalization ----------------------------------------------------------

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
  if (fiber.finalizing) {
    fiber.settle(fiber.pendingExit ?? exit)
    return undefined
  }

  if (!fiber.hasFinalization) {
    fiber.settle(exit)
    return undefined
  }

  fiber.finalizing = true
  fiber.pendingExit = exit
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

/** Sets `out` and returns `FAIL`, for the many places a reduction dies. */
function die(thrown: unknown): typeof FAIL {
  out = new Die(thrown)
  return FAIL
}

function reduce(fiber: Fiber, node: Instruction, allowAsync: boolean): Mode | typeof PARKED {
  switch (node._tag) {
    case 'Ok':
      out = node.value
      return OK

    case 'Err':
      out = new Fail(node.error)
      return FAIL

    case 'Raise':
      out = node.cause
      return FAIL

    case 'Sync':
      try {
        out = node.run()
        return OK
      } catch (thrown) {
        return die(thrown)
      }

    case 'Service': {
      const found = fiber.services.lookup(node.id)
      if (found !== NOT_FOUND) {
        out = found
        return OK
      }
      // Not built yet: hand the instruction to the provider's cell, which
      // builds it on this demand or joins a build already in flight.
      const cell = fiber.services.resolvable(node.id)
      if (cell == null) {
        // The types already proved this service was provided, so reaching
        // here means the graph was assembled dynamically. That is a defect.
        return die(new MissingProvider(node.id))
      }
      try {
        const built = cell.built(fiber)
        if (built !== NOT_FOUND) {
          out = built
          return OK
        }
        fiber.current = cell.join(fiber)
        return RUN
      } catch (thrown) {
        return die(thrown)
      }
    }

    case 'Suspend':
      try {
        fiber.current = node.make()
        return RUN
      } catch (thrown) {
        return die(thrown)
      }

    case 'WithFiber':
      try {
        fiber.current = node.use(fiber)
        return RUN
      } catch (thrown) {
        return die(thrown)
      }

    case 'Gen':
      try {
        // A fresh generator per reduction: generator objects are single-use.
        fiber.stack.push(genFrame(node.body() as Iterator<unknown, unknown, unknown>))
      } catch (thrown) {
        return die(thrown)
      }
      out = undefined
      return OK

    case 'Transform':
      fiber.stack.push(transformFrame(node.transform))
      fiber.current = node.source
      return RUN

    case 'Chain':
      fiber.stack.push(chainFrame(node.transform))
      fiber.current = node.source
      return RUN

    case 'Recover':
      fiber.stack.push(recoverFrame(node.recover, node.all))
      fiber.current = node.source
      return RUN

    case 'WithServices':
      fiber.stack.push(servicesFrame(fiber.services))
      fiber.services = fiber.services.withAll(
        node.overrides as readonly (readonly [Service<string, unknown>, unknown])[]
      )
      fiber.current = node.source
      return RUN

    case 'Async':
      return park(fiber, node, allowAsync)

    default:
      return die(
        new Error(`e2: unknown instruction ${String((node as { _tag?: unknown })._tag)}`)
      )
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
): Mode | typeof PARKED {
  if (!allowAsync) {
    // Not unwound: finalizers still deserve to run before this surfaces.
    return die(new AsyncBoundary())
  }

  let done = false
  let immediate: Maybe<AnyFx>
  let cleanup: Maybe<() => void>

  const onAbort = (): void => {
    if (done) {
      return
    }
    done = true
    fiber.interruptDelivered = true
    try {
      cleanup?.()
    } catch {
      // A failing cleanup must not mask the interruption.
    }
    fiber.state = 'running'
    drive(fiber, FAIL, new Interrupt(String(fiber.signal.reason ?? 'interrupted')))
  }

  const resume = (result: AnyFx): void => {
    if (done) {
      return
    }
    done = true
    fiber.signal.removeEventListener('abort', onAbort)
    if (fiber.state === 'suspended') {
      fiber.state = 'running'
      fiber.current = result
      drive(fiber, RUN, undefined)
    } else {
      immediate = result
    }
  }

  try {
    cleanup = node.register(resume as (result: AnyFx) => void, fiber.signal) ?? undefined
  } catch (thrown) {
    done = true
    return die(thrown)
  }

  if (immediate != null) {
    fiber.current = immediate
    return RUN
  }
  if (done) {
    // Resumed synchronously with a value we already consumed, or aborted.
    return PARKED
  }

  // Once interruption has been delivered the signal is spent: work parked
  // during cleanup must be allowed to finish.
  if (!fiber.interruptDelivered) {
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

/**
 * Threads a success value out through the continuation frames.
 *
 * Returns `RUN` when a frame produced the next instruction (now in
 * `fiber.current`), `OK` when the stack emptied with the final value in `out`,
 * or `FAIL` with the cause in `out`.
 *
 * Generator frames are peeked rather than popped, because a generator that is
 * not done stays on the stack to receive the next value. That is what keeps
 * native `yield*` delegation depth at one: the interpreter, not the engine,
 * holds the chain.
 */
function propagate(fiber: Fiber, initial: unknown): Mode {
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
        return die(thrown)
      }
      if (progress.done === true) {
        fiber.stack.pop()
        value = progress.value
        continue
      }
      fiber.current = progress.value as AnyFx
      return RUN
    }

    fiber.stack.pop()

    switch (frame.kind) {
      case 'transform':
        try {
          value = frame.apply(value)
        } catch (thrown) {
          return die(thrown)
        }
        continue

      case 'chain':
        try {
          fiber.current = frame.apply(value)
        } catch (thrown) {
          return die(thrown)
        }
        return RUN

      case 'recover':
        continue

      case 'services':
        fiber.services = frame.restore
        continue
    }
  }

  out = value
  return OK
}

// --- entry points ----------------------------------------------------------

/** Whether the fiber may park. A fiber nobody has started yet may. */
export function asyncAllowed(fiber: Fiber): boolean {
  return fiber.allowAsync
}

/** Starts a fiber. Returns once it settles or parks. */
export function start(fiber: Fiber, allowAsync: boolean): void {
  fiber.started = true
  fiber.allowAsync = allowAsync
  fiber.steps = 0
  const first = fiber.current
  if (first == null) {
    fiber.settle(err(new Die(new Error('e2: started a fiber with no instruction'))))
    return
  }
  drive(fiber, RUN, undefined)
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
