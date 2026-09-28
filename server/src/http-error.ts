/** HTTP-layer error metadata kept separate from app construction to avoid import cycles. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  readonly fieldPath: string | undefined;
  readonly correlationId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    message: string,
    code?: string,
    metadata?: {
      retryable?: boolean | undefined;
      fieldPath?: string | undefined;
      correlationId?: string | undefined;
      details?: Record<string, unknown> | undefined;
    },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryable = metadata?.retryable;
    this.fieldPath = metadata?.fieldPath;
    this.correlationId = metadata?.correlationId;
    this.details = metadata?.details;
  }
}
