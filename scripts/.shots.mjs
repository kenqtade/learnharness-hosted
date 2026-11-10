import puppeteer from "puppeteer-core";
const out = "/home/user/architecture/shots";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-gpu","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"], defaultViewport: { width: 1440, height: 900 } });
const p = await b.newPage();
const net = [];
p.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) net.push(`${r.status()} ${r.url().replace("http://127.0.0.1:3000","")}`); });
const text = async () => (await p.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ").slice(0, 900);

await p.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle2" }); await sleep(1500);
await p.screenshot({ path: `${out}/01-home.png` });
console.log("HOME:", (await text()).slice(0,400)); console.log("NET:", net.splice(0).join(", "));

const d = await p.$('[data-testid="dictation-toggle"]');
if (d) { await d.click(); await sleep(1500); await p.screenshot({ path: `${out}/02-dictation-no-key.png` }); console.log("DICT:", (await text()).match(/Dictation[^|]*/)?.[0]); }

await p.goto("http://127.0.0.1:3000/chat/chat_mvzmwhlb_4eb33580", { waitUntil: "networkidle2" }); await sleep(2500);
await p.screenshot({ path: `${out}/03-your-session.png` });
console.log("SESSION:", await text()); console.log("NET:", net.splice(0).join(", "));

await p.goto("http://127.0.0.1:3000/api/capabilities", { waitUntil: "networkidle2" }); await sleep(500);
await p.screenshot({ path: `${out}/04-capabilities.png` });
await b.close();
