import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpPlacesClient, PlacesError } from "../src/places/client.js";

/** A stand-in for places.googleapis.com that records requests and answers as Google's spec describes. */
let server: Server;
let base: string;
const seen: { method: string; url: string; headers: Record<string, unknown>; body: unknown }[] = [];
let reply: () => { status: number; body: unknown } = () => ({ status: 500, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const { status, body } = reply();
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = () => new HttpPlacesClient("test-google-api-key-123456", base);
const raw = {
  id: "ChIJ123",
  displayName: { text: "Koko Beach Resort", languageCode: "en" },
  formattedAddress: "Lekki, Lagos",
  location: { latitude: 6.43, longitude: 3.42 },
  rating: 4.4,
  userRatingCount: 120,
  priceLevel: "PRICE_LEVEL_UNSPECIFIED",
  regularOpeningHours: { openNow: true, weekdayDescriptions: ["Monday: 10:00 AM – 10:00 PM"] },
  photos: [{ name: "places/ChIJ123/photos/AbC", widthPx: 1200, heightPx: 800, authorAttributions: [{ displayName: "Ada" }] }],
  businessStatus: "OPERATIONAL",
};

describe("HttpPlacesClient", () => {
  it("searches with the key and a field mask in headers, never in the URL", async () => {
    reply = () => ({ status: 200, body: { places: [raw] } });
    const results = await client().searchText({ query: "beach in Lekki" });
    const req = seen.at(-1)!;
    expect(req).toMatchObject({ method: "POST", url: "/v1/places:searchText", body: { textQuery: "beach in Lekki", pageSize: 10, regionCode: "NG", languageCode: "en" } });
    expect(req.headers["x-goog-api-key"]).toBe("test-google-api-key-123456");
    expect(req.headers["x-goog-fieldmask"]).toMatch(/^places\.id,places\.displayName,[^ ]+$/);
    expect(req.url).not.toContain("key=");
    expect(results[0]).toMatchObject({ id: "ChIJ123", name: "Koko Beach Resort", priceLevel: null, openNow: true, openingHours: ["Monday: 10:00 AM – 10:00 PM"] });
  });

  it("gets one place with an unprefixed field mask", async () => {
    reply = () => ({ status: 200, body: raw });
    await client().getPlace("ChIJ123");
    expect(seen.at(-1)!.url).toBe("/v1/places/ChIJ123?languageCode=en&regionCode=NG");
    expect(seen.at(-1)!.headers["x-goog-fieldmask"]).toMatch(/^id,displayName,/);
  });

  it("asks for a photo's key-free URL instead of the image itself", async () => {
    reply = () => ({ status: 200, body: { name: "places/ChIJ123/photos/AbC/media", photoUri: "https://lh3.googleusercontent.com/abc" } });
    expect(await client().photoUri("places/ChIJ123/photos/AbC", 400)).toBe("https://lh3.googleusercontent.com/abc");
    expect(seen.at(-1)!.url).toBe("/v1/places/ChIJ123/photos/AbC/media?maxWidthPx=400&skipHttpRedirect=true");
  });

  it("reports Google's error message", async () => {
    reply = () => ({ status: 400, body: { error: { code: 400, message: "Invalid place ID", status: "INVALID_ARGUMENT" } } });
    await expect(client().getPlace("bad")).rejects.toMatchObject({ message: "Invalid place ID", httpStatus: 400 });
    await expect(new HttpPlacesClient("k".repeat(30), "http://127.0.0.1:1").getPlace("x")).rejects.toBeInstanceOf(PlacesError);
  });
});
