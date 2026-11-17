import { logger, task } from "@trigger.dev/sdk";
import { Agent, fetch as websiteFetch } from "undici";
import {
  NOT_A_REAL_WEBSITE_HOSTS,
  OUTDATED_COPYRIGHT_YEARS,
  SLOW_PAGESPEED_SCORE,
  WARM_MIN_ISSUES,
} from "./config.js";
import type { Practice, QualifiedLead } from "./types.js";

// Website checks use undici directly so we can raise the header size limit — some dental sites send
// large cookies/security headers that Node's built-in fetch rejects (UND_ERR_HEADERS_OVERFLOW).
const websiteAgent = new Agent({ maxHeaderSize: 256 * 1024 });

/** Certificate errors that make browsers show a "Not secure / Your connection is not private" page. */
const BAD_CERT_CODES = [
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
];

/** Best-effort error code from a fetch failure (undici wraps the real error in `cause`). */
function errorCode(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  return e?.cause?.code ?? e?.code ?? e?.cause?.name ?? e?.name ?? "UNKNOWN";
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/**
 * Checks one dental practice's website and rates it:
 *  - hot:  no website, broken website, or only a Facebook/Linktree-style page
 *  - warm: real website with 2+ problems (no HTTPS, not mobile-friendly, old copyright, slow)
 *  - good: website looks fine → not worth pitching
 */
export const qualifyLead = task({
  id: "dental-qualify-lead",
  queue: { concurrencyLimit: 20 },
  maxDuration: 180,
  retry: { maxAttempts: 2 },
  run: async (practice: Practice): Promise<QualifiedLead> => {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

    const lead = (tier: QualifiedLead["tier"], issues: string[], pageSpeedScore: number | null = null) => {
      logger.log(`${practice.name}: ${tier.toUpperCase()}`, { issues, pageSpeedScore });
      return { ...practice, tier, issues, pageSpeedScore };
    };

    // 1. No website at all
    if (!practice.website) return lead("hot", ["No website listed on Google"]);

    let url: URL;
    try {
      url = new URL(practice.website);
    } catch {
      return lead("hot", [`Google lists an invalid website: ${practice.website}`]);
    }

    // 2. "Website" is really a social/profile page
    const host = url.hostname.replace(/^www\./, "");
    const fakeHost = NOT_A_REAL_WEBSITE_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
    if (fakeHost) return lead("hot", [`No real website — Google links to ${fakeHost}`]);

    // 3. Load the homepage
    const issues: string[] = [];
    let html = "";
    let finalUrl = url.toString();
    let blocked = false; // true = site exists but we couldn't read its HTML
    try {
      const res = await websiteFetch(url, {
        redirect: "follow",
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
        signal: AbortSignal.timeout(20_000),
        dispatcher: websiteAgent,
      });
      finalUrl = res.url || finalUrl;
      if ([401, 403, 429, 503].includes(res.status)) {
        // Usually bot protection (e.g. Cloudflare) — the site works for humans, we just can't read it.
        blocked = true;
        logger.warn(`${practice.name}: homepage returned ${res.status}, skipping HTML checks`);
      } else if (!res.ok) {
        return lead("hot", [`Website is broken (HTTP ${res.status})`]);
      } else {
        html = await res.text();
      }
    } catch (err) {
      const code = errorCode(err);
      if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) {
        return lead("hot", [`Website is down (${code === "ECONNREFUSED" ? "server refuses connections" : "domain doesn't resolve"})`]);
      }
      if (BAD_CERT_CODES.includes(code)) {
        return lead("hot", ["Broken SSL certificate — browsers show a security warning"]);
      }
      if (code === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") {
        issues.push("Very slow to load (>20s)");
      }
      // Anything else (odd server behaviour, etc.) — the site probably works for humans; don't call it broken.
      blocked = true;
      logger.warn(`${practice.name}: couldn't read homepage (${code}), skipping HTML checks`);
    }

    // 4. Score the real website

    if (!finalUrl.startsWith("https://")) issues.push("No HTTPS (browser shows 'Not secure')");

    if (!blocked) {
      if (!/<meta[^>]+name=["']?viewport/i.test(html)) issues.push("Not mobile-friendly (no viewport tag)");

      const years = [...html.matchAll(/(?:©|&copy;|&#169;|copyright)\s*(?:\d{4}\s*(?:-|–|&ndash;)\s*)?((?:19|20)\d{2})/gi)]
        .map((m) => Number(m[1]));
      if (years.length) {
        const latest = Math.max(...years);
        if (latest <= new Date().getFullYear() - OUTDATED_COPYRIGHT_YEARS) issues.push(`Outdated (© ${latest})`);
      }
    }

    const pageSpeedScore = await getPageSpeedScore(finalUrl, apiKey, practice.name);
    if (pageSpeedScore !== null && pageSpeedScore < SLOW_PAGESPEED_SCORE) {
      issues.push(`Slow on mobile (PageSpeed ${pageSpeedScore}/100)`);
    }

    return lead(issues.length >= WARM_MIN_ISSUES ? "warm" : "good", issues, pageSpeedScore);
  },
});

/** Google PageSpeed Insights mobile performance score (0–100), or null if it couldn't be measured. */
async function getPageSpeedScore(siteUrl: string, apiKey: string, name: string): Promise<number | null> {
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", siteUrl);
  endpoint.searchParams.set("strategy", "mobile");
  endpoint.searchParams.set("category", "performance");
  endpoint.searchParams.set("key", apiKey);
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) {
      logger.warn(`${name}: PageSpeed failed (HTTP ${res.status})`, { body: (await res.text()).slice(0, 300) });
      return null;
    }
    const data = (await res.json()) as { lighthouseResult?: { categories?: { performance?: { score?: number | null } } } };
    const score = data.lighthouseResult?.categories?.performance?.score;
    return typeof score === "number" ? Math.round(score * 100) : null;
  } catch (err) {
    logger.warn(`${name}: PageSpeed error`, { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
