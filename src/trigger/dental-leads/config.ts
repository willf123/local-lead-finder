// Settings for the dental leads automation. Edit these to change what gets searched / created.

/** Google Places text searches. Each returns up to 60 practices; results are de-duplicated. */
export const SEARCH_QUERIES = [
  "dentist in Tampa, FL",
  "family dentist in Tampa, FL",
  "cosmetic dentist in Tampa, FL",
  "pediatric dentist in Tampa, FL",
  "dental office in South Tampa, FL",
  "dentist in Westchase, Tampa, FL",
  "dentist in Carrollwood, Tampa, FL",
  "dentist in New Tampa, FL",
  "dentist in Seminole Heights, Tampa, FL",
  "dentist in Town 'n' Country, Tampa, FL",
  "dentist in Brandon, FL",
];

/** Max ClickUp tasks created per weekly run (Hot leads first). The rest wait for next Monday. */
export const MAX_NEW_LEADS_PER_RUN = 30;

/** A site with at least this many problems counts as a "Warm" lead. */
export const WARM_MIN_ISSUES = 2;

/** Copyright year this many years old (or older) counts as outdated. */
export const OUTDATED_COPYRIGHT_YEARS = 3;

/** PageSpeed mobile performance score (0–100) below this counts as slow. */
export const SLOW_PAGESPEED_SCORE = 50;

/** Chains / corporate groups we can't sell a website to. Matched case-insensitively against the name. */
export const CHAIN_PATTERNS: RegExp[] = [
  /aspen dental/i,
  /coast dental/i,
  /bright now/i,
  /western dental/i,
  /castle dental/i,
  /monarch dental/i,
  /gentle dental/i,
  /ideal dental/i,
  /sage dental/i,
  /clearchoice/i,
  /affordable dentures/i,
  /great expressions/i,
  /comfort dental/i,
  /smile brands/i,
  /dental care alliance/i,
  /perfect teeth/i,
];

/** "Websites" that are really just social/profile pages → Hot lead. */
export const NOT_A_REAL_WEBSITE_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "business.site",
  "yelp.com",
  "sites.google.com",
  "healthgrades.com",
  "zocdoc.com",
];
