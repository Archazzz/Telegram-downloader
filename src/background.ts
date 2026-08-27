type PageStats = {
  mediaCount: number;
  messageCount: number;
  queueActive: number;
  queuePending: number;
};

const statsByTab = new Map<number, PageStats>();
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingOffscreenDocument: Promise<void> | null = null;

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
    statsByTab.set(sender.tab.id, typed.payload);
    sendResponse({ ok: true });
    return false;
  }

  if (typed.type === "get-active-stats") {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      sendResponse({ ok: true, stats: tab?.id === undefined ? null : (statsByTab.get(tab.id) ?? null) });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => statsByTab.delete(tabId));
