export class CuarError extends Error {
  constructor(code, stage, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CuarError";
    this.code = code;
    this.stage = stage;
    this.retryable = Boolean(options.retryable);
    this.exitCode = options.exitCode ?? 7;
  }
}

export function asCuarError(error) {
  if (error instanceof CuarError) return error;
  return new CuarError(
    "internal_error",
    "internal",
    "CUAR encountered an unexpected internal error.",
    { cause: error, exitCode: 7 },
  );
}

export function limitationFromError(error) {
  const normalized = asCuarError(error);
  return {
    code: normalized.code,
    message: normalized.message,
  };
}
