import { logger, schedules, wait } from "@trigger.dev/sdk";
import { CHAIN_PATTERNS, MAX_NEW_LEADS_PER_RUN, SEARCH_QUERIES } from "./config.js";
import { qualifyLead } from "./qualify-lead.js";
import type { Practice, QualifiedLead } from "./types.js";

/**
 * Every Monday 8am Eastern: find Tampa dental practices on Google Places, skip chains and ones
 * already in ClickUp, check each website, and create ClickUp tasks for the best website leads.
 */
export const findDentalLeads = schedules.task({
  id: "dental-find-leads",
  cron: { pattern: "0 8 * * 1", timezone: "America/New_York" },
  maxDuration: 900,
  run: async () => {
    const googleKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!googleKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");
    const clickupToken = process.env.CLICKUP_API_TOKEN;
    if (!clickupToken) throw new Error("CLICKUP_API_TOKEN is not set");
    const listId = process.env.CLICKUP_LIST_ID;
    if (!listId) throw new Error("CLICKUP_LIST_ID is not set");

    // 1. Search Google Places
    const found = new Map<string, Practice>();
    for (const query of SEARCH_QUERIES) {
      const results = await searchPlaces(query, googleKey);
      for (const p of results) found.set(p.placeId, p);
      logger.log(`"${query}": ${results.length} results (${found.size} unique so far)`);
    }

    // 2. Filter out chains and practices already in ClickUp
    const alreadyInClickUp = await getExistingPlaceIds(listId, clickupToken);
    const chains: string[] = [];
    const candidates = [...found.values()].filter((p) => {
      if (alreadyInClickUp.has(p.placeId)) return false;
      if (CHAIN_PATTERNS.some((re) => re.test(p.name))) {
        chains.push(p.name);
        return false;
      }
      return true;
    });
    logger.log(`Found ${found.size} practices; ${alreadyInClickUp.size} already in ClickUp; ${chains.length} chains skipped; ${candidates.length} to check`, { chains });

    if (candidates.length === 0) {
      logger.log("0 new leads this week");
      return { practicesFound: found.size, checked: 0, created: 0 };
    }

    // 3. Check every website (runs in parallel as child runs, 20 at a time).
    // With ~300 checks, the last ones can sit in the queue for >10 min — the dev server's default
    // time-to-live — so give each child a longer TTL or they expire unchecked.
    const results = await qualifyLead.batchTriggerAndWait(
      candidates.map((p) => ({ payload: p, options: { ttl: "1h" } })),
    );
    const qualified: QualifiedLead[] = [];
    let failedChecks = 0;
    for (const r of results.runs) {
      if (r.ok) qualified.push(r.output);
      else failedChecks++;
    }

    // 4. Rank: Hot first, then Warm with the most problems / slowest sites
    const leads = qualified
      .filter((l) => l.tier !== "good")
      .sort(
        (a, b) =>
          Number(b.tier === "hot") - Number(a.tier === "hot") ||
          b.issues.length - a.issues.length ||
          (a.pageSpeedScore ?? 100) - (b.pageSpeedScore ?? 100) ||
          (a.reviewCount ?? 0) - (b.reviewCount ?? 0),
      );
    const toCreate = leads.slice(0, MAX_NEW_LEADS_PER_RUN);

    // 5. Create ClickUp tasks
    let created = 0;
    for (const lead of toCreate) {
      await createClickUpTask(lead, listId, clickupToken);
      created++;
      await wait.for({ seconds: 1 }); // stay well under ClickUp's rate limit
    }

    const summary = {
      practicesFound: found.size,
      checked: candidates.length,
      failedChecks,
      hot: leads.filter((l) => l.tier === "hot").length,
      warm: leads.filter((l) => l.tier === "warm").length,
      goodSitesSkipped: qualified.length - leads.length,
      created,
      waitingForNextWeek: leads.length - created,
    };
    logger.log(`Created ${created} new ClickUp lead tasks`, summary);
    return summary;
  },
});

// ─── Google Places ──────────────────────────────────────────────────────────

type PlacesResponse = {
  places?: Array<{
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    nationalPhoneNumber?: string;
    websiteUri?: string;
    rating?: number;
    userRatingCount?: number;
    businessStatus?: string;
    googleMapsUri?: string;
  }>;
  nextPageToken?: string;
};

const PLACES_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.googleMapsUri",
  "nextPageToken",
].join(",");

/** One Places text search, following up to 3 pages (60 results max). */
async function searchPlaces(query: string, apiKey: string): Promise<Practice[]> {
  const practices: Practice[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 3; page++) {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": PLACES_FIELDS,
      },
      body: JSON.stringify({
        textQuery: query,
        includedType: "dentist",
        strictTypeFiltering: true,
        pageSize: 20,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Google Places search failed (HTTP ${res.status}): ${(await res.text()).slice(0, 500)}`);
    }
    const data = (await res.json()) as PlacesResponse;

    for (const p of data.places ?? []) {
      if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
      if (p.formattedAddress && !/\bFL\b/.test(p.formattedAddress)) continue;
      practices.push({
        placeId: p.id,
        name: p.displayName?.text ?? "Unknown practice",
        address: p.formattedAddress ?? "",
        phone: p.nationalPhoneNumber ?? null,
        website: p.websiteUri ?? null,
        rating: p.rating ?? null,
        reviewCount: p.userRatingCount ?? null,
        mapsUrl: p.googleMapsUri ?? null,
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return practices;
}

// ─── ClickUp ────────────────────────────────────────────────────────────────

const PLACE_ID_LABEL = "Google Place ID:";

/** Google Place IDs of every lead already in the ClickUp list (open, closed, and archived). */
async function getExistingPlaceIds(listId: string, token: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const archived of [false, true]) {
    for (let page = 0; page < 100; page++) {
      const url = `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&subtasks=true&archived=${archived}&page=${page}`;
      const res = await fetch(url, { headers: { Authorization: token } });
      if (!res.ok) {
        throw new Error(`ClickUp: couldn't read list ${listId} (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as { tasks: Array<{ description?: string | null }>; last_page?: boolean };
      for (const t of data.tasks) {
        const match = t.description?.match(new RegExp(`${PLACE_ID_LABEL}\\s*(\\S+)`));
        if (match) ids.add(match[1]);
      }
      if (data.last_page !== false || data.tasks.length === 0) break;
    }
  }
  return ids;
}

async function createClickUpTask(lead: QualifiedLead, listId: string, token: string) {
  const label = lead.tier === "hot" ? "🔥 Hot" : "🟡 Warm";
  const description = [
    `${label} website lead`,
    "",
    "WHY PITCH THEM",
    ...lead.issues.map((i) => `• ${i}`),
    "",
    "CONTACT",
    `Phone: ${lead.phone ?? "not listed"}`,
    `Address: ${lead.address}`,
    `Website: ${lead.website ?? "none"}`,
    `Google rating: ${lead.rating ?? "n/a"} (${lead.reviewCount ?? 0} reviews)`,
    `Google Maps: ${lead.mapsUrl ?? "n/a"}`,
    "",
    `${PLACE_ID_LABEL} ${lead.placeId}`,
  ].join("\n");

  const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `${lead.name} — ${label}`,
      description,
      priority: lead.tier === "hot" ? 1 : 3, // 1 = Urgent, 3 = Normal
      // Always a plain "Task". If the list defaults to a custom task type (e.g. "Lead"),
      // ClickUp's Free plan caps how many of those can be created and the request fails.
      custom_item_id: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`ClickUp: failed to create task for ${lead.name} (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}
