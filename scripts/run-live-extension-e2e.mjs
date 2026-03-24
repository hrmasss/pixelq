import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const PROMPT_SELECTORS = [
  "div#prompt-textarea[contenteditable='true']",
  "div.ProseMirror#prompt-textarea",
  "textarea#prompt-textarea",
  "textarea[data-testid='prompt-textarea']",
  "div[contenteditable='true'][data-testid='prompt-textarea']",
  "div[contenteditable='true'][aria-label*='prompt']",
  "div[contenteditable='true'][aria-label*='Message']",
];

function resolveUserDataDir() {
  if (process.env.PIXELQ_CHROME_USER_DATA_DIR) {
    return path.resolve(process.env.PIXELQ_CHROME_USER_DATA_DIR);
  }
  return path.join(repoRoot, ".tmp", "e2e-user-data");
}

async function ensureChromeProfileSeeded(userDataDir) {
  const localStatePath = path.join(userDataDir, "Local State");
  try {
    await readFile(localStatePath, "utf8");
    return;
  } catch {}

  const sourceRoot = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  await mkdir(path.join(userDataDir, "Default", "Network"), { recursive: true });
  for (const relative of [
    "Local State",
    path.join("Default", "Preferences"),
    path.join("Default", "Secure Preferences"),
    path.join("Default", "Network", "Cookies"),
  ]) {
    const src = path.join(sourceRoot, relative);
    const dst = path.join(userDataDir, relative);
    try {
      const content = await readFile(src);
      await mkdir(path.dirname(dst), { recursive: true });
      await import("node:fs/promises").then(({ writeFile }) => writeFile(dst, content));
    } catch {}
  }
}

async function collectFiles(rootDir) {
  const results = new Set();

  async function walk(current) {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        results.add(fullPath);
      }
    }
  }

  await walk(rootDir);
  return results;
}

async function waitForChatGPTReady(page) {
  const combinedSelector = PROMPT_SELECTORS.join(", ");
  try {
    await page.waitForSelector(combinedSelector, { timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

async function discoverExtensionId(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    try {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10000 });
    } catch {}
  }

  if (serviceWorker) {
    return serviceWorker.url().split("/")[2];
  }

  const page = await context.newPage();
  try {
    await page.goto("chrome://extensions", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const extensionId = await page.evaluate(() => {
      const manager = document.querySelector("extensions-manager");
      const managerRoot = manager?.shadowRoot;
      const itemList = managerRoot?.querySelector("extensions-item-list");
      const listRoot = itemList?.shadowRoot;
      const items = Array.from(listRoot?.querySelectorAll("extensions-item") || []);

      for (const item of items) {
        const root = item.shadowRoot;
        const name = root?.querySelector("#name")?.textContent?.trim();
        if (name === "PixelQ") {
          return item.getAttribute("id");
        }
      }

      return "";
    });

    if (!extensionId) {
      throw new Error("PixelQ extension was not listed on chrome://extensions.");
    }

    return extensionId;
  } finally {
    await page.close().catch(() => {});
  }
}

async function readPopupState(popupPage, promptMarker) {
  return popupPage.evaluate((marker) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(document.querySelectorAll(".job-card, .card, .surface"));
    const bodyText = normalize(document.body.innerText);

    const findSectionText = (selector) => {
      const el = document.querySelector(selector);
      return normalize(el?.innerText || "");
    };

    return {
      bodyText,
      activeText: findSectionText("#active-list"),
      backlogText: findSectionText("#backlog-list"),
      historyText: findSectionText("#history-list"),
      statsText: findSectionText("#queue-stats"),
      matchingPromptVisible: bodyText.includes(marker),
      done: bodyText.includes(marker) && (bodyText.includes("Done") || bodyText.includes("completed")),
      failed: bodyText.includes(marker) && bodyText.includes("Failed"),
      running: bodyText.includes(marker) && bodyText.includes("Running"),
    };
  }, promptMarker);
}

async function main() {
  const extensionPath = path.join(repoRoot, "extension");
  const userDataDir = resolveUserDataDir();
  const downloadsDir = path.join(process.env.USERPROFILE || "", "Downloads", "PixelQ");
  const promptMarker = `pixelq e2e ${Date.now()}`;
  const prompt = `Create a simple black square icon on a white background. ${promptMarker}`;

  await mkdir(userDataDir, { recursive: true });
  if (process.env.PIXELQ_IMPORT_CHROME_SESSION === "1") {
    await ensureChromeProfileSeeded(userDataDir);
  }
  const beforeDownloads = await collectFiles(downloadsDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: "chromium",
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--profile-directory=Default",
    ],
  });

  try {
    const extensionId = await discoverExtensionId(context);
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;

    const chatPage = await context.newPage();
    await chatPage.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });

    const ready = await waitForChatGPTReady(chatPage);
    if (!ready) {
      throw new Error("ChatGPT was not ready in the automated browser. The copied profile may not be logged in.");
    }

    const popupPage = await context.newPage();
    await popupPage.goto(popupUrl, { waitUntil: "domcontentloaded" });
    await popupPage.waitForSelector('button[data-tab="create"]', { timeout: 15000 });

    await popupPage.click('button[data-tab="create"]');
    await popupPage.waitForSelector("#quick-prompt", { timeout: 15000, state: "visible" });
    if (!(await popupPage.isChecked("#auto-download"))) {
      await popupPage.click("#auto-download");
    }
    if (!(await popupPage.isChecked("#new-thread"))) {
      await popupPage.click("#new-thread");
    }

    await popupPage.fill("#quick-prompt", prompt);
    await popupPage.click("#quick-submit");
    await popupPage.waitForTimeout(1500);
    await popupPage.click('button[data-tab="queue"]');

    let finalState = null;
    const start = Date.now();
    while (Date.now() - start < 4 * 60 * 1000) {
      await popupPage.waitForTimeout(5000);
      finalState = await readPopupState(popupPage, promptMarker);
      if (finalState.done || finalState.failed) {
        break;
      }
    }

    const afterDownloads = await collectFiles(downloadsDir);
    const newDownloads = Array.from(afterDownloads).filter((file) => !beforeDownloads.has(file));
    const chatSignals = await chatPage.evaluate(() => ({
      imageCreatedText: document.body.innerText.includes("Image created"),
      generatedImageCount: document.querySelectorAll('img[alt*="Generated image"]').length,
    }));

    const result = {
      popupUrl,
      prompt,
      finalState,
      chatSignals,
      newDownloadCount: newDownloads.length,
      newDownloads,
    };

    console.log(JSON.stringify(result, null, 2));

    if (!finalState?.done) {
      throw new Error("Live e2e failed: job did not reach Done state.");
    }
    if (chatSignals.generatedImageCount < 1 && !chatSignals.imageCreatedText) {
      throw new Error("Live e2e failed: ChatGPT page did not show generated-image signals.");
    }
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
