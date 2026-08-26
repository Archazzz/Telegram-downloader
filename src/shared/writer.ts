type EnsureWriterResponse = {
  ok?: boolean;
  error?: string;
};

export async function ensureWriterDocument(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  const response = await chrome.runtime.sendMessage({ type: "ensure-offscreen-writer" }) as EnsureWriterResponse | undefined;
  if (!response?.ok) throw new Error(response?.error ?? "无法启动扩展写入器");
}
