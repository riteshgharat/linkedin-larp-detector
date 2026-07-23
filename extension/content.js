/**
 * content.js — Injected into LinkedIn pages
 *
 * Injects a "Detect LARP" sparkles-only icon button into each LinkedIn post's action bar.
 * When clicked, it extracts the post text, sends it to the background worker for analysis,
 * and appends the translated version inline below the post text with a horizontal line.
 */

const PROCESSED_ATTR = "data-larp-injected";

// Theme-compatible score tags (subtle, non-bright, blending with LinkedIn UI)
const SCORE_COLORS = {
  genuine: { bg: "#e6f9f0", border: "#34d399", text: "#065f46" },
  mild: { bg: "#fefce8", border: "#facc15", text: "#713f12" },
  moderate: { bg: "#fff7ed", border: "#fb923c", text: "#7c2d12" },
  high: { bg: "#fef2f2", border: "#f87171", text: "#7f1d1d" },
  peak: { bg: "#1a0505", border: "#dc2626", text: "#fca5a5" },
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
 * Find the element containing the post text.
 */
function getPostTextElement(postEl) {
  // Target the stable LinkedIn text container attribute first
  let el = postEl.querySelector('[data-testid="expandable-text-box"]');
  if (el) return el;

  // Alternative classes/attributes used by LinkedIn
  const selectors = [
    ".feed-shared-update-v2__description",
    ".feed-shared-text",
    ".update-components-text",
    "[data-test-id='main-feed-activity-card__commentary']",
    ".attributed-text-segment-list__content",
  ];
  for (const sel of selectors) {
    el = postEl.querySelector(sel);
    if (el && el.innerText.trim()) return el;
  }

  // Fallback: search for paragraphs or spans inside the post with sufficient text length
  const blocks = Array.from(postEl.querySelectorAll("p, span"));
  for (const block of blocks) {
    if (block.innerText.trim().length > 40) {
      return block;
    }
  }
  return null;
}

/**
 * Extract the visible text content from a LinkedIn post element.
 */
function extractPostText(postEl) {
  const el = getPostTextElement(postEl);
  if (el) {
    // If we've already appended translation inside, read only the original text part
    const originalText = el.cloneNode(true);
    const appended = originalText.querySelector(".larp-appended-container");
    if (appended) appended.remove();
    return originalText.innerText.trim();
  }
  return "";
}

/**
 * Injects CSS styles for shimmer animation and hover effects.
 */
function injectStyles() {
  if (document.getElementById("larp-styles")) return;
  const style = document.createElement("style");
  style.id = "larp-styles";
  style.textContent = `
    @keyframes larpShimmer {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    /* Light Mode gradient (default) */
    .larp-sparkle-text {
      background: linear-gradient(90deg, #312e81, #db2777, #d97706, #312e81);
      background-size: 200% auto;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: larpShimmer 4s ease infinite;
      font-weight: 600;
      display: inline;
    }
    /* Dark Mode gradient (matches system setting or parent attribute) */
    @media (prefers-color-scheme: dark) {
      .larp-sparkle-text {
        background: linear-gradient(90deg, #c7d2fe, #f472b6, #fbbf24, #c7d2fe);
        background-size: 200% auto;
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
    }
    [data-color-scheme="dark"] .larp-sparkle-text,
    .theme--dark .larp-sparkle-text {
      background: linear-gradient(90deg, #c7d2fe, #f472b6, #fbbf24, #c7d2fe) !important;
      background-size: 200% auto !important;
      -webkit-background-clip: text !important;
      -webkit-text-fill-color: transparent !important;
    }
    
    /* Loading glitter / spoiler shimmer animation */
    @keyframes larpLoadingGlow {
      0% { filter: blur(2px); opacity: 0.8; text-shadow: 0 0 4px rgba(139, 92, 246, 0.4); }
      50% { filter: blur(3px); opacity: 0.5; text-shadow: 0 0 12px rgba(236, 72, 153, 0.8), 0 0 8px rgba(250, 204, 21, 0.6); }
      100% { filter: blur(2px); opacity: 0.8; text-shadow: 0 0 4px rgba(139, 92, 246, 0.4); }
    }
    .larp-loading-shimmer {
      animation: larpLoadingGlow 1.5s ease-in-out infinite !important;
      pointer-events: none !important;
      user-select: none !important;
      transition: filter 0.3s ease, opacity 0.3s ease !important;
    }

    .larp-appended-container {
      animation: larpFadeIn 0.3s ease;
    }
    @keyframes larpFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Append the translated version below the original text with a horizontal line.
 */
function renderInlineAppend(postEl, data) {
  const textEl = getPostTextElement(postEl);
  if (!textEl) return;

  // Force block display on parent text container to prevent inline layout bugs
  textEl.style.setProperty("display", "block", "important");

  // Remove existing translation block if any (avoid duplicate appends)
  const oldAppend = textEl.querySelector(".larp-appended-container");
  if (oldAppend) {
    oldAppend.remove();
  }

  const tier = getScoreTier(data.score);
  const colors = SCORE_COLORS[tier];
  const label = getScoreLabel(data.score);

  const container = document.createElement("div");
  container.className = "larp-appended-container";
  container.style.cssText = `
    display: block !important;
    padding: 8px 0 !important;
  `;

  // Add line breaks around appended content for spacing
  container.appendChild(document.createElement("br"));

  // ── Horizontal divider ──────────────────────────────────────────────────
  const hr = document.createElement("hr");
  hr.setAttribute("role", "presentation");
  hr.className = "_960d361f acb5560b ed11bcb6 a54b1fae _622c5a1f _4406420e _527ddd1b _27a6d872 _08e1db09 e837d6e6 _3936bd2f f47ec750";
  container.appendChild(hr);
  container.appendChild(document.createElement("br"));
  // ── Score badge (inline-flex pill) ──────────────────────────────────────
  // All dynamic values set via textContent — safe against XSS (CR-02)
  const badge = document.createElement("div");
  badge.className = "larp-inline-badge";
  badge.style.cssText = [
    "display: inline-flex !important",
    "align-items: center !important",
    "gap: 6px !important",
    "border-radius: 25px !important",
    `color: ${colors.text} !important`,
    `background-color: ${colors.bg} !important`,
    `border: 1px solid ${colors.border} !important`,
    "padding: 2px 10px !important",
    "margin: 10px 0 !important",
  ].join(";");

  const scoreSpan = document.createElement("span");
  scoreSpan.textContent = `${label} (${data.score}/100)`;

  const sep = document.createElement("span");
  sep.style.cssText = "opacity: 0.4; font-weight: 300;";
  sep.textContent = "|";

  const catSpan = document.createElement("span");
  catSpan.textContent = `Category: ${data.category}`;

  badge.appendChild(scoreSpan);
  badge.appendChild(sep);
  badge.appendChild(catSpan);

  container.appendChild(badge);
  container.appendChild(br);
  container.appendChild(br);

  // ── Summary line ────────────────────────────────────────────────────────
  container.appendChild(document.createElement("br"));
  const summaryEl = document.createElement("span");
  summaryEl.textContent = `Summary: "${data.translation}"`;
  container.appendChild(summaryEl);
  container.appendChild(br);

  // ── Reason line ─────────────────────────────────────────────────────────
  container.appendChild(document.createElement("br"));
  const reasonEl = document.createElement("span");
  reasonEl.style.cssText = "opacity: 0.71 !important; font-style: italic;";
  reasonEl.textContent = `Reason: ${data.reason}`;
  container.appendChild(reasonEl);

  textEl.appendChild(container);
}

/**
 * Inject a "Detect LARP" button into a post element.
 */
function injectButton(postEl) {
  if (postEl.hasAttribute(PROCESSED_ATTR)) return;

  // Find action bar: look for native comment/react buttons
  const commentBtn =
    postEl.querySelector('button[aria-label="Comment"]') ||
    postEl.querySelector('button[aria-label^="Reaction button state"]');
  const actionBar = commentBtn
    ? commentBtn.parentElement
    : postEl.querySelector(".feed-shared-social-action-bar") ||
      postEl.querySelector(".social-actions-bar") ||
      postEl.querySelector("div[class*='social-action']") ||
      postEl;

  if (!actionBar || actionBar === postEl) return; // Keep seeking

  postEl.setAttribute(PROCESSED_ATTR, "true");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "Detect LARP"; // Pre-built browser tooltip

  // Copy native button classes to blend in perfectly
  const sampleBtn = actionBar.querySelector("button");
  if (sampleBtn) {
    btn.className = sampleBtn.className + " larp-analyze-btn";
  } else {
    btn.className = "larp-analyze-btn";
    btn.style.cssText = `
      display: inline-flex; align-items: center; justify-content: center;
      height: 40px; width: 40px; border: none; background: transparent; color: #5e5e5e;
      cursor: pointer; border-radius: 4px;
    `;
  }

  // Ensure standard positioning & size for icon-only button
  btn.style.marginLeft = "4px";
  btn.style.padding = "0 8px";

  // Use a sparkles icon
  const sparklesSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor" style="display: inline-block; vertical-align: middle;"><path d="M160-120q-33 0-56.5-23.5T80-200v-560q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v560q0 33-23.5 56.5T800-120H160Zm0-80h640v-560H160v560Zm40-80h200v-80H200v80Zm382-80 198-198-57-57-141 142-57-57-56 57 113 113Zm-382-80h200v-80H200v80Zm0-160h200v-80H200v80Zm-40 400v-560 560Z"/></svg>
  `;

  btn.innerHTML = `
    <span style="display: inline-flex; align-items: center; justify-content: center;">
      ${sparklesSvg}
    </span>
  `;

  btn.addEventListener("click", async () => {
    // If the "see more" button is present, expand it first so we analyze the full post
    const moreBtn = postEl.querySelector(
      '[data-testid="expandable-text-button"]',
    );
    if (moreBtn) {
      moreBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    const textEl = getPostTextElement(postEl);
    const text = extractPostText(postEl);
    if (!text) {
      alert(
        "Could not extract post text. Make sure the post contains readable content.",
      );
      return;
    }

    // Apply loading glitter / spoiler shimmer to text container while analyzing
    if (textEl) {
      textEl.classList.add("larp-loading-shimmer");
    }

    // Indicate loading state (change icon color or add temporary spin)
    btn.style.color = "#0a66c2";
    btn.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        type: "ANALYZE_POST",
        text,
      });

      if (result.error) {
        throw new Error(result.error);
      }

      // Remove loading glitter before rendering results
      if (textEl) {
        textEl.classList.remove("larp-loading-shimmer");
      }

      renderInlineAppend(postEl, result);
    } catch (err) {
      // Remove loading glitter on error
      if (textEl) {
        textEl.classList.remove("larp-loading-shimmer");
      }
      alert(`Failed to analyze post: ${err.message}`);
    } finally {
      btn.style.color = "";
      btn.disabled = false;
    }
  });

  // Reposition: insert after "Send" or "Repost" or "Comment" to keep alignment
  const sendBtn =
    actionBar.querySelector(
      'a[aria-label="Send"], button[aria-label="Send"]',
    ) ||
    actionBar.querySelector(
      'a[aria-label^="Send"], button[aria-label^="Send"]',
    );
  const repostBtn =
    actionBar.querySelector('button[aria-label="Repost"]') ||
    actionBar.querySelector('button[aria-label^="Repost"]');
  const commentBtnNative =
    actionBar.querySelector('button[aria-label="Comment"]') ||
    actionBar.querySelector('button[aria-label^="Comment"]');

  const insertTarget = sendBtn || repostBtn || commentBtnNative;
  if (insertTarget) {
    insertTarget.insertAdjacentElement("afterend", btn);
  } else {
    actionBar.appendChild(btn);
  }
}

/**
 * Find all post containers on the page and inject buttons.
 */
function scanPosts() {
  injectStyles();

  // High-accuracy selectors to find actual feed posts/updates
  const selectors = [
    'div[role="listitem"]',
    ".feed-shared-update-v2",
    ".occludable-update",
    "div[data-urn]",
  ];

  selectors.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      // Confirm it's a post containing either expandable text or react actions
      if (
        el.querySelector('[data-testid="expandable-text-box"]') ||
        el.querySelector('button[aria-label="Comment"]')
      ) {
        injectButton(el);
      }
    });
  });
}

// Initial scan
scanPosts();

// Watch for dynamically loaded posts (LinkedIn SPA scrolls)
const observer = new MutationObserver(() => scanPosts());
observer.observe(document.body, { childList: true, subtree: true });
