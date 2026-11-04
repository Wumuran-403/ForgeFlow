export interface AbortScope {
  readonly signal: AbortSignal;
  abort(): void;
  dispose(): void;
}

export function createAbortScope(parentSignal?: AbortSignal): AbortScope {
  const controller = new AbortController();
  let disposed = false;

  const abortFromParent = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };

  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      abortFromParent();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  return {
    signal: controller.signal,
    abort: () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}
