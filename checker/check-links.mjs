// Pagemarks link checker — runs on GitHub Actions (see .github/workflows/check-links.yml)
// Visits every saved Pagemark and records whether the page still works.
// Privacy: this repository is public, so the log only prints totals, never web addresses.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT secret.");
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(raw)) });
const db = getFirestore();

const TIMEOUT_MS = 20000;
const PARALLEL = 8;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 PagemarksLinkChecker";

function sameishPlace(a, b) {
  try {
    const A = new URL(a), B = new URL(b);
    const host = (u) => u.hostname.replace(/^www\./, "").toLowerCase();
    const path = (u) => u.pathname.replace(/\/+$/, "") || "/";
    return host(A) === host(B) && path(A) === path(B);
  } catch { return true; }
}

async function request(url, method) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" }
    });
    // For refusals, keep a little of the page so we can tell "bot protection" from a real refusal
    let sample = "";
    if (method === "GET" && (res.status === 401 || res.status === 403) && res.body) {
      try {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        while (sample.length < 32000) {
          const { done, value } = await reader.read();
          if (done) break;
          sample += dec.decode(value, { stream: true });
        }
        try { await reader.cancel(); } catch { /* ignore */ }
      } catch { /* ignore */ }
    } else {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    const headers = {};
    for (const k of ["server", "cf-mitigated", "x-datadome", "x-sucuri-id", "x-iinfo", "x-amz-cf-id", "set-cookie"]) {
      const v = res.headers.get(k);
      if (v) headers[k] = v;
    }
    return { code: res.status, finalUrl: res.url || url, sample, headers };
  } catch (e) {
    const cause = e.cause?.code || e.name || "ERROR";
    return { code: 0, error: String(cause) };
  } finally {
    clearTimeout(timer);
  }
}

// Signs that a 403 came from an anti-bot service rather than the page itself
function looksLikeBotProtection(r) {
  const h = r.headers || {};
  const server = (h["server"] || "").toLowerCase();
  if (h["cf-mitigated"] || h["x-datadome"] || h["x-sucuri-id"] || h["x-iinfo"]) return true;
  if (/cloudflare|akamai|incapsula|imperva|sucuri|ddos-guard|datadome|perimeterx|kasada|cloudfront|varnish/.test(server)) return true;
  if (/datadome|_px|incap_ses|visid_incap|ak_bmsc|bm_sv|__cf_bm/i.test(h["set-cookie"] || "")) return true;
  const body = (r.sample || "").toLowerCase();
  return /just a moment|checking your browser|verify you are human|are you a robot|captcha|cf-chl|challenge-platform|attention required|enable javascript and cookies|access denied|perimeterx|px-captcha|datadome|incapsula|request unsuccessful|bot detection|unusual traffic/.test(body);
}

// ok | moved | broken | unknown
async function check(url) {
  let r = await request(url, "HEAD");
  if (r.code === 0 || r.code === 405 || r.code === 403 || r.code === 400 || r.code >= 500 || r.code === 404) {
    // Many sites dislike HEAD; confirm with a normal GET.
    r = await request(url, "GET");
  }
  if (r.code === 0) {
    const dead = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|CERT|ERR_TLS|UNABLE_TO_VERIFY/i.test(r.error || "");
    return { status: dead ? "broken" : "unknown", code: 0, finalUrl: "", reason: r.error || "no response" };
  }
  if (r.code >= 200 && r.code < 300) {
    const moved = !sameishPlace(url, r.finalUrl);
    return { status: moved ? "moved" : "ok", code: r.code, finalUrl: moved ? r.finalUrl : "", reason: "" };
  }
  if (r.code === 404 || r.code === 410 || r.code >= 500) {
    return { status: "broken", code: r.code, finalUrl: "", reason: "HTTP " + r.code };
  }
  // 403: either bot protection (page works for people) or a real refusal (page is closed to everyone)
  if (r.code === 403 && !looksLikeBotProtection(r)) {
    return { status: "broken", code: 403, finalUrl: "", reason: "HTTP 403, access refused" };
  }
  // 401 (sign-in needed), 429 (too many requests), bot screens and others: not proof the page is gone.
  const why = r.code === 401 ? "needs sign-in" : r.code === 429 ? "site asked us to slow down" : r.code === 403 ? "site blocks automated checks" : "HTTP " + r.code;
  return { status: "unknown", code: r.code, finalUrl: "", reason: why };
}

async function waybackCopy(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch("https://archive.org/wayback/available?url=" + encodeURIComponent(url), { signal: ctrl.signal });
    clearTimeout(t);
    const j = await res.json();
    const snap = j?.archived_snapshots?.closest;
    return snap?.available && snap.url ? snap.url.replace(/^http:/, "https:") : "";
  } catch { return ""; }
}

const snap = await db.collectionGroup("pagemarks").get();
const docs = snap.docs;
console.log(`Checking ${docs.length} Pagemarks…`);

const totals = { ok: 0, moved: 0, broken: 0, unknown: 0, skipped: 0 };
let index = 0;

async function worker() {
  while (index < docs.length) {
    const d = docs[index++];
    const data = d.data();
    const url = data.url;
    if (!url || !/^https?:\/\//i.test(url)) { totals.skipped++; continue; }

    const result = await check(url);
    const prev = data.link || {};
    // A page must fail two checks in a row before it shows as broken (avoids false alarms).
    const fails = result.status === "broken" ? (prev.fails || 0) + 1 : 0;
    let shown = result.status;
    if (result.status === "broken" && fails < 2) shown = prev.status === "ok" || prev.status === "moved" ? prev.status : "unknown";

    const link = {
      status: shown,
      code: result.code,
      finalUrl: result.finalUrl,
      reason: result.reason,
      fails,
      checkedAt: FieldValue.serverTimestamp(),
      archiveUrl: prev.archiveUrl || ""
    };
    if (shown === "broken" && !link.archiveUrl) link.archiveUrl = await waybackCopy(url);

    await d.ref.update({ link });
    totals[shown]++;
  }
}

await Promise.all(Array.from({ length: PARALLEL }, worker));
console.log(`Done. Working: ${totals.ok}, moved: ${totals.moved}, broken: ${totals.broken}, couldn't check: ${totals.unknown}, skipped: ${totals.skipped}`);
process.exit(0);
