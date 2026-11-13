import { PlacesError, type Place, type PlacesClient } from "../src/places/client.js";

/** Stands in for Google Places in tests. */
export class FakePlaces implements PlacesClient {
  readonly places = new Map<string, Place>();
  /** When true, every call fails as if Google were unreachable. */
  down = false;
  searches: string[] = [];
  /** Every place looked up by ID: each is a billed Google call. */
  lookups: string[] = [];
  /** Places Google fails to return, as if briefly unavailable. */
  failing = new Set<string>();

  add(p: Partial<Place> & { id: string; name: string }): Place {
    const place: Place = {
      address: `${p.name}, Lagos`,
      location: { latitude: 6.43, longitude: 3.42 },
      rating: 4.4,
      ratingCount: 120,
      priceLevel: "PRICE_LEVEL_MODERATE",
      openNow: true,
      openingHours: ["Monday: 10:00 AM – 10:00 PM"],
      photos: [{ name: `places/${p.id}/photos/ph1`, widthPx: 1200, heightPx: 800, authorAttributions: [{ displayName: "A Photographer" }] }],
      googleMapsUri: `https://maps.google.com/?cid=${p.id}`,
      websiteUri: null,
      phone: null,
      primaryType: "restaurant",
      businessStatus: "OPERATIONAL",
      ...p,
    };
    this.places.set(p.id, place);
    return place;
  }

  async searchText({ query }: { query: string }): Promise<Place[]> {
    if (this.down) throw new PlacesError("Google Places unreachable", null);
    this.searches.push(query);
    const words = query.toLowerCase().split(/\s+/);
    return [...this.places.values()].filter((p) => words.some((w) => p.name.toLowerCase().includes(w)));
  }

  async getPlace(placeId: string): Promise<Place> {
    if (this.down) throw new PlacesError("Google Places unreachable", null);
    this.lookups.push(placeId);
    if (this.failing.has(placeId)) throw new PlacesError("Google Places unreachable", null);
    const p = this.places.get(placeId);
    if (!p) throw new PlacesError("Not found", 404);
    return p;
  }

  async photoUri(name: string): Promise<string> {
    if (this.down) throw new PlacesError("Google Places unreachable", null);
    return `https://lh3.googleusercontent.com/places/fake/${encodeURIComponent(name)}`;
  }
}
