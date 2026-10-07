/** JSON column helpers: parse defensively, never throw on a corrupt row. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
