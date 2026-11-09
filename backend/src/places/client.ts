/**
 * Google Places API (New). Field names follow Google's published API
 * definition (googleapis/google/maps/places/v1/place.proto) and docs.
 * Only what the screens need is requested: the field mask sets the price.
 */
export type PriceLevel = "PRICE_LEVEL_FREE" | "PRICE_LEVEL_INEXPENSIVE" | "PRICE_LEVEL_MODERATE" | "PRICE_LEVEL_EXPENSIVE" | "PRICE_LEVEL_VERY_EXPENSIVE";

export interface PlacePhoto {
  /** Resource name, e.g. places/ID/photos/REF. Can't be stored, and expires. */
  name: string;
  widthPx: number;
  heightPx: number;
  /** Must be shown wherever the photo is (Google's terms). */
  authorAttributions: { displayName: string; uri?: string }[];
}

export interface Place {
  id: string;
  name: string;
  address: string | null;
  location: { latitude: number; longitude: number } | null;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: PriceLevel | null;
  openNow: boolean | null;
  openingHours: string[];
  photos: PlacePhoto[];
  googleMapsUri: string | null;
  websiteUri: string | null;
  phone: string | null;
  primaryType: string | null;
  businessStatus: "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY" | null;
}

export interface PlacesClient {
  searchText(input: { query: string; pageSize?: number }): Promise<Place[]>;
  getPlace(placeId: string): Promise<Place>;
  /** A key-free image URL for a photo, so the browser never sees the API key. */
  photoUri(photoName: string, maxWidthPx: number): Promise<string>;
}

export class PlacesError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "PlacesError";
  }
}

const FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "rating",
  "userRatingCount",
  "priceLevel",
  "regularOpeningHours",
  "photos",
  "googleMapsUri",
  "websiteUri",
  "nationalPhoneNumber",
  "primaryType",
  "businessStatus",
];

interface RawPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  regularOpeningHours?: { openNow?: boolean; weekdayDescriptions?: string[] };
  photos?: { name: string; widthPx: number; heightPx: number; authorAttributions?: { displayName: string; uri?: string }[] }[];
  googleMapsUri?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  primaryType?: string;
  businessStatus?: string;
}

export const toPlace = (p: RawPlace): Place => ({
  id: p.id,
  name: p.displayName?.text ?? "Unnamed place",
  address: p.formattedAddress ?? null,
  location: p.location ?? null,
  rating: p.rating ?? null,
  ratingCount: p.userRatingCount ?? null,
  priceLevel: p.priceLevel && p.priceLevel !== "PRICE_LEVEL_UNSPECIFIED" ? (p.priceLevel as PriceLevel) : null,
  openNow: p.regularOpeningHours?.openNow ?? null,
  openingHours: p.regularOpeningHours?.weekdayDescriptions ?? [],
  photos: (p.photos ?? []).slice(0, 5).map((ph) => ({ name: ph.name, widthPx: ph.widthPx, heightPx: ph.heightPx, authorAttributions: ph.authorAttributions ?? [] })),
  googleMapsUri: p.googleMapsUri ?? null,
  websiteUri: p.websiteUri ?? null,
  phone: p.nationalPhoneNumber ?? null,
  primaryType: p.primaryType ?? null,
  businessStatus: (p.businessStatus as Place["businessStatus"]) ?? null,
});

const TIMEOUT_MS = 10_000;

export class HttpPlacesClient implements PlacesClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://places.googleapis.com",
  ) {}

  private async call<T>(url: string, init: RequestInit & { fieldMask?: string } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
          ...(init.fieldMask && { "x-goog-fieldmask": init.fieldMask }),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PlacesError(`Google Places unreachable: ${(err as Error).message}`, null);
    }
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!res.ok || !json) throw new PlacesError(json?.error?.message ?? `Google Places returned ${res.status}`, res.status);
    return json;
  }

  async searchText({ query, pageSize = 10 }: { query: string; pageSize?: number }): Promise<Place[]> {
    const data = await this.call<{ places?: RawPlace[] }>(new URL("/v1/places:searchText", this.baseUrl).toString(), {
      method: "POST",
      fieldMask: FIELDS.map((f) => `places.${f}`).join(","),
      // Nigerian results first; the query carries the area ("beach in Lekki").
      body: JSON.stringify({ textQuery: query, pageSize, regionCode: "NG", languageCode: "en" }),
    });
    return (data.places ?? []).map(toPlace);
  }

  async getPlace(placeId: string): Promise<Place> {
    const raw = await this.call<RawPlace>(new URL(`/v1/places/${encodeURIComponent(placeId)}?languageCode=en&regionCode=NG`, this.baseUrl).toString(), {
      fieldMask: FIELDS.join(","),
    });
    return toPlace(raw);
  }

  async photoUri(photoName: string, maxWidthPx: number): Promise<string> {
    const url = new URL(`/v1/${photoName}/media`, this.baseUrl);
    url.searchParams.set("maxWidthPx", String(maxWidthPx));
    url.searchParams.set("skipHttpRedirect", "true");
    const data = await this.call<{ photoUri?: string }>(url.toString());
    if (!data.photoUri) throw new PlacesError("Google returned no photo", 502);
    return data.photoUri;
  }
}
