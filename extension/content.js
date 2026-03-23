// PixelQ Content Script - Interacts with ChatGPT DOM

const PROMPT_SELECTORS = [
  "div#prompt-textarea[contenteditable='true']",
  "div.ProseMirror#prompt-textarea",
  "textarea#prompt-textarea",
  "textarea[data-testid='prompt-textarea']",
  "div[contenteditable='true'][data-testid='prompt-textarea']",
  "div[contenteditable='true'][aria-label*='prompt']",
  "div[contenteditable='true'][aria-label*='Message']",
];

// Text indicators that generation is in progress
const GENERATION_TEXT_INDICATORS = [
  "stop generating",
  "creating image",
  "generating image",
  "cancel generation",
  "stop response",
  "stop streaming",
];

// DOM selectors that indicate generation is happening (more reliable)
const GENERATION_SELECTORS = [
  'button[aria-label*="Stop"]',
  'button[data-testid="stop-button"]',
  '[data-testid="stop-generating"]',
  '.result-streaming',
  '[class*="streaming"]',
  'button[aria-label*="stop"]',
];

const RATE_LIMIT_INDICATORS = [
  "rate limit",
  "too many requests",
  "try again later",
  "limit reached",
  "slow down",
  "you've reached",
  "usage cap",
];

const MIN_IMAGE_SIZE = 256;
const IMAGE_CREATED_INDICATORS = [
  "image created",
  "generated image",
  "here are",
  "created 4 images",
  "created an image",
  "created images",
  "generated images",
  "image generation",
];
const IMAGE_FINALIZATION_SETTLE_MS = 8000;
const ASSISTANT_TURN_SETTLE_MS = 12000;
const IMAGE_CARD_SELECTORS = [
  '[id^="image-"]',
  '[class*="group/imagegen-image"]',
  '[data-testid*="image"]',
  'figure:has(img)',
  'article:has(img)',
  'a[href*="oaiusercontent"]:has(img)',
];
const IMAGE_URL_HINTS = [
  "oaiusercontent",
  "oaistatic",
  "openai",
  "dalle",
  "backend-api/estuary/content",
  "file_",
  "blob:",
  "data:image/",
];

let currentJobId = null;
let pollInterval = null;
let initialImageFingerprints = new Set();
const PENDING_JOB_STORAGE_KEY = "pixelq.pendingJob";
let resumePendingJobPromise = null;
let latestTurnObserver = null;
let observedLatestTurn = null;
let latestTurnActivityAt = 0;

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[PixelQ] Received message:", message.type);

  switch (message.type) {
    case "submit_prompt":
      handleSubmitPrompt(message.id, message.prompt, message.newThread);
      sendResponse({ success: true });
      break;

    case "check_status":
      sendResponse(getStatus());
      break;

    case "get_images":
      sendResponse({ images: extractImages() });
      break;

    default:
      sendResponse({ error: "Unknown message type" });
  }

  return true;
});

function getStatus() {
  const promptBox = findPromptBox();
  const generating = isGenerating();
  const rateLimited = isRateLimited();

  return {
    ready: !!promptBox && !generating,
    generating,
    rateLimited,
    url: window.location.href,
    hasPromptBox: !!promptBox,
  };
}

function findPromptBox() {
  for (const selector of PROMPT_SELECTORS) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function normalizeComposerText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getComposerText(element) {
  if (!element) return "";
  if (element.tagName === "TEXTAREA") {
    return normalizeComposerText(element.value);
  }
  return normalizeComposerText(element.innerText || element.textContent || "");
}

function dispatchNativeInput(element, data = "") {
  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    cancelable: true,
    data,
    inputType: data ? "insertText" : "deleteContentBackward",
  }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeTextAreaValue(element, value) {
  const prototype = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
  dispatchNativeInput(element, value);
}

function placeCaretAtEnd(element) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function clearContentEditable(element) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand?.("delete", false);
  element.replaceChildren();
  placeCaretAtEnd(element);
  dispatchNativeInput(element, "");
}

