// © 2026 The Sensible Studio. All rights reserved. Not licensed for copying, reuse or redistribution.
// Pagemarks content rules
// Checks a Pagemark at the moment it is saved (and during imports).
// Layers: a test address, a short list of blocked sites, a word filter, and
// Cloudflare's family-safe DNS (1.1.1.1 for Families), which flags adult and malware sites.
// Nothing here is perfect; clear rules and the owner's judgement back it up.
import { allowedSite } from "./allowed-sites.js?v=129";

// Always refused, so the check can be tested without visiting a bad site.
export const TEST_HOST = "blocked-test.pagemarks.com";

// Sites refused outright: graphic violence/gore, hate, and adult sites that DNS lists may miss.
const BLOCKED_DOMAINS = [
  // graphic violence / gore
  "bestgore.com", "bestgore.fun", "theync.com", "kaotic.com", "goregrish.com", "seegore.com",
  "gorecenter.com", "crazyshit.com", "documentingreality.com", "watchpeopledie.tv", "ogrish.com",
  // hate
  "stormfront.org",
  // adult
  "onlyfans.com", "fansly.com", "chaturbate.com", "pornhub.com", "xvideos.com", "xhamster.com",
  "xnxx.com", "redtube.com", "youporn.com", "spankbang.com", "eporner.com"
];

// Words that aren't allowed in titles, notes, tags, folder names or web addresses.
// Matched as whole words (so "Essex" or "Scunthorpe" are fine).
const BLOCKED_WORDS = [
  /\bp[o0]rn\w*/i, /\bxxx\b/i, /\bhentai\b/i, /\bnsfw\b/i, /\bnudes?\b/i, /\bcamgirls?\b/i,
  /\bfuck\w*/i, /\bmotherfuck\w*/i, /\bcunts?\b/i, /\btwats?\b/i, /\bwhores?\b/i, /\bsluts?\b/i,
  /\bnigg(er|ers|a|as|az)\b/i, /\bfaggots?\b/i, /\bkikes?\b/i, /\btrann(y|ies)\b/i,
  /\bbeheading\s+video/i, /\bgore\s+videos?\b/i
];

export const REFUSAL_MESSAGE = "Pagemarks doesn't allow adult, violent, hateful or harmful content. Nothing was saved, and you can keep using Pagemarks as usual.";

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const onList = (host) => BLOCKED_DOMAINS.some((d) => host === d || host.endsWith("." + d));

// Words only: for folder names and tags
export function textAllowed(...texts) {
  const s = texts.flat().filter(Boolean).join(" \n ");
  return !BLOCKED_WORDS.some((re) => re.test(s));
}

// Quick checks that need no network: test address, blocked sites, words
export function quickCheck({ url = "", title = "", description = "", notes = "", tags = [], folder = "" }) {
  const host = hostOf(url);
  if (host === TEST_HOST || host.endsWith("." + TEST_HOST)) return { ok: false, why: "test" };
  if (onList(host)) return { ok: false, why: "site" };
  let path = "";
  try { const u = new URL(url); path = decodeURIComponent(u.pathname + " " + u.search).replace(/[-_/.+=&?%]+/g, " "); } catch { /* ignore */ }
  if (!textAllowed(title, description, notes, tags, folder, host.replace(/[.-]/g, " "), path)) return { ok: false, why: "words" };
  return { ok: true };
}

// Cloudflare 1.1.1.1 for Families: answers 0.0.0.0 for adult and malware sites.
// Only the site name (e.g. example.com) is sent, never the full address.
const dnsCache = new Map();
export async function familyDnsAllows(host) {
  if (!host || allowedSite(host)) return true;
  if (dnsCache.has(host)) return dnsCache.get(host);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  let allowed = true;
  try {
    const r = await fetch(`https://family.cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
      { headers: { accept: "application/dns-json" }, signal: ctrl.signal, cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      allowed = !(j.Answer || []).some((a) => a.type === 1 && a.data === "0.0.0.0");
    }
  } catch { /* offline or unreachable: don't block on a failed lookup */ }
  finally { clearTimeout(timer); }
  dnsCache.set(host, allowed);
  return allowed;
}

// Full check for one Pagemark
export async function checkPagemark(p) {
  const quick = quickCheck(p);
  if (!quick.ok) return quick;
  if (!(await familyDnsAllows(hostOf(p.url)))) return { ok: false, why: "dns" };
  return { ok: true };
}
