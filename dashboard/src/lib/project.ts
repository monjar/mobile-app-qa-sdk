/** Which project the inbox shows; remembered per browser. 'all' shows every project. */
import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'snitch.project';
const listeners = new Set<() => void>();

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

export function useSelectedProject(): [string, (id: string) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => 'all',
  );
  const set = useCallback((id: string) => {
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // private mode: selection just won't persist
    }
    listeners.forEach((l) => l());
  }, []);
  return [value, set];
}
