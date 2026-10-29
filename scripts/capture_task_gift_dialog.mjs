/** Capture the complete local gift-dialog mock at native 2x pixels. */
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MEMMY_CAPTURE_PLAYWRIGHT ?? "playwright");
const baseUrl = process.env.MEMMY_CAPTURE_URL ?? "http://127.0.0.1:19055";
const outputDir = resolve("docs/validation");
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.MEMMY_CAPTURE_CHROME ? { executablePath: process.env.MEMMY_CAPTURE_CHROME } : {}) });
try {
  for (const locale of ["zh", "en"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/task-token-gift-preview.html?variant=existing${locale === "en" ? "&lang=en" : ""}`, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, (image) => image.complete ? undefined : new Promise((done) => {
        image.addEventListener("load", done, { once: true }); image.addEventListener("error", done, { once: true });
      })));
    });
    const path = resolve(outputDir, `task-token-gift-dialog.${locale}.png`);
    await page.locator(".task-gift-dialog").screenshot({ path, type: "png", animations: "disabled" });
    console.log(`${locale}: ${path}`);
    await context.close();
  }
} finally { await browser.close(); }
