// © 2026 The Sensible Studio. All rights reserved. Not licensed for copying, reuse or redistribution.
// Pagemarks link checker — runs on GitHub Actions (see .github/workflows/check-links.yml)
// Visits every saved Pagemark and records whether the page still works, and whether it may
// have become unsafe (new owner, harmful-site lists, parked, or sending visitors elsewhere).
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
    if (host(A) === host(B) && path(A) === path(B)) return true;
    // A site's home page sending visitors to their country's edition (/ca/, /en-us/, /uk/)
    return host(A) === host(B) && path(A) === "/" && /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?|intl|international|global)$/i.test(path(B));
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


// ---------------------------------------------------------------------------
// Safety checks: is this still the same, safe place you saved?
// An old website can expire and be bought by someone else, who reuses its address to send
// visitors to ads, scams or malware. These checks look for that. Only site names are looked up.
// ---------------------------------------------------------------------------

// The part of a site name that's registered, e.g. "news.example.co.uk" -> "example.co.uk"
const TWO_PART = /\.(co|com|net|org|gov|edu|ac|or|ne|go|gob|nic|ltd|plc|me|id)\.[a-z]{2}$/i;
function registered(host) {
  host = (host || "").toLowerCase().replace(/\.$/, "");
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return "";
  const parts = host.split(".");
  if (parts.length < 2) return "";
  return parts.slice(TWO_PART.test(host) ? -3 : -2).join(".");
}
const hostOfUrl = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };

// Endings often used for throwaway redirect and scam sites
const RISKY_ENDINGS = new Set(["site", "top", "xyz", "click", "buzz", "icu", "cyou", "cfd", "sbs", "rest", "bond",
  "autos", "quest", "mom", "beauty", "hair", "skin", "makeup", "boats", "monster", "lol", "sbs", "pics", "zip", "mov", "gdn", "work"]);
const riskyEnding = (host) => RISKY_ENDINGS.has(host.split(".").pop());

async function getJson(url, headers = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) return { status: r.status, json: null };
    return { status: r.status, json: await r.json() };
  } catch { return { status: 0, json: null }; }
  finally { clearTimeout(t); }
}

