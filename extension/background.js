/**
 * background.js — Service Worker
 * Handles messages from the popup, proxies analysis requests to the backend,
 * and manages the API base URL stored in chrome.storage.sync.
 */

// const DEFAULT_API_URL = "http://localhost:8000"; use this if backend is running locally
const DEFAULT_API_URL = "http://56.228.6.62";

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ANALYZE_POST") {
    handleAnalyze(message.text).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message || "Analysis failed" });
    });
    return true; // Keep message channel open for async response
  }

  if (message.type === "GET_API_URL") {
    chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL }, (result) => {
      sendResponse({ apiUrl: result.apiUrl });
    });
    return true;
  }

  if (message.type === "SET_API_URL") {
    chrome.storage.sync.set({ apiUrl: message.apiUrl }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

function normalizeApiUrl(url) {
  return url.trim().replace(/\/+$/, "");
}

async function handleAnalyze(text) {
  const { apiUrl } = await new Promise((resolve) =>
    chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL }, resolve)
  );

  const response = await fetch(`${normalizeApiUrl(apiUrl)}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  return response.json();
}
