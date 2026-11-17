/** A dental practice as returned from Google Places (trimmed to what we use). */
export type Practice = {
  placeId: string;
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  mapsUrl: string | null;
};

export type LeadTier = "hot" | "warm" | "good";

/** Result of checking one practice's website. */
export type QualifiedLead = Practice & {
  tier: LeadTier;
  issues: string[];
  pageSpeedScore: number | null;
};
