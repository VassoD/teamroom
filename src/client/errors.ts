/** The server answered with an error envelope `{ error: { code, message, requestId } }`. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The server could not be reached, timed out, or returned something that is not a teamroom response. */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/** Local setup is missing or broken: not a git repo, no room joined, unreadable config. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class GitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitError";
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const reference = error.requestId ? ` (request ${error.requestId})` : "";
    return `${error.message}${reference}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
