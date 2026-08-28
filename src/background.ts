import { badgePresentation, PageStats } from "./core/ui-state";

const statsByTab = new Map<number, PageStats>();
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingOffscreenDocument: Promise<void> | null = null;

function statsStorageKey(tabId: number): string {
  return `pageStats:${tabId}`;
}

async function updatePageStats(tabId: number, stats: PageStats): Promise<void> {
  statsByTab.set(tabId, stats);
  await chrome.storage.session.set({ [statsStorageKey(tabId)]: stats });
  const badge = badgePresentation(stats);
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }),
    chrome.action.setBadgeText({ tabId, text: badge.text }),
    chrome.action.setTitle({ tabId, title: badge.title })
  ]);
  void chrome.runtime.sendMessage({ type: "page-stats-updated", payload: stats }).catch(() => undefined);
}

async function storedPageStats(tabId: number): Promise<PageStats | null> {
  const key = statsStorageKey(tabId);
  const stored = await chrome.storage.session.get(key) as Record<string, PageStats | undefined>;
  return stored[key] ?? null;
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [documentUrl]
  });
  if (contexts.length > 0) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Keep the user-authorized directory writer available while streaming Telegram media."
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const typed = message as { type?: string; payload?: PageStats };
  if (typed.type === "ensure-offscreen-writer") {
    void ensureOffscreenDocument()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (typed.type === "page-stats" && sender.tab?.id !== undefined && typed.payload) {
    void updatePageStats(sender.tab.id, typed.payload).catch(() => undefined);
    sendResponse({ ok: true });
    return false;
  }

  if (typed.type === "get-active-stats") {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (tab?.id === undefined) {
        sendResponse({ ok: true, stats: null });
        return;
      }
      sendResponse({ ok: true, stats: statsByTab.get(tab.id) ?? await storedPageStats(tab.id) });
    }).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  statsByTab.delete(tabId);
  void chrome.storage.session.remove(statsStorageKey(tabId));
});
