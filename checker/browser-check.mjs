// © 2026 The Sensible Studio. All rights reserved. Not licensed for copying, reuse or redistribution.
// Pagemarks weekly browser check: runs on GitHub Actions (see .github/workflows/browser-check.yml)
// Opens each saved Pagemark in a real (invisible) Chrome, lets its scripts run, and records where
// it really ends up and the title it shows there. Some harmful sites only redirect real browsers,
// so this catches what the nightly check can't see. The nightly check reads these results.
// Runs on a throwaway GitHub machine that's wiped afterwards. Downloads and pop-ups are blocked.
// Privacy: this repository is public, so the log only prints totals, never web addresses.

const PARALLEL = 4;
const PAGE_TIMEOUT_MS = 25000;
const SETTLE_MS = 6000;   // time for scripted redirects to happen
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Visit one address. Returns { finalUrl, title } or null if the page couldn't be opened.
export async function visit(browser, url) {
  const context = await browser.newContext({
    userAgent: UA, acceptDownloads: false, javaScriptEnabled: true,
    viewport: { width: 1366, height: 900 }, locale: "en-US", timezoneId: "America/New_York"
  });
  let tab = null;
  context.on("page", (p) => { if (tab && p !== tab) p.close().catch(() => {}); });   // close pop-ups
  tab = await context.newPage();
  tab.on("dialog", (d) => d.dismiss().catch(() => {}));                         // dismiss alerts
  try {
    await tab.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    // Let the page settle: scripted redirects usually happen within a few seconds
    const deadline = Date.now() + SETTLE_MS;
    let last = tab.url();
    while (Date.now() < deadline) {
      await tab.waitForTimeout(1000);
      const now = tab.url();
      if (now !== last) { last = now; await tab.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {}); }
    }
    const title = (await tab.title().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
    return { finalUrl: tab.url(), title };
  } catch {
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error("Missing FIREBASE_SERVICE_ACCOUNT secret."); process.exit(1); }
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { chromium } = await import("playwright");
  initializeApp({ credential: cert(JSON.parse(raw)) });
  const db = getFirestore();

  const snap = await db.collectionGroup("pagemarks").get();
  const docs = snap.docs.filter((d) => {
    const data = d.data();
    if (!data.url || !/^https?:\/\//i.test(data.url)) return false;
    // Skip websites that no longer exist at all; there's nothing to open
    return !(data.link && data.link.status === "broken" && data.link.code === 0);
  });
  console.log(`Opening ${docs.length} Pagemarks in a real browser…`);

  const browser = await chromium.launch({ headless: true });
  const totals = { opened: 0, failed: 0, elsewhere: 0 };
  const sameSite = (a, b) => {
    try {
      const h = (u) => new URL(u).hostname.replace(/^www\./, "").toLowerCase();
      return h(a) === h(b);
    } catch { return true; }
  };
  let index = 0;
  async function worker() {
    while (index < docs.length) {
      const d = docs[index++];
      const url = d.data().url;
      const r = await visit(browser, url);
      if (!r) { totals.failed++; continue; }
      totals.opened++;
      if (!sameSite(url, r.finalUrl)) totals.elsewhere++;
      await d.ref.update({ "link.browser": { finalUrl: r.finalUrl, title: r.title, at: Date.now() } });
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  await browser.close();
  console.log(`Done. Opened: ${totals.opened}, couldn't open: ${totals.failed}, ended up on a different website: ${totals.elsewhere}.`);
  process.exit(0);
}

if (process.env.FIREBASE_SERVICE_ACCOUNT !== undefined || process.argv.includes("--run")) await main();
