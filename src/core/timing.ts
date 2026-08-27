export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("下载已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    const cancel = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      reject(new DOMException("下载已取消", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export function withAbortableTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  signal: AbortSignal,
  timeoutError: Error,
  onTimeout?: () => void
): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("下载已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const cancel = (): void => finish(() => reject(new DOMException("下载已取消", "AbortError")));
    const timeout = setTimeout(() => finish(() => {
      onTimeout?.();
      reject(timeoutError);
    }), milliseconds);
    signal.addEventListener("abort", cancel, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}
