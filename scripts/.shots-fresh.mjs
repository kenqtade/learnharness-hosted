import puppeteer from "puppeteer-core";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-gpu"], defaultViewport: { width: 1440, height: 900 } });
const p = await b.newPage();
await p.goto("http://127.0.0.1:3100/", { waitUntil: "networkidle2" }); await sleep(1500);
await p.screenshot({ path: "/home/user/architecture/shots/00-fresh-install.png" });
const t = await p.evaluate(() => document.body.innerText); console.log(/Set up your models/.test(t) ? "setup CTA visible" : "NO CTA");
await b.close();
