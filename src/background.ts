type PageStats = {
  mediaCount: number;
  messageCount: number;
  queueActive: number;
  queuePending: number;
};

const statsByTab = new Map<number, PageStats>();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const typed = message as { type?: string; payload?: PageStats };
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

  if (typed.type === "open-options") {
    void chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => statsByTab.delete(tabId));

