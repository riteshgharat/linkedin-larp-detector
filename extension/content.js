/**
 * content.js — Injected into LinkedIn pages
 *
 * Injects a "🔍 Detect LARP" button on each LinkedIn post. When clicked,
 * it extracts the post text, sends it to the background worker for analysis,
 * and renders the result card inline below the post.
 */

const PROCESSED_ATTR = "data-larp-injected";
const SCORE_COLORS = {
  genuine:  { bg: "#e6f9f0", border: "#34d399", text: "#065f46" },
  mild:     { bg: "#fefce8", border: "#facc15", text: "#713f12" },
  moderate: { bg: "#fff7ed", border: "#fb923c", text: "#7c2d12" },
  high:     { bg: "#fef2f2", border: "#f87171", text: "#7f1d1d" },
  peak:     { bg: "#1a0505",  border: "#dc2626", text: "#fca5a5" },
};

function getScoreTier(score) {
  if (score <= 20) return "genuine";
  if (score <= 40) return "mild";
  if (score <= 60) return "moderate";
  if (score <= 80) return "high";
  return "peak";
}

function getScoreLabel(score) {
  if (score <= 20) return "✅ Genuine";
  if (score <= 40) return "🟡 Mildly LARPy";
  if (score <= 60) return "🟠 Moderate LARP";
  if (score <= 80) return "🔴 High LARP";
  return "💀 Peak LARP";
}

/**
 * Extract the visible text content from a LinkedIn post element.
 */
function extractPostText(postEl) {
  // LinkedIn wraps post text in different containers across feed / profile
  const selectors = [
    ".feed-shared-update-v2__description",
    ".feed-shared-text",
    ".update-components-text",
    "[data-test-id='main-feed-activity-card__commentary']",
    ".attributed-text-segment-list__content",
  ];
  for (const sel of selectors) {
    const el = postEl.querySelector(sel);
    if (el && el.innerText.trim()) return el.innerText.trim();
  }
  // Fallback: grab the largest text block inside the post
  const blocks = Array.from(postEl.querySelectorAll("p, span"));
  const text = blocks
    .map((b) => b.innerText.trim())
    .filter((t) => t.length > 20)
    .join("\n");
  return text.trim();
}

/**
 * Build and inject the result card below the post.
 */
function renderResultCard(container, data) {
  // Remove any previous result card
  const old = container.querySelector(".larp-result-card");
  if (old) old.remove();

  const tier = getScoreTier(data.score);
  const colors = SCORE_COLORS[tier];
  const label = getScoreLabel(data.score);

  const card = document.createElement("div");
  card.className = "larp-result-card";
  card.style.cssText = `
    margin: 12px 0;
    padding: 16px;
    border-radius: 12px;
    border: 2px solid ${colors.border};
    background: ${colors.bg};
    color: ${colors.text};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    animation: larpFadeIn 0.3s ease;
  `;

  card.innerHTML = `
    <style>
      @keyframes larpFadeIn {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .larp-score-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .larp-badge {
        font-weight: 700; font-size: 13px; padding: 3px 10px;
        border-radius: 999px; background: ${colors.border};
        color: #fff; white-space: nowrap;
      }
      .larp-score-num { font-size: 22px; font-weight: 800; }
      .larp-category { font-size: 12px; opacity: 0.8; font-style: italic; }
      .larp-section-title {
        font-weight: 700; font-size: 12px; text-transform: uppercase;
        letter-spacing: 0.05em; margin: 10px 0 4px; opacity: 0.7;
      }
      .larp-reason { margin-bottom: 8px; }
      .larp-translation {
        background: rgba(0,0,0,0.06); border-radius: 8px;
        padding: 10px 12px; font-style: italic;
      }
      .larp-cached {
        font-size: 11px; opacity: 0.5; margin-top: 8px; text-align: right;
      }
      .larp-close {
        float: right; cursor: pointer; font-size: 18px;
        line-height: 1; opacity: 0.5; border: none; background: none;
        color: inherit; padding: 0; margin-left: 8px;
      }
      .larp-close:hover { opacity: 1; }
    </style>
    <div class="larp-score-row">
      <span class="larp-score-num">${data.score}</span>
      <div>
        <div><span class="larp-badge">${label}</span></div>
        <div class="larp-category">${data.category}</div>
      </div>
      <button class="larp-close" title="Dismiss">✕</button>
    </div>
    <div class="larp-section-title">Why</div>
    <div class="larp-reason">${data.reason}</div>
    <div class="larp-section-title">What they actually mean</div>
    <div class="larp-translation">${data.translation}</div>
    ${data.cached ? '<div class="larp-cached">⚡ Cached result</div>' : ""}
  `;

  card.querySelector(".larp-close").addEventListener("click", () => card.remove());
  container.insertBefore(card, container.querySelector(".larp-analyze-btn")?.nextSibling || null);
  container.appendChild(card);
}

/**
 * Inject a "Detect LARP" button into a post element.
 */
function injectButton(postEl) {
  if (postEl.hasAttribute(PROCESSED_ATTR)) return;
  postEl.setAttribute(PROCESSED_ATTR, "true");

  const btn = document.createElement("button");
  btn.className = "larp-analyze-btn";
  btn.textContent = "🔍 Detect LARP";
  btn.style.cssText = `
    display: inline-flex; align-items: center; gap: 6px;
    margin: 8px 0 0 4px; padding: 6px 14px;
    border: 1.5px solid #0a66c2; border-radius: 999px;
    background: transparent; color: #0a66c2;
    font-size: 13px; font-weight: 600; cursor: pointer;
    transition: all 0.2s ease;
  `;
  btn.onmouseenter = () => {
    btn.style.background = "#0a66c2";
    btn.style.color = "#fff";
  };
  btn.onmouseleave = () => {
    btn.style.background = "transparent";
    btn.style.color = "#0a66c2";
  };

  btn.addEventListener("click", async () => {
    const text = extractPostText(postEl);
    if (!text) {
      alert("Could not extract post text. Try selecting and copying it manually.");
      return;
    }

    btn.textContent = "⏳ Analyzing…";
    btn.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        type: "ANALYZE_POST",
        text,
      });

      if (result.error) {
        throw new Error(result.error);
      }

      renderResultCard(postEl, result);
    } catch (err) {
      renderResultCard(postEl, {
        score: 0,
        category: "Error",
        reason: `Failed to analyze: ${err.message}`,
        translation: "Could not reach the analysis server. Check your connection.",
        cached: false,
      });
    } finally {
      btn.textContent = "🔍 Detect LARP";
      btn.disabled = false;
    }
  });

  // Append button to the post's social action bar if present, else post itself
  const actionBar =
    postEl.querySelector(".feed-shared-social-action-bar") ||
    postEl.querySelector(".social-actions-bar") ||
    postEl.querySelector("[data-test-id='social-actions__reaction-like-button']")?.parentElement ||
    postEl;

  actionBar.appendChild(btn);
}

/**
 * Find all post containers on the current page and inject buttons.
 */
function scanPosts() {
  const selectors = [
    ".feed-shared-update-v2",
    ".occludable-update",
    "[data-urn]",
  ];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el) => injectButton(el));
  }
}

// Initial scan
scanPosts();

// Watch for dynamically loaded posts (LinkedIn is a SPA)
const observer = new MutationObserver(() => scanPosts());
observer.observe(document.body, { childList: true, subtree: true });
