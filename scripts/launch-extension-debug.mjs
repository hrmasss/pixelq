import { mkdir } from "node:fs/promises";
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

  return candidates[0];
}

function resolveUserDataDir() {
  if (process.env.PIXELQ_CHROME_USER_DATA_DIR) {
    return path.resolve(process.env.PIXELQ_CHROME_USER_DATA_DIR);
  }
  return path.join(repoRoot, ".tmp", "chrome-extension-profile");
}

async function main() {
  const extensionPath = path.join(repoRoot, "extension");
  const userDataDir = resolveUserDataDir();
  const profileDirectory = process.env.PIXELQ_CHROME_PROFILE_DIR;
  await mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromeExecutable(),
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
    ],
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  }

  const extensionId = serviceWorker.url().split("/")[2];
  const debugUrl = process.argv[2] || "https://chatgpt.com/";

  console.log(`Extension ID: ${extensionId}`);
  console.log(`Popup URL: chrome-extension://${extensionId}/popup/popup.html`);
  console.log(`Opening: ${debugUrl}`);
  console.log(`User data dir: ${userDataDir}`);
  if (profileDirectory) {
    console.log(`Profile directory: ${profileDirectory}`);
  }

  const page = await context.newPage();
  await page.goto(debugUrl, { waitUntil: "domcontentloaded" });

  console.log("Chrome is running with the unpacked PixelQ extension loaded.");
  console.log("Use a real Chrome profile if you want an existing logged-in ChatGPT session.");
  console.log("If you point PIXELQ_CHROME_USER_DATA_DIR at your real Chrome user-data folder, close Chrome first.");
  console.log("Keep this process open while you debug. Press Ctrl+C to close Chrome.");

  process.on("SIGINT", async () => {
    await context.close();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
