/**
 * api.js — Shared API utility
 * Used by popup to call the backend directly (for manual text input).
 */

// const DEFAULT_API_URL = "http://localhost:8000"; use this if backend is running locally
const DEFAULT_API_URL = "http://56.228.6.62";

export async function getApiUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL }, (r) =>
      resolve(r.apiUrl)
    );
  });
}

export async function setApiUrl(url) {
  return new Promise((resolve) =>
    chrome.storage.sync.set({ apiUrl: url }, resolve)
  );
}

export async function analyzePost(text) {
  const apiUrl = await getApiUrl();
  const res = await fetch(`${apiUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function checkHealth() {
  const apiUrl = await getApiUrl();
  const res = await fetch(`${apiUrl}/health`, { method: "GET" });
  if (!res.ok) throw new Error(`Backend unreachable (HTTP ${res.status})`);
  return res.json();
}
