import { BRIDGE_FRAME_ATTRIBUTE, BRIDGE_READY_ATTRIBUTE, BridgeResponse, BridgeStatus } from "../shared/protocol";
import { DownloadError, DownloadErrorCode } from "../core/errors";

type PendingRequest = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: number;
};

export class BridgeClient {
  private frame: HTMLIFrameElement | null = null;
  private frameOrigin = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readyPromise: Promise<void> | null = null;
  onSettingsChanged?: (status: BridgeStatus) => void;

  constructor() {
    window.addEventListener("message", (event) => this.handleMessage(event));
  }

  async status(): Promise<BridgeStatus> {
    return await this.send("status") as unknown as BridgeStatus;
  }

  async startFile(requestId: string, fileName: string, mimeType?: string): Promise<void> {
    await this.send("file:start", { fileName, mimeType }, requestId);
  }

  async writeChunk(requestId: string, chunk: Uint8Array): Promise<number> {
    const transferable = new Uint8Array(chunk).buffer;
    const response = await this.send("file:chunk", { chunk: transferable }, requestId, [transferable]);
    return typeof response.bytesWritten === "number" ? response.bytesWritten : 0;
  }

  async closeFile(requestId: string): Promise<number> {
    const response = await this.send("file:close", {}, requestId);
    return typeof response.bytesWritten === "number" ? response.bytesWritten : 0;
  }

  async abortFile(requestId: string): Promise<void> {
    await this.send("file:abort", {}, requestId).catch(() => undefined);
  }

  private async waitUntilReady(): Promise<void> {
    if (this.frame?.isConnected && this.frame.contentWindow) return;
    this.frame = null;
    this.frameOrigin = "";
    if (this.readyPromise) return this.readyPromise;
    const readyPromise = new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const frame = document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`);
        if (frame?.contentWindow && frame.src && frame.hasAttribute(BRIDGE_READY_ATTRIBUTE)) {
          this.frame = frame;
          this.frameOrigin = new URL(frame.src).origin;
          resolve();
          return;
        }
        if (Date.now() - started > 10_000) {
          reject(new DownloadError("扩展写入桥接页未能加载，请稍后重试或刷新 Telegram Web", "BRIDGE_UNAVAILABLE"));
          return;
        }
        window.setTimeout(check, 50);
      };
      check();
    });
    this.readyPromise = readyPromise;
    try {
      await readyPromise;
    } finally {
      if (this.readyPromise === readyPromise) this.readyPromise = null;
    }
  }

  private async send(
    type: string,
    payload: Record<string, unknown> = {},
    providedRequestId?: string,
    transfer: Transferable[] = []
  ): Promise<Record<string, unknown>> {
    await this.waitUntilReady();
    const requestId = providedRequestId ?? crypto.randomUUID();
    const pendingKey = `${requestId}:${type}`;
    if (!this.frame?.contentWindow) throw new Error("扩展写入桥接页不可用");

    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new DownloadError(`写入桥接请求超时：${type}`, "BRIDGE_UNAVAILABLE"));
      }, 30_000);
      this.pending.set(pendingKey, { resolve, reject, timeout });
    });

    this.frame.contentWindow.postMessage({
      source: "telegram-media-downloader",
      type,
      requestId,
      payload
    }, this.frameOrigin, transfer);
    return response;
  }

  private handleMessage(event: MessageEvent): void {
    if (!this.frame?.contentWindow || event.source !== this.frame.contentWindow || event.origin !== this.frameOrigin) return;
    const response = event.data as BridgeResponse;
    if (response?.source !== "telegram-media-downloader-bridge") return;
    if (response.type === "settings:changed" && response.payload) {
      this.onSettingsChanged?.(response.payload as unknown as BridgeStatus);
      return;
    }
    if (!response.requestId || !response.type.endsWith(":response")) return;
    const requestType = response.type.slice(0, -":response".length);
    const pendingKey = `${response.requestId}:${requestType}`;
    const pending = this.pending.get(pendingKey);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    this.pending.delete(pendingKey);
    if (response.ok) pending.resolve(response.payload ?? {});
    else pending.reject(response.errorCode
      ? new DownloadError(response.error ?? "写入桥接请求失败", response.errorCode as DownloadErrorCode)
      : new Error(response.error ?? "写入桥接请求失败"));
  }
}
