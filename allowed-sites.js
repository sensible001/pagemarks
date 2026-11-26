// © 2026 The Sensible Studio. All rights reserved. Not licensed for copying, reuse or redistribution.
// Sites the family-safe list blocks by mistake. These skip only that list: the harmful-site
// (malware and phishing) check and the word rules still apply to them.
// Add a site's name without "www." (e.g. "example.com"); its subdomains are covered too.
export const ALLOWED_SITES = [
  "cwhemp.com"            // Charlotte's Web: therapeutic CBD oil
];

// Sites the owner approves in Settings are kept in Firestore (config/allowedSites) and added here.
let extra = [];
export function setExtraAllowed(list) {
  extra = (Array.isArray(list) ? list : []).map((s) => String(s).toLowerCase().replace(/^www\./, "")).filter(Boolean);
}

export function allowedSite(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  return [...ALLOWED_SITES, ...extra].some((s) => h === s || h.endsWith("." + s));
}
