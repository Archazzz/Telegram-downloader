export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 5;
export const DEFAULT_CONCURRENCY = 2;

export type ExtensionSettings = {
  concurrency: number;
};

let previewSettings: ExtensionSettings = { concurrency: DEFAULT_CONCURRENCY };

function storageArea(): chrome.storage.StorageArea | null {
  return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
}

export function normalizeConcurrency(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(numeric)));
}

export async function getSettings(): Promise<ExtensionSettings> {
  const storage = storageArea();
  if (!storage) return previewSettings;
  const stored = await storage.get("concurrency");
  return { concurrency: normalizeConcurrency(stored.concurrency) };
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const normalized = { concurrency: normalizeConcurrency(settings.concurrency) };
  const storage = storageArea();
  if (storage) await storage.set(normalized);
  else previewSettings = normalized;
  return normalized;
}
