import { async_, type Fx } from '../../src/fx.ts'
import { acquire } from '../../src/ops.ts'
import { Err, Ok } from '../../src/result.ts'
import { Raise } from '../../src/fx.ts'
import { Die } from '../../src/cause.ts'
import type { Response } from './protocol.ts'
import type { ScopeName } from '../../src/service.ts'

export interface WorkerLink {
  readonly worker: Worker
  readonly pending: Map<number, (response: Response) => void>
}

let nextRequestId = 0

/**
 * Opens a worker and ties its lifetime to the ambient scope.
 *
 * `acquire` is doing real work here: the worker is terminated when the scope
 * closes, whether that is because the program finished, failed, or was
 * interrupted. Nothing else has to remember to call `terminate`.
 */
export const openLink = (url: URL | string): Fx<WorkerLink, never, ScopeName> =>
  acquire(
    () => {
      const worker = new Worker(typeof url === 'string' ? url : url.href, {
        type: 'module',
      })
      const pending = new Map<number, (response: Response) => void>()
      worker.addEventListener('message', (event: MessageEvent<Response>) => {
        const settle = pending.get(event.data.id)
        if (settle !== undefined) {
          pending.delete(event.data.id)
          settle(event.data)
        }
      })
      return { worker, pending }
    },
    (link) => {
      link.pending.clear()
      link.worker.terminate()
    }
  )

/**
 * Calls a method on the other side of the boundary.
 *
 * The interesting part is the returned cleanup function. `async_` runs it when
 * the fiber is interrupted while parked, so cancellation *crosses the thread
 * boundary*: the worker gets a `cancel` for that request id and aborts the
 * computation in flight. Without it, interrupting the caller would leave a
 * core spinning on work nobody wants any more.
 *
 * `decodeError` exists because structured clone does not preserve prototypes.
 * The worker sends plain data; the caller decides what class it becomes. That
 * is a real boundary and pretending otherwise would produce an object that
 * fails `instanceof`.
 */
export const call = <Value, Error>(
  link: WorkerLink,
  method: string,
  args: readonly unknown[],
  decodeError: (raw: unknown) => Error
): Fx<Value, Error> =>
  async_<Value, Error>((resume, signal) => {
    if (signal.aborted) {
      return undefined
    }
    const id = nextRequestId++

    link.pending.set(id, (response) => {
      switch (response.kind) {
        case 'ok':
          resume(new Ok(response.value as Value) as never)
          return
        case 'err':
          resume(new Err(decodeError(response.error)) as never)
          return
        case 'defect':
          // A bug in the worker is a bug here too, not a typed failure.
          resume(
            new Raise(new Die(new Error(`e2 worker: ${response.message}`))) as never
          )
      }
    })

    link.worker.postMessage({ kind: 'call', id, method, args })

    return () => {
      link.pending.delete(id)
      link.worker.postMessage({ kind: 'cancel', id })
    }
  })