function insertContentEditableText(element, text) {
  placeCaretAtEnd(element);

  if (document.execCommand?.("insertText", false, text)) {
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    element.textContent = text;
    dispatchNativeInput(element, text);
    return;
  }

  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchNativeInput(element, text);
}

async function waitForComposerValue(expected, timeoutMs = 2000) {
  const normalizedExpected = normalizeComposerText(expected);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const promptBox = findPromptBox();
    if (promptBox && getComposerText(promptBox) === normalizedExpected) {
      return true;
    }
    await sleep(50);
  }

  return false;
}

function findSendButton() {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[data-testid*="send"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
  ];

  for (const selector of selectors) {
    const button = document.querySelector(selector);
    if (button) return button;
  }

  return null;
}

async function waitForSubmissionAcceptance(expectedPrompt, timeoutMs = 15000) {
  const normalizedExpected = normalizeComposerText(expectedPrompt);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isRateLimited()) {
      return { accepted: false, rateLimited: true, generationStarted: false };
    }

    if (isGenerating()) {
      return { accepted: true, rateLimited: false, generationStarted: true };
    }

    const promptBox = findPromptBox();
    const currentValue = getComposerText(promptBox);
    if (!promptBox || currentValue !== normalizedExpected) {
      return { accepted: true, rateLimited: false, generationStarted: false };
    }

    await sleep(250);
  }

  return { accepted: false, rateLimited: false, generationStarted: false };
}

function isGenerating() {
  // Check for stop button first (most reliable)
  for (const selector of GENERATION_SELECTORS) {
    if (document.querySelector(selector)) {
      return true;
    }
  }
  
  // Check text indicators as fallback
  const html = document.body.innerHTML.toLowerCase();
  return GENERATION_TEXT_INDICATORS.some((indicator) => html.includes(indicator));
}

function isRateLimited() {
  const html = document.body.innerHTML.toLowerCase();
  return RATE_LIMIT_INDICATORS.some((indicator) => html.includes(indicator));
}

