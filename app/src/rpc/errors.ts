/**
 * Error taxonomy for the engine-host connection.
 *
 * Two sources of failure are deliberately kept apart:
 *   - the host answered with a JSON-RPC `error` object  → `RpcRemoteError`
 *   - the call never got an answer (timeout, crash, ...) → `RpcTransportError`
 *
 * The UI branches on `kind`, never on message text.
 */

/** Client-side failure codes. Kept out of the JSON-RPC reserved range. */
export const ClientErrorCode = {
  /** No response within the deadline. The host may still be working. */
  TIMEOUT: -32001,
  /** The host process exited while this request was in flight. */
  HOST_DIED: -32002,
  /** The host was not running when the call was made. */
  HOST_NOT_RUNNING: -32003,
  /** The caller aborted via AbortSignal. */
  CANCELLED: -32004,
  /** A frame arrived that does not conform to the JSON-RPC envelope. */
  MALFORMED: -32005,
  /** The client was disposed. */
  DISPOSED: -32006,
} as const;

export type ClientErrorCodeValue =
  (typeof ClientErrorCode)[keyof typeof ClientErrorCode];

export abstract class RpcError extends Error {
  abstract readonly kind: "remote" | "transport";
  readonly code: number;
  /** The method that failed, when known. */
  readonly method?: string;

  protected constructor(message: string, code: number, method?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.method = method;
  }
}

/** The host understood the request and refused or failed it. */
export class RpcRemoteError extends RpcError {
  readonly kind = "remote" as const;
  /** Lua traceback, when the engine raised. */
  readonly data?: string;

  constructor(
    message: string,
    code: number,
    opts: { data?: string; method?: string } = {},
  ) {
    super(message, code, opts.method);
    this.data = opts.data;
  }
}

/** The request never completed: timeout, crash, or a broken pipe. */
export class RpcTransportError extends RpcError {
  readonly kind = "transport" as const;
  /** True when retrying the same call is a reasonable next step. */
  readonly retryable: boolean;

  constructor(
    message: string,
    code: ClientErrorCodeValue,
    opts: { method?: string; retryable?: boolean } = {},
  ) {
    super(message, code, opts.method);
    this.retryable = opts.retryable ?? code !== ClientErrorCode.CANCELLED;
  }
}

export function isRpcError(e: unknown): e is RpcError {
  return e instanceof RpcRemoteError || e instanceof RpcTransportError;
}

/**
 * A user-facing sentence for any failure the RPC layer can produce.
 * Deliberately avoids leaking Lua tracebacks into the UI; those go in a
 * details disclosure instead.
 */
export function describeError(e: unknown): string {
  if (e instanceof RpcTransportError) {
    switch (e.code) {
      case ClientErrorCode.TIMEOUT:
        return `The calculation engine did not answer in time${
          e.method ? ` (${e.method})` : ""
        }. It may still be working — try again.`;
      case ClientErrorCode.HOST_DIED:
        return "The calculation engine stopped unexpectedly. Restarting it now.";
      case ClientErrorCode.HOST_NOT_RUNNING:
        return "The calculation engine is not running yet.";
      case ClientErrorCode.CANCELLED:
        return "Cancelled.";
      case ClientErrorCode.MALFORMED:
        return "The calculation engine sent a message this build cannot read. Version mismatch?";
      default:
        return e.message;
    }
  }
  if (e instanceof RpcRemoteError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
