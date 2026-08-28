import { BRIDGE_FRAME_ATTRIBUTE, BRIDGE_READY_ATTRIBUTE, BridgeResponse, BridgeStatus } from "../shared/protocol";
import { DownloadError, DownloadErrorCode, errorCode } from "../core/errors";

type PendingRequest = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: number;
};

export class BridgeClient {
  private frame: HTMLIFrameElement | null = null;
  private verifiedWindow: WindowProxy | null = null;
  private frameOrigin = "";
  private frameEpoch = 0;
  private lastFrameSource = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readyPromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  onSettingsChanged?: (status: BridgeStatus) => void;

  constructor() {
    window.addEventListener("message", (event) => this.handleMessage(event));
  }

  async status(): Promise<BridgeStatus> {
    let failedEpoch = this.frameEpoch;
    try {
      await this.waitUntilReady();
      failedEpoch = this.frameEpoch;
      return await this.send("status", {}, undefined, [], 5_000) as unknown as BridgeStatus;
    } catch (error) {
      if (errorCode(error) !== "BRIDGE_UNAVAILABLE") throw error;
      await this.recoverBridge(failedEpoch);
      return await this.send("status", {}, undefined, [], 10_000) as unknown as BridgeStatus;
    }
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
    if (this.frame?.isConnected && this.frame.contentWindow && this.verifiedWindow === this.frame.contentWindow) return;
    this.frame = null;
    this.verifiedWindow = null;
    this.frameOrigin = "";
    if (this.readyPromise) return this.readyPromise;
    const readyPromise = new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const pingRequestId = crypto.randomUUID();
      let settled = false;
      let candidate: HTMLIFrameElement | null = null;
      let candidateOrigin = "";
      const cleanup = (): void => window.removeEventListener("message", onReady);
      const onReady = (event: MessageEvent): void => {
        const response = event.data as BridgeResponse;
        if (!candidate?.contentWindow || event.source !== candidate.contentWindow || event.origin !== candidateOrigin) return;
        if (response?.source !== "telegram-media-downloader-bridge" || response.type !== "bridge:ready" || response.requestId !== pingRequestId) return;
        settled = true;
        cleanup();
        candidate.setAttribute(BRIDGE_READY_ATTRIBUTE, "");
        this.frame = candidate;
        this.verifiedWindow = candidate.contentWindow;
        this.frameOrigin = candidateOrigin;
        this.lastFrameSource = candidate.src;
        this.frameEpoch += 1;
        resolve();
      };
      window.addEventListener("message", onReady);
      const check = () => {
        if (settled) return;
        const frame = document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`);
        if (frame?.contentWindow && frame.src) {
          candidate = frame;
          candidateOrigin = new URL(frame.src).origin;
          frame.contentWindow.postMessage({
            source: "telegram-media-downloader",
            type: "bridge:ping",
            requestId: pingRequestId
          }, "*");
        }
        if (Date.now() - started > 3_000) {
          settled = true;
          cleanup();
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

  private async recoverBridge(failedEpoch: number): Promise<void> {
    if (this.frameEpoch !== failedEpoch) {
      await this.waitUntilReady();
      return;
    }
    if (!this.recoveryPromise) {
      this.recoveryPromise = (async () => {
        const staleFrame = this.frame ?? document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`);
        const source = staleFrame?.src || this.lastFrameSource;
        if (!source) throw new DownloadError("扩展写入桥接页不存在，请刷新 Telegram Web 后重试", "BRIDGE_UNAVAILABLE");

        for (const request of this.pending.values()) {
          window.clearTimeout(request.timeout);
          request.reject(new DownloadError("扩展写入桥接已重新连接，请重试当前请求", "BRIDGE_UNAVAILABLE"));
        }
        this.pending.clear();

        const replacement = document.createElement("iframe");
        replacement.id = staleFrame?.id ?? "telegram-media-downloader-bridge";
        replacement.src = source;
        replacement.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
        replacement.setAttribute("aria-hidden", "true");
        replacement.tabIndex = -1;
        replacement.style.cssText = staleFrame?.style.cssText ?? "position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;border:0;opacity:0;pointer-events:none";
        this.frame = null;
        this.verifiedWindow = null;
        this.frameOrigin = "";
        this.readyPromise = null;
        if (staleFrame?.isConnected) staleFrame.replaceWith(replacement);
        else (document.documentElement ?? document).appendChild(replacement);
        await this.waitUntilReady();
      })().finally(() => {
        this.recoveryPromise = null;
      });
    }
    await this.recoveryPromise;
  }

  private async send(
    type: string,
    payload: Record<string, unknown> = {},
    providedRequestId?: string,
    transfer: Transferable[] = [],
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    await this.waitUntilReady();
    const requestId = providedRequestId ?? crypto.randomUUID();
    const pendingKey = `${requestId}:${type}`;
    if (!this.frame?.contentWindow) throw new Error("扩展写入桥接页不可用");

    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new DownloadError(`写入桥接请求超时：${type}`, "BRIDGE_UNAVAILABLE"));
      }, timeoutMs);
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
