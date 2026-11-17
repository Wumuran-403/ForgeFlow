import { useEffect, useRef } from "react";

export function usePolling(
  load: () => Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let active = true;
    let running = false;
    const tick = async (): Promise<void> => {
      if (!active || running) {
        return;
      }
      running = true;
      try {
        await loadRef.current();
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs]);
}
