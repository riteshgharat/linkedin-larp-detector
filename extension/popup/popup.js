/**
 * popup.js — Extension popup logic
 *
 * Handles:
 *  - Backend health check on open
 *  - Manual post text input + analysis
 *  - Score rendering with tier colors
 *  - Settings panel (API URL persistence)
 */

const DEFAULT_API_URL = "http://localhost:8000";

// Score tier → color mapping (matches popup.css variables)
const TIER_COLORS = {
  genuine:  "#34d399",
  mild:     "#facc15",
  moderate: "#fb923c",
  high:     "#f87171",
  peak:     "#dc2626",
};

const TIER_VERDICTS = {
  genuine:  "✅ Genuine",
  mild:     "🟡 Mildly LARPy",
  moderate: "🟠 Moderate LARP",
  high:     "🔴 High LARP",
  peak:     "💀 Peak LARP",
};

function getScoreTier(score) {
  if (score <= 20) return "genuine";
  if (score <= 40) return "mild";
  if (score <= 60) return "moderate";
  if (score <= 80) return "high";
  return "peak";
}

// ─── DOM refs ────────────────────────────────────────────────────────────────
const statusDot     = document.getElementById("statusDot");
const statusText    = document.getElementById("statusText");
const postInput     = document.getElementById("postInput");
const charCount     = document.getElementById("charCount");
const analyzeBtn    = document.getElementById("analyzeBtn");
const analyzeBtnTxt = document.getElementById("analyzeBtnText");
const analyzeBtnSpn = document.getElementById("analyzeBtnSpinner");
const resultCard    = document.getElementById("resultCard");
const scoreNum      = document.getElementById("scoreNum");
const scoreVerdict  = document.getElementById("scoreVerdict");
const scoreCat      = document.getElementById("scoreCategory");
const scoreBar      = document.getElementById("scoreBar");
const reasonText    = document.getElementById("reasonText");
const translText    = document.getElementById("translationText");
const cachedBadge   = document.getElementById("cachedBadge");
const errorMsg      = document.getElementById("errorMsg");
const mainPanel     = document.getElementById("mainPanel");
const settingsPanel = document.getElementById("settingsPanel");
const settingsBtn   = document.getElementById("settingsBtn");
const backBtn       = document.getElementById("backBtn");
const saveSetBtn    = document.getElementById("saveSettingsBtn");
const apiUrlInput   = document.getElementById("apiUrlInput");

// ─── API helpers ─────────────────────────────────────────────────────────────
async function getApiUrl() {
  return new Promise((resolve) =>
    chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL }, (r) =>
      resolve(r.apiUrl)
    )
  );
}

async function setApiUrl(url) {
  return new Promise((resolve) =>
    chrome.storage.sync.set({ apiUrl: url }, resolve)
  );
}

async function checkHealth(apiUrl) {
  const res = await fetch(`${apiUrl}/health`, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Health check ─────────────────────────────────────────────────────────────
async function pingBackend() {
  const apiUrl = await getApiUrl();
  try {
    await checkHealth(apiUrl);
    statusDot.className = "status-dot status-ok";
    statusText.textContent = "Backend connected";
  } catch {
    statusDot.className = "status-dot status-error";
    statusText.textContent = "Backend unreachable — check your server";
  }
}

// ─── Textarea character count ─────────────────────────────────────────────────
postInput.addEventListener("input", () => {
  const len = postInput.value.length;
  charCount.textContent = len;
  analyzeBtn.disabled = len === 0;

  // Turn counter red near limit
  charCount.style.color = len > 2700 ? "#f87171" : "";
});

// ─── Render result ─────────────────────────────────────────────────────────────
function renderResult(data) {
  const tier   = getScoreTier(data.score);
  const color  = TIER_COLORS[tier];
  const verdict = TIER_VERDICTS[tier];

  scoreNum.textContent     = data.score;
  scoreNum.style.color     = color;
  scoreVerdict.textContent = verdict;
  scoreVerdict.style.color = color;
  scoreCat.textContent     = data.category;
  reasonText.textContent   = data.reason;
  translText.textContent   = data.translation;

  // Animate score bar
  scoreBar.style.width      = `${data.score}%`;
  scoreBar.style.background = `linear-gradient(90deg, ${color}99, ${color})`;

  cachedBadge.classList.toggle("hidden", !data.cached);
  resultCard.classList.remove("hidden");
}

// ─── Analyze handler ──────────────────────────────────────────────────────────
analyzeBtn.addEventListener("click", async () => {
  const text = postInput.value.trim();
  if (!text) return;

  // Loading state
  analyzeBtnTxt.textContent = "Analyzing…";
  analyzeBtnSpn.classList.remove("hidden");
  analyzeBtn.disabled = true;
  errorMsg.classList.add("hidden");
  resultCard.classList.add("hidden");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "ANALYZE_POST",
      text,
    });

    if (result.error) throw new Error(result.error);
    renderResult(result);
  } catch (err) {
    errorMsg.textContent = `❌ ${err.message || "Analysis failed. Is the backend running?"}`;
    errorMsg.classList.remove("hidden");
  } finally {
    analyzeBtnTxt.textContent = "Analyze Post";
    analyzeBtnSpn.classList.add("hidden");
    analyzeBtn.disabled = postInput.value.trim().length === 0;
  }
});

// ─── Settings panel ───────────────────────────────────────────────────────────
settingsBtn.addEventListener("click", async () => {
  const url = await getApiUrl();
  apiUrlInput.value = url;
  mainPanel.classList.add("hidden");
  settingsPanel.classList.remove("hidden");
});

backBtn.addEventListener("click", () => {
  settingsPanel.classList.add("hidden");
  mainPanel.classList.remove("hidden");
});

saveSetBtn.addEventListener("click", async () => {
  const url = apiUrlInput.value.trim();
  if (!url) return;
  await setApiUrl(url);
  settingsPanel.classList.add("hidden");
  mainPanel.classList.remove("hidden");
  pingBackend(); // Re-check with new URL
});

// ─── Init ────────────────────────────────────────────────────────────────────
pingBackend();
