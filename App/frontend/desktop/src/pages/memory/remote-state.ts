export type RemoteData<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
