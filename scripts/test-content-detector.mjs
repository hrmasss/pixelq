import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function findChromeExecutable() {
  const candidates = [
    process.env.PIXELQ_CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  return candidates.find((candidate) => {
    try {
      return !!candidate && process.getuid ? true : true;
    } catch {
      return false;
    }
  }) || candidates[0];
}

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function stripActiveContent(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<link\b[^>]*rel=["']preload["'][^>]*>/gi, "");
}

async function main() {
  const chromePath = findChromeExecutable();
  if (!chromePath || !(await exists(chromePath))) {
    throw new Error("Could not find Chrome or Edge. Set PIXELQ_CHROME_PATH to a browser executable.");
  }

  const htmlPath = path.join(repoRoot, ".references", "chat-main.html");
  const contentScriptPath = path.join(repoRoot, "extension", "content.js");
  const rawHtml = await readFile(htmlPath, "utf8");
  const sanitizedHtml = stripActiveContent(rawHtml);

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  });

  const page = await browser.newPage();
  await page.addInitScript(() => {
    const listeners = [];
    globalThis.chrome = {
      runtime: {
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
            globalThis.__pixelqMessageListeners = listeners;
          },
        },
        sendMessage(message) {
          globalThis.__pixelqMessages = globalThis.__pixelqMessages || [];
          globalThis.__pixelqMessages.push(message);
          return Promise.resolve({ received: true });
        },
      },
    };
  });

  await page.setContent(sanitizedHtml, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ path: contentScriptPath });

  const result = await page.evaluate(() => {
    const latestTurn = globalThis.getLatestAssistantImageTurn?.();
    const images = globalThis.extractImages?.() || [];
    const latestTurnGeneratedImages = latestTurn
      ? Array.from(latestTurn.querySelectorAll('img[alt*="Generated image"]'))
      : [];
    const rawUrls = latestTurnGeneratedImages
      .map((img) => img.currentSrc || img.src || img.getAttribute("src") || "")
      .filter(Boolean);
    const uniqueFingerprints = Array.from(new Set(
      rawUrls.map((url) => globalThis.getAssetFingerprint?.(url) || "")
    )).filter(Boolean);
    return {
      latestTurnFound: !!latestTurn,
      latestTurnContainsImageCreated: (latestTurn?.textContent || "").toLowerCase().includes("image created"),
      imageCount: images.length,
      firstImageUrl: images[0]?.src || "",
      rawGeneratedUrlCount: rawUrls.length,
      uniqueGeneratedFingerprintCount: uniqueFingerprints.length,
      messageCount: (globalThis.__pixelqMessages || []).length,
      messages: (globalThis.__pixelqMessages || []).map((msg) => msg.type),
    };
  });

  await browser.close();

  console.log(JSON.stringify(result, null, 2));

  if (!result.latestTurnFound) {
    throw new Error("Detector smoke test failed: latest assistant image turn was not found.");
  }
  if (!result.latestTurnContainsImageCreated) {
    throw new Error("Detector smoke test failed: latest assistant turn did not contain 'Image created'.");
  }
  if (result.imageCount < 1) {
    throw new Error("Detector smoke test failed: extractImages() returned no images.");
  }
  if (result.uniqueGeneratedFingerprintCount < 2) {
    throw new Error("Detector smoke test failed: generated image revisions collapsed to the same fingerprint.");
  }
  if (!result.firstImageUrl.includes("file_00000000939c720b8e65e790801fe8b4")) {
    throw new Error("Detector smoke test failed: extractImages() did not prefer the visible final asset.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