// 1. Blocklists, asked fresh every night (sites can turn bad after you save them).
//    Cloudflare answers 0.0.0.0 for sites on its lists: "security" = malware and phishing,
//    "family" = those plus adult sites (the same list Pagemarks uses when you save).
const dnsCache = new Map();
async function blocked(host, list) {
  const key = list + ":" + host;
  if (dnsCache.has(key)) return dnsCache.get(key);
  const { json } = await getJson(`https://${list}.cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
    { accept: "application/dns-json" }, 6000);
  const hit = !!json && (json.Answer || []).some((a) => a.type === 1 && a.data === "0.0.0.0");
  dnsCache.set(key, hit);
  return hit;
}

// 2. When was this website's address last registered? (Public registry records, via RDAP.)
//    Asked about once a week per Pagemark. Returns a time in ms, null if unknown.
const regCache = new Map();
let rdapCalls = 0;
let rdapQueue = Promise.resolve();   // one lookup at a time, to be gentle with the public registry service
function registeredOn(domain) {
  if (!domain) return Promise.resolve(null);
  if (!regCache.has(domain)) {
    const job = rdapQueue.then(async () => {
      rdapCalls++;
      await new Promise((r) => setTimeout(r, 400));
      const { json } = await getJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { accept: "application/rdap+json" }, 12000);
      const ev = (json?.events || []).find((e) => /^registration$/i.test(e.eventAction || ""));
      const t = ev && ev.eventDate ? Date.parse(ev.eventDate) : NaN;
      return Number.isNaN(t) ? null : t;
    });
    rdapQueue = job.catch(() => null);
    regCache.set(domain, job.catch(() => null));
  }
  return regCache.get(domain);
}

// 3. A quick look at the page itself (once a week): parked or "for sale" pages, and pages
//    whose only job is to bounce visitors to an unrelated website.
async function samplePage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" } });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") || "html")) { try { await res.body?.cancel(); } catch {} return null; }
    let html = "";
    const reader = res.body.getReader(); const dec = new TextDecoder();
    while (html.length < 120000) { const { done, value } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }); }
    try { await reader.cancel(); } catch {}
    return { html, finalUrl: res.url || url };
  } catch { return null; }
  finally { clearTimeout(t); }
}
const PARKED = /(this|the) domain (name )?(is|may be) for sale|buy this domain|domain is parked|parked (free|domain)|courtesy of godaddy|sedoparking|parkingcrew|bodis\.com|above\.com\/marketplace|afternic\.com|dan\.com\/buy-domain|hugedomains\.com|undeveloped\.com|domainmarket\.com|parklogic|skenzo|trafficz|this web page is parked/i;
const SALE_HOSTS = /(?:^|\.)(?:forsale\.godaddy\.com|afternic\.com|sedo\.com|dan\.com|hugedomains\.com|undeveloped\.com|atom\.com|squadhelp\.com|brandbucket\.com|domainmarket\.com)$/i;
function savedForSale(host, title) {
  return SALE_HOSTS.test(host || "") || /\bfor sale\b|domain (?:is )?(?:available|for sale)/i.test(title || "");
}
function scanPage(page, savedHost) {
  if (!page) return null;
  const { html } = page;
  if (PARKED.test(html)) return { kind: "parked" };
  // A small page that immediately sends you elsewhere (meta refresh or a script)
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ").replace(/\s+/g, " ").trim();
  if (text.length < 400) {
    const m = html.match(/http-equiv=["']?refresh["']?[^>]*url=([^"'>\s]+)/i)
      || html.match(/(?:window\.|document\.)?location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*["'](https?:\/\/[^"']+)/i);
    const target = m && hostOfUrl(m[1]);
    if (target && registered(target) && registered(target) !== registered(savedHost)) return { kind: "strangeRedirect", host: target };
  }
  return null;
}

// Has the page changed completely since it was saved? Compares the page's title now with the
// title saved in the Pagemark. Only a total mismatch counts (no shared meaningful words), so
// ordinary redesigns ("Home | Acme" -> "Acme – Welcome") don't.
function pageTitle(html) {
  const m = (html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&(nbsp|ndash|mdash|rsquo|lsquo|rdquo|ldquo|hellip|eacute|egrave|aacute|oacute|uacute|iacute|ntilde|uuml|ouml|auml|ccedil);/g,
      (_, e) => ({ nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", eacute: "é", egrave: "è", aacute: "á",
        oacute: "ó", uacute: "ú", iacute: "í", ntilde: "ñ", uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç" })[e])
    .replace(/\s+/g, " ").trim().slice(0, 200);
}
const COMMON = new Set("the and for with from your you this that are was our out all its into about home page welcome official site website blog news www com org net html index main default untitled".split(" "));
function words(text, host) {
  const hostBits = new Set((host || "").toLowerCase().split(/[.\-]/));
  return new Set((text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !COMMON.has(w) && !hostBits.has(w)));
}
const NOT_FOUND = /\b404\b|not found|page (?:cannot|can't|could not) be found|doesn'?t exist|does not exist|no longer (?:available|exists)|page (?:is )?missing/i;
// Sign-in screens and bot checks: the page is hidden from the checker, not changed
const GATE = /just a moment|attention required|access denied|captcha|verify you are|security check|are you a robot|forbidden|unusual traffic|one more step|please wait|checking (?:your|the) (?:connection|browser)|pardon our interruption|\bsign[- ]?in\b|\blog[- ]?in\b|\bsign[- ]?on\b|need access|access (?:required|restricted)|(?:members|subscribers) only|request (?:rejected|blocked)|human verification|bot (?:check|protection)|ddos/i;
// Returns "notFound", "changed" or ""
function titleDrift(savedTitle, nowTitle, host) {
  if (!nowTitle || GATE.test(nowTitle)) return "";
  if (NOT_FOUND.test(nowTitle) && !NOT_FOUND.test(savedTitle || "")) return "notFound";
  const before = words(savedTitle, host), now = words(nowTitle, host);
  if (before.size < 2 || now.size < 1) return "";
  for (const w of before) {
    if (now.has(w)) return "";
    for (const v of now) if (w.length >= 5 && v.length >= 5 && (w.startsWith(v.slice(0, 5)) || v.startsWith(w.slice(0, 5)))) return "";
  }
  return "changed";
}

const WEEK = 7 * 24 * 3600 * 1000;
const millis = (t) => (t && typeof t.toMillis === "function") ? t.toMillis() : (typeof t === "number" ? t : 0);
const safetyTotals = { malware: 0, adult: 0, newOwner: 0, strangeRedirect: 0, parked: 0, changed: 0, notFound: 0 };

// Decides whether a Pagemark "may be unsafe" and why. Returns { risk, reg, scan } to save.
async function safetyCheck(data, url, result, prev) {
  const host = hostOfUrl(url);
  const domain = registered(host);
  const finalHost = result.finalUrl ? hostOfUrl(result.finalUrl) : "";
  const now = Date.now();
  const gone = result.status === "broken" && result.code === 0;   // the website doesn't exist at all

  // Weekly: registration date and a look at the page
  let reg = prev.reg || null;
  if (domain && !gone && (!reg || reg.domain !== domain || now - millis(reg.at) > WEEK)) {
    const when = await registeredOn(domain);
    reg = { domain, on: when, at: now };
  }
  let scan = prev.scan || null;
  if (!gone && result.status !== "broken" && (!scan || now - millis(scan.at) > WEEK)) {
    const page = await samplePage(url);
    const found = scanPage(page, host);
    scan = { kind: found?.kind || "", host: found?.host || "", title: page ? pageTitle(page.html) : "", at: now };
  }

  // From the weekly real-browser visit (see browser-check.mjs), if it's recent:
  // where the page really ends up once its scripts have run, and its title there
  const br = prev.browser && now - millis(prev.browser.at) < 9 * 24 * 3600 * 1000 ? prev.browser : null;
  const browserHost = br?.finalUrl ? hostOfUrl(br.finalUrl) : "";

  // Nightly: blocklists, for the website and wherever it now sends you
  const hosts = [...new Set([host, finalHost, scan?.host, browserHost].filter(Boolean))];
  let risk = null;
  for (const h of hosts) {
    if (await blocked(h, "security")) { risk = { kind: "malware", host: h }; break; }
  }
  if (!risk) for (const h of hosts) {
    if (await blocked(h, "family")) { risk = { kind: "adult", host: h }; break; }
  }
  // Registered again after you saved it: the website probably has a new owner
  const saved = millis(data.createdAt);
  if (!risk && reg?.on && saved && reg.on > saved + 2 * 24 * 3600 * 1000) risk = { kind: "newOwner", since: reg.on };
  // Sends you to an unrelated website with a throwaway-style ending (.site, .top, .xyz …)
  if (!risk && finalHost && registered(finalHost) !== domain && riskyEnding(finalHost)) risk = { kind: "strangeRedirect", host: finalHost };
  if (!risk && scan?.kind === "strangeRedirect") risk = { kind: "strangeRedirect", host: scan.host };
  if (!risk && browserHost && registered(browserHost) !== domain && riskyEnding(browserHost)) risk = { kind: "strangeRedirect", host: browserHost };
  // (Not when you saved a "for sale" page on purpose, e.g. a domain listing.)
  if (!risk && scan?.kind === "parked" && !savedForSale(host, data.title)) risk = { kind: "parked" };

  if (risk) safetyTotals[risk.kind]++;

  // Has the page changed completely, or does it now say "not found"? (Real-browser title first.)
  let drift = null;
  const nowTitle = (br?.title) || scan?.title || "";
  if (!gone && nowTitle) {
    const kind = titleDrift(data.title || "", nowTitle, host);
    if (kind) { drift = { kind, title: nowTitle }; safetyTotals[kind]++; }
  }
  return { risk, reg, scan, drift };
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
// Fair use: check up to 10,000 Pagemarks per person (the app doesn't let anyone save more)
const LIMIT = 10000;
const perUser = new Map();
const docs = snap.docs.filter((d) => {
  const owner = d.ref.parent.parent ? d.ref.parent.parent.id : "";
  const n = (perUser.get(owner) || 0) + 1;
  perUser.set(owner, n);
  return n <= LIMIT;
});
console.log(`Checking ${docs.length} Pagemarks…`);

const totals = { ok: 0, moved: 0, broken: 0, unknown: 0, skipped: 0 };
let index = 0;
let saved = 0;

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
    // Refused (403) or a server error, but a real browser opened it normally this week:
    // the site only turns away automated checks, so don't call it broken.
    const br = prev.browser;
    if (shown === "broken" && (result.code === 403 || result.code >= 500) && br?.title
        && Date.now() - millis(br.at) < 9 * 24 * 3600 * 1000 && !NOT_FOUND.test(br.title) && !GATE.test(br.title)) {
      shown = "unknown"; result.reason = "site blocks automated checks";
    }

    const safety = await safetyCheck(data, url, result, prev);
    // A page that answers "OK" but says "page not found" is broken too
    let reason = result.reason;
    if (safety.drift?.kind === "notFound" && (shown === "ok" || shown === "moved" || shown === "unknown")) {
      shown = "broken"; reason = "the page says it can't be found";
    }
    const link = {
      status: shown,
      code: result.code,
      finalUrl: result.finalUrl,
      reason,
      fails,
      checkedAt: FieldValue.serverTimestamp(),
      archiveUrl: prev.archiveUrl || "",
      risk: safety.risk,
      reg: safety.reg,
      scan: safety.scan,
      drift: safety.drift,
      browser: prev.browser || null
    };
    if ((shown === "broken" || safety.risk) && !link.archiveUrl) link.archiveUrl = await waybackCopy(url);

    // Save only when something changed (or once a week to refresh "last checked"), to keep database use low
    const lastChecked = prev.checkedAt && prev.checkedAt.toMillis ? prev.checkedAt.toMillis() : 0;
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = ["status", "code", "finalUrl", "reason", "fails", "archiveUrl"].some((k) => (prev[k] ?? "") !== (link[k] ?? ""))
      || !same(prev.risk, link.risk) || !same(prev.reg, link.reg) || !same(prev.scan, link.scan) || !same(prev.drift, link.drift);
    // "It works" (confirmed by a person) only stands while the checker can't tell.
    // Clear evidence that the page is gone or has moved cancels it.
    const cancelConfirm = !!data.confirmedWorking && (shown === "broken" || shown === "moved");
    const update = cancelConfirm ? { link, confirmedWorking: FieldValue.delete() } : { link };
    if (changed || cancelConfirm || Date.now() - lastChecked > 7 * 24 * 3600 * 1000) { await d.ref.update(update); saved++; }
    totals[shown]++;
  }
}

await Promise.all(Array.from({ length: PARALLEL }, worker));
console.log(`Saved ${saved} changes.`);
console.log(`Done. Working: ${totals.ok}, moved: ${totals.moved}, broken: ${totals.broken}, couldn't check: ${totals.unknown}, skipped: ${totals.skipped}`);
console.log(`May be unsafe: harmful-site list ${safetyTotals.malware}, family-safe list ${safetyTotals.adult}, new owner ${safetyTotals.newOwner}, sends elsewhere ${safetyTotals.strangeRedirect}, parked or for sale ${safetyTotals.parked}. Registry lookups: ${rdapCalls}.`);
console.log(`Looks very different: ${safetyTotals.changed}. Says "not found" (counted as broken): ${safetyTotals.notFound}.`);
process.exit(0);
