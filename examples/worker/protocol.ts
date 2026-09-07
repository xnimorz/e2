/**
 * The wire format between a main thread and a worker.
 *
 * Note what does NOT cross: an `Fx`. An effect is a description, but it is a
 * description made of closures, so it is not structured-cloneable. Trying to
 * ship effects across the boundary would require a serialisable instruction
 * DSL - a genuinely different library.
 *
 * What crosses instead is a *service call*. The contract (`Service` + interface)
 * is shared; one side has the real implementation and the other has a proxy
 * that forwards named methods. DI is what makes this a two-line swap: the
 * program never learns which side of the boundary it is on.
 */

export interface CallMessage {
  readonly kind: 'call'
  readonly id: number
  readonly method: string
  readonly args: readonly unknown[]
}

/** Sent when the caller is interrupted, so the worker can abort mid-flight. */
export interface CancelMessage {
  readonly kind: 'cancel'
  readonly id: number
}

export type Request = CallMessage | CancelMessage

export interface OkMessage {
  readonly kind: 'ok'
  readonly id: number
  readonly value: unknown
}

/** An expected failure: becomes `Err` in the caller's error channel. */
export interface ErrMessage {
  readonly kind: 'err'
  readonly id: number
  readonly error: unknown
}

/** A bug in the worker: becomes a defect, never a typed failure. */
export interface DefectMessage {
  readonly kind: 'defect'
  readonly id: number
  readonly message: string
}

export type Response = OkMessage | ErrMessage | DefectMessage
