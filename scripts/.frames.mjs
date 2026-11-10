import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const out = "/home/user/architecture/frames"; mkdirSync(out, { recursive: true });
const b = await puppeteer.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-gpu","--font-render-hinting=none"], defaultViewport: { width: 1920, height: 1080 } });
const p = await b.newPage();
await p.goto("file:///home/user/architecture/learnharness-architecture.html", { waitUntil: "load" });
await p.evaluate(() => document.fonts.ready);
const n = await p.$$eval("section.slide", (s) => s.length);
for (let i = 1; i <= n; i++) {
  const el = await p.$(`#s${i}`);
  await el.screenshot({ path: `${out}/slide-${String(i).padStart(2, "0")}.png` });
  const overflow = await p.$eval(`#s${i}`, (s) => [...s.querySelectorAll("*")].some((c) => { const r = c.getBoundingClientRect(), R = s.getBoundingClientRect(); return r.bottom > R.bottom + 1 || r.right > R.right + 1; }));
  console.log(`slide ${i}${overflow ? "  ⚠ content overflows" : ""}`);
}
await b.close();