function normalizeAssetUrl(url) {
  if (!url) return "";

  try {
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      return url;
    }

    const parsed = new URL(url, window.location.href);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function getStableAssetIdentity(url) {
  const normalized = normalizeAssetUrl(url);
  if (!normalized) return "";

  if (normalized.startsWith("blob:")) {
    return normalized;
  }

  if (normalized.startsWith("data:")) {
    return normalized.slice(0, 128);
  }

  try {
    const parsed = new URL(normalized, window.location.href);
    const identityParams = [
      "id",
      "file",
      "file_id",
      "asset",
      "asset_id",
      "key",
      "filename",
    ];
    const preserved = new URLSearchParams();

    identityParams.forEach((name) => {
      const value = parsed.searchParams.get(name);
      if (value) {
        preserved.set(name, value);
      }
    });

    const stableSuffix = preserved.toString();
    return stableSuffix
      ? `${parsed.origin}${parsed.pathname}?${stableSuffix}`.toLowerCase()
      : `${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

function getAssetFingerprint(url) {
  return getStableAssetIdentity(url);
}

function getImageDimensions(img) {
  const rect = typeof img.getBoundingClientRect === "function"
    ? img.getBoundingClientRect()
    : { width: 0, height: 0 };

  return {
    width: Math.max(img.naturalWidth || 0, img.width || 0, rect.width || 0),
    height: Math.max(img.naturalHeight || 0, img.height || 0, rect.height || 0),
  };
}

function isLikelyGeneratedImageUrl(url) {
  const normalized = normalizeAssetUrl(url).toLowerCase();
  return IMAGE_URL_HINTS.some((hint) => normalized.includes(hint));
}

function getImageContextText(img) {
  const context = img.closest("figure, article, [data-message-author-role], [role='listitem'], main");
  return (context?.textContent || "").toLowerCase();
}

function getCardContextText(card) {
  const context = card.closest("section, article, [data-testid^='conversation-turn-'], [data-message-author-role], main");
  return (context?.textContent || "").toLowerCase();
}

function isAssistantTurn(element) {
  if (!element) return false;

  const assistantContainer = element.closest('[data-message-author-role="assistant"]');
  if (assistantContainer) return true;

  const turn = element.closest('[data-testid^="conversation-turn-"]');
  return turn?.getAttribute?.("data-message-author-role") === "assistant";
}

function isImageCreatedContext(text) {
  return IMAGE_CREATED_INDICATORS.some((indicator) => text.includes(indicator));
}

function getImageCards(root = document) {
  const cards = new Map();

  IMAGE_CARD_SELECTORS.forEach((selector) => {
    root.querySelectorAll(selector).forEach((card) => {
      const key = card.id || `${selector}:${cards.size}`;
      cards.set(key, card);
    });
  });

  return Array.from(cards.values());
}

function getLatestAssistantImageTurn() {
  const turns = Array.from(document.querySelectorAll('section[data-turn="assistant"]'));

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const text = (turn.textContent || "").toLowerCase();
    if (
      text.includes("image created") ||
      turn.querySelector('[id^="image-"], [data-testid="image-gen-overlay-actions"], img[alt*="Generated image"]')
    ) {
      return turn;
    }
  }

  return null;
}

function hasDownloadAction(card) {
  return !!card.querySelector([
    'button[aria-label*="Download this image"]',
    'button[aria-label*="Download image"]',
    'button[aria-label*="Save image"]',
    '[data-testid="image-gen-overlay-actions"]',
    '[data-testid*="download"]',
    'a[href*="oaiusercontent"]',
  ].join(", "));
}

function cardLooksLikeCompletedImage(card, candidate) {
  if (!candidate?.src) return false;

  const contextText = getCardContextText(card);
  if (hasDownloadAction(card) || isImageCreatedContext(contextText) || isAssistantTurn(card)) {
    return true;
  }

  const anchor = card.closest("a[href]") || card.querySelector("a[href]");
  return !!anchor?.href;
}

function getClassText(element) {
  if (!element) return "";
  if (typeof element.className === "string") return element.className.toLowerCase();
  return (element.getAttribute?.("class") || "").toLowerCase();
}

function getEffectiveOpacity(element, stopAt = null) {
  let opacity = 1;
  let current = element;

  while (current) {
    const style = window.getComputedStyle(current);
    opacity *= Number.parseFloat(style.opacity || "1");
    if (current === stopAt) break;
    current = current.parentElement;
  }

  return opacity;
}

function isBlurredInCard(element, card) {
  let current = element;

  while (current) {
    const style = window.getComputedStyle(current);
    const classText = getClassText(current);
    const filterText = `${style.filter || ""} ${style.backdropFilter || ""}`.toLowerCase();
    if (filterText.includes("blur(") || classText.includes("blur")) {
      return true;
    }
    if (current === card) break;
    current = current.parentElement;
  }

  return false;
}

function scoreImageCandidate(img, card) {
  const src = getBestImageUrl(img);
  if (!src) return null;

  const { width, height } = getImageDimensions(img);
  const descriptor = [
    img.alt,
    img.getAttribute("aria-label"),
    img.getAttribute("title"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const contextText = `${getImageContextText(img)} ${getCardContextText(card)}`;
  const opacity = getEffectiveOpacity(img, card);
  const blurred = isBlurredInCard(img, card);
  const style = window.getComputedStyle(img);
  const largeEnough = width >= MIN_IMAGE_SIZE && height >= MIN_IMAGE_SIZE;
  const looksLikeGeneratedImage = descriptor.includes("generated image") || isImageCreatedContext(contextText);
  const imageUrlLooksGenerated = isLikelyGeneratedImageUrl(src);
  const hidden =
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number.parseFloat(style.opacity || "1") <= 0.05;

  if ((!largeEnough && !looksLikeGeneratedImage) || (!imageUrlLooksGenerated && !looksLikeGeneratedImage)) {
    return null;
  }

  let score = 0;
  score += Math.min(width, 4096) + Math.min(height, 4096);
  score += opacity * 2000;
  if (looksLikeGeneratedImage) score += 2000;
  if (imageUrlLooksGenerated) score += 500;
  if (blurred) score -= 5000;
  if (opacity < 0.5) score -= 4000;
  if (hidden) score -= 6000;
  if (getClassText(img).includes("absolute")) score -= 250;
  score += Array.from(card.querySelectorAll("img")).indexOf(img);

  return {
    src,
    width,
    height,
    descriptor,
    contextText,
    opacity,
    score,
  };
}

function selectBestCardImage(card) {
  const candidates = Array.from(card.querySelectorAll("img"))
    .map((img) => scoreImageCandidate(img, card))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

function getBestImageUrl(img) {
  const srcSet = img.getAttribute("srcset") || img.closest("picture")?.querySelector("source")?.getAttribute("srcset");
  const srcSetUrl = srcSet?.split(",").pop()?.trim().split(" ")[0];
  const anchorHref = img.closest("a[href]")?.href;
  const directCandidates = [
    img.currentSrc,
    img.src,
    img.getAttribute("src"),
    img.getAttribute("data-src"),
    srcSetUrl,
  ]
    .filter(Boolean)
    .map(normalizeAssetUrl);
  const linkCandidates = [anchorHref]
    .filter(Boolean)
    .map(normalizeAssetUrl);

  const candidates = [...directCandidates, ...linkCandidates];

  // Prefer a stable remote URL over blob/data URLs when one is available.
  const preferred = candidates.find((url) => isLikelyGeneratedImageUrl(url) && !url.startsWith("blob:") && !url.startsWith("data:"));
  if (preferred) return preferred;

  const hinted = candidates.find(isLikelyGeneratedImageUrl);
  if (hinted) return hinted;

  const directRemote = directCandidates.find((url) => !url.startsWith("blob:") && !url.startsWith("data:"));
  if (directRemote) return directRemote;

  return directCandidates[0] || linkCandidates[0] || "";
}

function addDetectedImage(images, src, width, height, fallbackKey = "") {
  const fingerprint = getAssetFingerprint(src || fallbackKey);
  if (!fingerprint) {
    return;
  }

  images.set(fingerprint, {
    src,
    width,
    height,
    fingerprint,
  });
}

function extractImagesFromScope(root) {
  const images = new Map();
  const cards = getImageCards(root);

  cards.forEach((card) => {
    const candidate = selectBestCardImage(card);
    if (!candidate?.src || !cardLooksLikeCompletedImage(card, candidate)) {
      return;
    }

    addDetectedImage(images, candidate.src, candidate.width, candidate.height);
  });

  if (images.size === 0) {
    root.querySelectorAll("img").forEach((img) => {
      const src = getBestImageUrl(img);
      const { width, height } = getImageDimensions(img);
      const descriptor = [
        img.alt,
        img.getAttribute("aria-label"),
        img.getAttribute("title"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const contextText = getImageContextText(img);
      const assistantTurn = isAssistantTurn(img);

      const largeEnough = width >= MIN_IMAGE_SIZE && height >= MIN_IMAGE_SIZE;
      const looksLikeGeneratedImage = descriptor.includes("generated image") || isImageCreatedContext(contextText);
      const imageUrlLooksGenerated = src && isLikelyGeneratedImageUrl(src);
      const likelyCompletedOutput = assistantTurn || looksLikeGeneratedImage || img.closest("a[href]") || img.closest("figure");

      if ((largeEnough || likelyCompletedOutput) && (imageUrlLooksGenerated || likelyCompletedOutput)) {
        addDetectedImage(images, src, width, height, `${img.alt || ""}:${width}x${height}:${contextText.slice(0, 160)}`);
      }
    });
  }

  return Array.from(images.values());
}

function extractImages() {
  const latestAssistantTurn = getLatestAssistantImageTurn();
  if (latestAssistantTurn && isImageCreatedContext((latestAssistantTurn.textContent || "").toLowerCase())) {
    const latestTurnImages = extractImagesFromScope(latestAssistantTurn);
    if (latestTurnImages.length > 0) {
      return latestTurnImages;
    }
  }

  return extractImagesFromScope(document);
}

function latestAssistantImageTurnLooksReady() {
  const latestAssistantTurn = getLatestAssistantImageTurn();
  if (!latestAssistantTurn) {
    return false;
  }

  return isImageCreatedContext((latestAssistantTurn.textContent || "").toLowerCase());
}

function markLatestTurnActivity() {
  latestTurnActivityAt = Date.now();
}

function stopObservingLatestTurn() {
  if (latestTurnObserver) {
    latestTurnObserver.disconnect();
    latestTurnObserver = null;
  }
  observedLatestTurn = null;
}

function observeLatestAssistantTurn() {
  const latestTurn = getLatestAssistantImageTurn();
  if (!latestTurn) {
    stopObservingLatestTurn();
    return null;
  }

  if (observedLatestTurn === latestTurn && latestTurnObserver) {
    return latestTurn;
  }

  stopObservingLatestTurn();
  observedLatestTurn = latestTurn;
  markLatestTurnActivity();

  latestTurnObserver = new MutationObserver(() => {
    markLatestTurnActivity();
  });

  latestTurnObserver.observe(latestTurn, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style", "class", "aria-label", "data-testid"],
  });

  return latestTurn;
}

function hasTransitioningGeneratedLayers(root = null) {
  const scope = root || getLatestAssistantImageTurn() || document;
  const cards = getImageCards(scope);

  return cards.some((card) => Array.from(card.querySelectorAll('img[alt*="Generated image"], img')).some((img) => {
    const style = window.getComputedStyle(img);
    const opacity = getEffectiveOpacity(img, card);
    const filterText = `${style.filter || ""} ${style.backdropFilter || ""}`.toLowerCase();
    const display = style.display || "";
    const visibility = style.visibility || "";

    if (display === "none" || visibility === "hidden") {
      return false;
    }

    if (opacity > 0.05 && opacity < 0.995) {
      return true;
    }

    if (!img.complete) {
      return true;
    }

    if (filterText.includes("blur(") && !filterText.includes("blur(0")) {
      return true;
    }

    return false;
  }));
}

// Get only new images that weren't present before submission
function getNewImages() {
  const allImages = extractImages();
  return allImages.filter((img) => !initialImageFingerprints.has(img.fingerprint));
}

function getImageSignature(images) {
  return images
    .map((img) => img.fingerprint)
    .sort()
    .join("|");
}

async function handleSubmitPrompt(jobId, prompt, newThread = false) {
  currentJobId = jobId;
  
  // If new thread requested, navigate to new chat first
  if (newThread) {
    persistPendingJob({ id: jobId, prompt });
    console.log("[PixelQ] Starting new thread...");
    await startNewThread();
    await sleep(1500);
    await resumePendingJob();
    return;
  }
  
  // Capture current images before submission (to detect new ones)
  initialImageFingerprints = new Set(extractImages().map((img) => img.fingerprint));
  console.log("[PixelQ] Initial images count:", initialImageFingerprints.size);

  // Find and focus prompt box
  const promptBox = findPromptBox();
  if (!promptBox) {
    sendToBackground("generation_failed", {
      id: jobId,
      error: "Could not find prompt input box. Make sure you're on chatgpt.com",
    });
    return;
  }

  try {
    // Clear existing content
    if (promptBox.tagName === "TEXTAREA") {
      setNativeTextAreaValue(promptBox, "");
    } else {
      clearContentEditable(promptBox);
    }

    // Focus the element
    promptBox.focus();

    // Type the prompt
    await typeText(promptBox, prompt);

    // Small delay to let UI update
    await sleep(500);

    // Submit
    await submitPrompt(promptBox);

    const submission = await waitForSubmissionAcceptance(prompt, 15000);
    if (submission.rateLimited) {
      sendToBackground("rate_limited", {
        id: jobId,
        message: "ChatGPT rate limit detected",
      });
      return;
    }

    if (!submission.accepted) {
      sendToBackground("generation_failed", {
        id: jobId,
        error: "Prompt was not submitted to ChatGPT. The composer stayed unchanged.",
      });
      return;
    }

    // Notify submission started
    sendToBackground("prompt_submitted", { id: jobId });

    // Start polling for completion
    startPolling(jobId, { submissionAccepted: true, generationStarted: submission.generationStarted });
  } catch (error) {
    sendToBackground("generation_failed", {
      id: jobId,
      error: error.message,
    });
  }
}

async function startNewThread() {
  // Try various ways to start a new chat
  const newChatSelectors = [
    'a[href="/"]',
    'button[aria-label*="New chat"]',
    'nav a[href="/"]',
    '[data-testid="new-chat-button"]',
    'a[data-testid="create-new-chat-button"]',
  ];
  
  for (const selector of newChatSelectors) {
    const btn = document.querySelector(selector);
    if (btn) {
      console.log("[PixelQ] Found new chat button:", selector);
      btn.click();
      await sleep(1500);
      return;
    }
  }
  
  // Fallback: navigate directly
  console.log("[PixelQ] Navigating to new chat URL");
  window.location.href = 'https://chatgpt.com/';
  await sleep(2000);
}

async function typeText(element, text) {
  if (element.tagName === "TEXTAREA") {
    setNativeTextAreaValue(element, text);
  } else {
    element.focus();
    insertContentEditableText(element, text);
  }

  const valueSet = await waitForComposerValue(text, 2000);
  if (!valueSet) {
    throw new Error("PixelQ could not populate the ChatGPT composer.");
  }
}

function persistPendingJob(job) {
  try {
    sessionStorage.setItem(PENDING_JOB_STORAGE_KEY, JSON.stringify({
      ...job,
      queuedAt: Date.now(),
    }));
  } catch (error) {
    console.error("[PixelQ] Failed to persist pending job:", error);
  }
}

function readPendingJob() {
  try {
    const raw = sessionStorage.getItem(PENDING_JOB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.id || !parsed?.prompt) {
      sessionStorage.removeItem(PENDING_JOB_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(PENDING_JOB_STORAGE_KEY);
    return null;
  }
}

async function resumePendingJob() {
  if (resumePendingJobPromise) {
    return resumePendingJobPromise;
  }

  resumePendingJobPromise = (async () => {
    const pendingJob = readPendingJob();
    if (!pendingJob) {
      return;
    }

    sessionStorage.removeItem(PENDING_JOB_STORAGE_KEY);
    console.log("[PixelQ] Resuming pending job on fresh thread:", pendingJob.id);
    await handleSubmitPrompt(pendingJob.id, pendingJob.prompt, false);
  })();

  try {
    await resumePendingJobPromise;
  } finally {
    resumePendingJobPromise = null;
  }
}

async function submitPrompt(promptBox) {
  const sendButton = findSendButton();

  if (sendButton && !sendButton.disabled) {
    sendButton.click();
    return;
  }

  // Fallback: simulate Enter key
  const enterEvent = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });

  promptBox.dispatchEvent(enterEvent);
}

function startPolling(jobId, options = {}) {
  if (pollInterval) {
    clearInterval(pollInterval);
  }
  stopObservingLatestTurn();

  let stableImageCount = 0;
  let noImageAfterStopCount = 0;
  let idleAfterSubmissionCount = 0;
  let lastImageSignature = "";
  let lastImageSignatureChangeAt = 0;
  let generationStarted = options.generationStarted === true;
  const submissionAccepted = options.submissionAccepted === true;
  const maxWaitTime = 5 * 60 * 1000; // 5 minutes
  const startTime = Date.now();

  console.log("[PixelQ] Starting polling for job:", jobId);

  pollInterval = setInterval(() => {
    const latestTurn = observeLatestAssistantTurn();
    const generating = isGenerating();
    const rateLimited = isRateLimited();
    const newImages = getNewImages();
    const latestTurnReady = latestAssistantImageTurnLooksReady();
    const latestTurnQuietLongEnough =
      latestTurnActivityAt > 0 &&
      Date.now() - latestTurnActivityAt >= ASSISTANT_TURN_SETTLE_MS;
    const transitioningLayers = hasTransitioningGeneratedLayers(latestTurn);
    const elapsed = Date.now() - startTime;

    console.log(`[PixelQ] Poll: generating=${generating}, newImages=${newImages.length}, turnQuiet=${latestTurnQuietLongEnough}, transitioning=${transitioningLayers}, elapsed=${Math.round(elapsed/1000)}s`);

    // Check for timeout
    if (elapsed > maxWaitTime) {
        clearInterval(pollInterval);
        pollInterval = null;
        stopObservingLatestTurn();
        sendToBackground("generation_failed", {
          id: jobId,
          error: "Generation timed out after 5 minutes",
      });
      return;
    }

    // Check for rate limit
    if (rateLimited) {
        clearInterval(pollInterval);
        pollInterval = null;
        stopObservingLatestTurn();
        sendToBackground("rate_limited", {
          id: jobId,
          message: "ChatGPT rate limit detected",
      });
      return;
    }

    // Track generation start
    if (generating && !generationStarted) {
      generationStarted = true;
      console.log("[PixelQ] Generation started");
      sendToBackground("generation_started", { id: jobId });
    }

    // Check for completion
    // Either: generation stopped after it started, OR we have new images
    const generationStopped = !generating && generationStarted;
    const hasNewImages = newImages.length > 0;

    // Wait for images to stabilize, even if ChatGPT keeps a stale "generating" marker visible.
    if (hasNewImages) {
      idleAfterSubmissionCount = 0;
      const imageSignature = getImageSignature(newImages);
      if (imageSignature === lastImageSignature) {
        stableImageCount++;
      } else {
        stableImageCount = 1;
        lastImageSignature = imageSignature;
        lastImageSignatureChangeAt = Date.now();
      }

      noImageAfterStopCount = 0;
      const settledLongEnough =
        lastImageSignatureChangeAt > 0 &&
        Date.now() - lastImageSignatureChangeAt >= IMAGE_FINALIZATION_SETTLE_MS;
      const generationLikelyFinished =
        !generating ||
        (generationStarted && latestTurnReady && latestTurnQuietLongEnough && !transitioningLayers);

      // Only complete once the assistant image turn has gone quiet and any crossfades/sharpening layers have settled.
      if (stableImageCount >= 3 && settledLongEnough && latestTurnReady && latestTurnQuietLongEnough && !transitioningLayers && generationLikelyFinished) {
        const imageUrls = newImages.map((img) => img.src).filter(Boolean);
        if (imageUrls.length === 0) {
          return;
        }

        clearInterval(pollInterval);
        pollInterval = null;
        stopObservingLatestTurn();

        console.log("[PixelQ] Generation complete with", imageUrls.length, "images");
        sendToBackground("generation_complete", {
          id: jobId,
          images: imageUrls,
        });
        return;
      }
    } else if (generationStopped) {
      // Generation stopped but images can appear slightly later; give the DOM more time to settle.
      stableImageCount = 0;
      noImageAfterStopCount++;
      idleAfterSubmissionCount = 0;
      if (noImageAfterStopCount >= 15) {
        clearInterval(pollInterval);
        pollInterval = null;
        stopObservingLatestTurn();
        console.log("[PixelQ] Generation stopped but no images found");
        sendToBackground("generation_failed", {
          id: jobId,
          error: "Generation completed but no images found. ChatGPT may have responded with text instead.",
        });
      }
    } else if (submissionAccepted && !generationStarted) {
      idleAfterSubmissionCount++;
      if (idleAfterSubmissionCount >= 15) {
        clearInterval(pollInterval);
        pollInterval = null;
        stopObservingLatestTurn();
        console.log("[PixelQ] Submission accepted but generation never started");
        sendToBackground("generation_failed", {
          id: jobId,
          error: "ChatGPT accepted the prompt but never started image generation.",
        });
      }
    }
  }, 2000); // Poll every 2 seconds
}

function sendToBackground(type, data) {
  chrome.runtime.sendMessage({ type, ...data });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Notify background that content script is ready
sendToBackground("content_ready", { url: window.location.href });
setTimeout(() => {
  resumePendingJob().catch((error) => {
    console.error("[PixelQ] Failed to resume pending job:", error);
  });
}, 1200);

console.log("[PixelQ] Content script loaded on", window.location.href);
