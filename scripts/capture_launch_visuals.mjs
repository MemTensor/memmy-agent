/** Capture the existing launch-visual DOM at native 4x pixels for desktop display. */
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const playwrightModule = process.env.MEMMY_CAPTURE_PLAYWRIGHT ?? "playwright";
const { chromium } = require(playwrightModule);
const chromePath = process.env.MEMMY_CAPTURE_CHROME;
const baseUrl = process.env.MEMMY_CAPTURE_URL ?? "http://127.0.0.1:19055";
const outputDir = resolve(process.env.MEMMY_CAPTURE_OUTPUT ?? "App/frontend/desktop/src/assets/launch");
const scale = Number(process.env.MEMMY_CAPTURE_SCALE ?? "4");
const visuals = (process.env.MEMMY_CAPTURE_VISUALS ?? "token,token-new,recording,marketplace,literature,office").split(",");
if (!Number.isInteger(scale) || scale < 2 || scale > 4) throw new Error("Capture scale must be 2, 3, or 4");
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 480, height: 400 }, deviceScaleFactor: scale });
  for (const locale of ["zh", "en"]) {
    for (const visual of visuals) {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/launch-visuals-preview.html?visual=${visual}&lang=${locale}&export=1`, { waitUntil: "networkidle" });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, (image) => image.complete ? undefined : new Promise((done) => {
          image.addEventListener("load", done, { once: true }); image.addEventListener("error", done, { once: true });
        })));
      });
      const path = resolve(outputDir, `launch-visual-${visual}${locale === "en" ? ".en" : ""}.png`);
      await page.locator(".launch-visual-canvas").screenshot({ path, type: "png", animations: "disabled" });
      console.log(`${visual}/${locale}: ${path}`);
      await page.close();
    }
  }
  await context.close();
} finally {
  await browser.close();
}
