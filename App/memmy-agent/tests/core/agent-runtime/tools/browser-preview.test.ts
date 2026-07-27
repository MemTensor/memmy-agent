import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyBrowserNavigateTarget,
  createBrowserPreview,
} from "../../../../src/core/agent-runtime/tools/browser-preview.js";

const roots: string[] = [];
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function tmpRoot(prefix = "memmy-browser-preview-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = path.join(root, "data");
  return root;
}

function write(root: string, relativePath: string, content: string | Buffer): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

afterEach(() => {
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("browser preview target classification", () => {
  it("distinguishes HTTP URLs and supported local HTML paths", () => {
    expect(classifyBrowserNavigateTarget("https://example.com/page")).toEqual({
      kind: "url",
      url: "https://example.com/page",
    });
    expect(classifyBrowserNavigateTarget("./page.html")).toEqual({
      kind: "path",
      path: "./page.html",
    });
    expect(classifyBrowserNavigateTarget("nested/page.HTM")).toEqual({
      kind: "path",
      path: "nested/page.HTM",
    });
    expect(classifyBrowserNavigateTarget("C:\\site\\page.html")).toEqual({
      kind: "path",
      path: "C:\\site\\page.html",
    });
  });

  it("rejects file URLs, unsupported schemes, non-HTML files, and path URL syntax", () => {
    expect(() => classifyBrowserNavigateTarget("file:///tmp/page.html")).toThrow(
      "file:// is disabled",
    );
    expect(() => classifyBrowserNavigateTarget("ftp://example.com/page.html")).toThrow(
      "only HTTP/HTTPS",
    );
    expect(() => classifyBrowserNavigateTarget("./script.js")).toThrow(
      "expected a .html or .htm file",
    );
    expect(() => classifyBrowserNavigateTarget("./page.html?mode=test")).toThrow(
      "query and fragment",
    );
    expect(() => classifyBrowserNavigateTarget("~/page.html")).toThrow(
      "home expansion",
    );
  });
});

describe("createBrowserPreview", () => {
  it("serves the static dependency closure without exposing unrelated files", async () => {
    const root = tmpRoot();
    write(root, "index.html", `
      <!doctype html>
      <link rel="stylesheet" href="./styles/main.css">
      <script type="module" src="./scripts/main.js"></script>
      <img src="./images/hero.png">
      <img srcset="data:image/png;base64,AA== 1x, ./images/hero-2.png 2x">
      <iframe src="./frame.html"></iframe>
      <a href="./about.html?from=home">About</a>
      <script>fetch("./secret.txt")</script>
    `);
    write(root, "styles/main.css", `
      @import "./theme.css";
      @font-face { font-family: Demo; src: url("../fonts/demo.woff2"); }
      body { background-image: url("../images/background.svg#shape"); }
    `);
    write(root, "styles/theme.css", "body { color: #123; }");
    write(root, "scripts/main.js", `
      import "./dep.js";
      import "bare-package";
      export { value } from "./value.js";
      const asset = new URL("../images/module.svg", import.meta.url);
      void asset;
    `);
    write(root, "scripts/dep.js", "export const dep = true;");
    write(root, "scripts/value.js", "export const value = 1;");
    write(root, "images/hero.png", Buffer.from([1, 2, 3]));
    write(root, "images/hero-2.png", Buffer.from([3, 2, 1]));
    write(root, "images/background.svg", "<svg></svg>");
    write(root, "images/module.svg", "<svg></svg>");
    write(root, "fonts/demo.woff2", Buffer.from([4, 5, 6]));
    write(root, "frame.html", "<p>Frame</p>");
    write(root, "about.html", "<p>About</p>");
    write(root, "secret.txt", "not statically included");

    const preview = await createBrowserPreview("index.html", {
      workspace: root,
      restrictLocalFiles: true,
    });
    try {
      const entry = await fetch(preview.url);
      expect(entry.status).toBe(200);
      expect(entry.headers.get("cache-control")).toBe("no-store");
      expect(entry.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await entry.text()).toContain("styles/main.css");

      for (const relativePath of [
        "styles/main.css",
        "styles/theme.css",
        "scripts/main.js",
        "scripts/dep.js",
        "scripts/value.js",
        "images/hero.png",
        "images/hero-2.png",
        "images/background.svg",
        "images/module.svg",
        "fonts/demo.woff2",
        "frame.html",
        "about.html?from=home",
      ]) {
        const response = await fetch(new URL(relativePath, preview.url));
        expect(response.status, relativePath).toBe(200);
      }

      expect((await fetch(new URL("secret.txt", preview.url))).status).toBe(404);
      expect((await fetch(new URL("missing.txt", preview.url))).status).toBe(404);
      expect((await fetch(preview.url, { method: "POST" })).status).toBe(405);
      expect((await fetch(preview.url, { method: "HEAD" })).status).toBe(200);
      expect(preview.url).not.toContain(root);
    } finally {
      await preview.close();
    }
  });

  it("supports external assets and cyclic local styles without following external URLs", async () => {
    const root = tmpRoot();
    write(root, "index.html", `
      <link rel="stylesheet" href="./a.css">
      <img src="https://example.com/not-fetched.png">
      <img src="data:image/png;base64,AA==">
    `);
    write(root, "a.css", '@import "./b.css";');
    write(root, "b.css", '@import "./a.css";');

    const preview = await createBrowserPreview(path.join(root, "index.html"), {
      workspace: root,
      restrictLocalFiles: true,
    });
    try {
      expect((await fetch(new URL("a.css", preview.url))).status).toBe(200);
      expect((await fetch(new URL("b.css", preview.url))).status).toBe(200);
    } finally {
      await preview.close();
    }
  });

  it("honors a local base href and workspace-root-relative assets", async () => {
    const root = tmpRoot();
    write(root, "pages/index.html", `
      <base href="/assets/">
      <link rel="stylesheet" href="theme.css">
    `);
    write(root, "assets/theme.css", "body { color: green; }");

    const preview = await createBrowserPreview("pages/index.html", {
      workspace: root,
      restrictLocalFiles: true,
    });
    try {
      const response = await fetch(new URL("/assets/theme.css", preview.url));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("green");
    } finally {
      await preview.close();
    }
  });

  it("allows readable outside files only when local file restriction is disabled", async () => {
    const workspace = tmpRoot("memmy-browser-preview-workspace-");
    const outside = tmpRoot("memmy-browser-preview-outside-");
    const entry = write(outside, "page.html", "<p>Outside</p>");

    await expect(createBrowserPreview(entry, {
      workspace,
      restrictLocalFiles: true,
    })).rejects.toThrow("outside the allowed file roots");

    const preview = await createBrowserPreview(entry, {
      workspace,
      restrictLocalFiles: false,
    });
    try {
      expect(await (await fetch(preview.url)).text()).toContain("Outside");
    } finally {
      await preview.close();
    }
  });

  it("applies the same realpath boundary to dependencies", async () => {
    const workspace = tmpRoot("memmy-browser-preview-symlink-");
    const outside = tmpRoot("memmy-browser-preview-symlink-outside-");
    const outsideStyle = write(outside, "outside.css", "body { color: red; }");
    write(workspace, "index.html", '<link rel="stylesheet" href="./linked.css">');
    fs.symlinkSync(outsideStyle, path.join(workspace, "linked.css"));

    await expect(createBrowserPreview("index.html", {
      workspace,
      restrictLocalFiles: true,
    })).rejects.toThrow("outside the allowed file roots");
  });

  it("rejects local file references and cleans up after closing", async () => {
    const root = tmpRoot();
    write(root, "bad.html", '<img src="file:///tmp/private.png">');

    await expect(createBrowserPreview("bad.html", {
      workspace: root,
      restrictLocalFiles: true,
    })).rejects.toThrow("does not allow file: references");

    write(root, "good.html", "<p>Done</p>");
    const preview = await createBrowserPreview("good.html", {
      workspace: root,
      restrictLocalFiles: true,
    });
    expect((await fetch(preview.url)).status).toBe(200);
    await preview.close();
    await preview.close();
    await expect(fetch(preview.url)).rejects.toThrow();
  });

  it("enforces the fixed dependency file limit", async () => {
    const root = tmpRoot();
    const images = Array.from({ length: 512 }, (_, index) => {
      const filename = `images/${index}.png`;
      write(root, filename, Buffer.from([index % 256]));
      return `<img src="./${filename}">`;
    });
    write(root, "index.html", images.join("\n"));

    await expect(createBrowserPreview("index.html", {
      workspace: root,
      restrictLocalFiles: true,
    })).rejects.toThrow("512-file limit");
  });
});
