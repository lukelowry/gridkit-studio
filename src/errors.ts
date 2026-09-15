export const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
