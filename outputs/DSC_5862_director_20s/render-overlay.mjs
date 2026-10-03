import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(here, "overlay", "index.html");
const framesDir = path.join(here, "qa", "frames");

// puppeteer-core 与 Chrome 都按本机实际位置解析，换电脑不需要改脚本。
// 可用环境变量覆盖：
//   HYPIT_PUPPETEER_PACKAGE  指向含 node_modules 的 package.json
//   HYPIT_CHROME_PATH        指向 chrome.exe / chromium 可执行文件
function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadPuppeteer() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const candidates = [
    process.env.HYPIT_PUPPETEER_PACKAGE,
    path.join(here, "package.json"),
    path.join(here, "..", "package.json"),
    path.join(here, "..", "..", "hypit-local-demo", "package.json"),
    path.join(here, "..", "..", "..", "hypit-local-demo", "package.json"),
    path.join(home, "Documents", "视频制作", "hypit-local-demo", "package.json"),
    path.join(home, "Documents", "ChatGPT", "视频制作ds版本", "hypit-local-demo", "package.json"),
    path.join(home, "HYPIT", "hypit-workbench", "package.json")
  ];
  const tried = [];
  for (const base of candidates) {
    if (!base || !fs.existsSync(base)) continue;
    try {
      return createRequire(base)("puppeteer-core");
    } catch (error) {
      tried.push(`${base} -> ${error.code ?? error.message}`);
    }
  }
  throw new Error(
    [
      "puppeteer-core 未找到，已尝试：",
      ...tried.map((line) => `  ${line}`),
      "请设置环境变量 HYPIT_PUPPETEER_PACKAGE 指向含 node_modules 的 package.json。"
    ].join("\n")
  );
}

const puppeteer = loadPuppeteer();

const chromePath = firstExisting([
  process.env.HYPIT_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")
    : null,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
]);
if (!chromePath) {
  throw new Error("未找到 Chrome，请设置环境变量 HYPIT_CHROME_PATH 指向浏览器可执行文件。");
}

const fps = 30;
const duration = 20.4;
const totalFrames = Math.round(duration * fps);
const onlyTimes = process.argv
  .filter((arg) => arg.startsWith("--t="))
  .flatMap((arg) => arg.slice(4).split(","))
  .map(Number)
  .filter((value) => Number.isFinite(value));

const frameRange = process.argv
  .filter((arg) => arg.startsWith("--frames="))
  .map((arg) => arg.slice(9).split("-").map(Number))
  .find((pair) => pair.length === 2 && pair.every(Number.isFinite));

if (onlyTimes.length === 0 && !frameRange)
  fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--hide-scrollbars",
    "--allow-file-access-from-files"
  ]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href, {
    waitUntil: "load",
    timeout: 120000
  });
  await page.evaluate(() => document.fonts.ready);

  // 等所有 <video> 解码出可绘制帧，且全部暂停，保证逐帧 seek 是确定性的
  await page.evaluate(async () => {
    const vids = [...document.querySelectorAll("video")];
    await Promise.all(
      vids.map(
        (v) =>
          new Promise((resolve, reject) => {
            v.pause();
            if (v.readyState >= 2) return resolve();
            const timer = setTimeout(
              () => reject(new Error(`video not ready: ${v.currentSrc || v.src}`)),
              90000
            );
            v.addEventListener(
              "loadeddata",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          })
      )
    );
  });

  const syncMedia = async (time) => {
    await page.evaluate(async (t) => {
      const vids = [...document.querySelectorAll("video")];
      await Promise.all(
        vids.map(
          (v) =>
            new Promise((resolve) => {
              const limit = Number.isFinite(v.duration) ? v.duration - 0.02 : t;
              const target = Math.max(0, Math.min(t, limit));
              if (Math.abs(v.currentTime - target) < 0.0005) return resolve();
              v.addEventListener(
                "seeked",
                () => {
                  requestAnimationFrame(() => resolve());
                },
                { once: true }
              );
              v.currentTime = target;
              setTimeout(resolve, 1500);
            })
        )
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
    }, time);
  };

  const ready = await page.evaluate(
    () => !!window.__timelines?.["dsc5862-director-20s"]
  );
  if (!ready) throw new Error("overlay timeline not registered");

  // 预热：首次截图的 HTML 图层常滞后一帧，先丢弃一张
  await page.evaluate(() => {
    window.__timelines["dsc5862-director-20s"].seek(1.0, false);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.screenshot({ type: "jpeg", quality: 60 });

  const schedule = frameRange
    ? Array.from(
        { length: frameRange[1] - frameRange[0] + 1 },
        (_, k) => ({ i: frameRange[0] + k, time: (frameRange[0] + k) / fps })
      )
    : onlyTimes.length === 0
      ? Array.from({ length: totalFrames }, (_, i) => ({ i, time: i / fps }))
      : onlyTimes.map((time) => ({ i: Math.round(time * fps), time }));

  for (const { i, time } of schedule) {
    const t0 = Date.now();
    await page.evaluate((t) => {
      window.__timelines["dsc5862-director-20s"].seek(t, false);
    }, time);
    await syncMedia(time);
    const t1 = Date.now();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    await page.screenshot({
      path: path.join(framesDir, `frame_${String(i).padStart(5, "0")}.jpg`),
      type: "jpeg",
      quality: 93
    });
    console.log(`frame ${i} @ ${time.toFixed(2)}s seek=${t1 - t0}ms shot=${Date.now() - t1}ms`);
  }
} finally {
  await browser.close();
}

console.log(`rendered ${totalFrames} frames to ${framesDir}`);
