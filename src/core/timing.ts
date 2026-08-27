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
