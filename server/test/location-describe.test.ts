/**
 * Describing a fix without any third-party service (Phase 4): by the haversine distance from the
 * family's places, in words ("At School, within 40 m", "1.2 km from Home"), and a link to the
 * map site the family picked, which only the parent's browser follows. Made-up places only.
 */
import { describe, expect, it } from "vitest";
import { describeFix, distanceMeters, distanceWords, mapLink, placeOf, round5, type PlaceRef } from "../src/family/location/describe.js";
import { north, SPOT } from "./helpers.js";

const place = (id: string, name: string, at: { lat: number; lng: number }, radiusM: number): PlaceRef => ({ id, name, ...at, radiusM });
const school = place("p-school", "School", SPOT, 150);
const home = place("p-home", "Home", north(SPOT, 1200), 100);

describe("distances", () => {
  it("the haversine distance, in meters", () => {
    expect(distanceMeters(SPOT, SPOT)).toBe(0);
    expect(distanceMeters(SPOT, north(SPOT, 1000))).toBeCloseTo(1000, 0);
    // A degree of longitude at the equator, and half the world.
    expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111_195, -1);
    expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })).toBeCloseTo(20_015_115, -2);
    // Across the date line, the short way round.
    expect(distanceMeters({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 })).toBeCloseTo(111_195, -1);
  });

  it("in words: to the nearest 10 m under a kilometer, then kilometers", () => {
    expect([0, 4, 44, 46, 350, 994, 995, 1234, 9949, 9950, 45_300].map(distanceWords)).toEqual([
      "10 m",
      "10 m",
      "40 m",
      "50 m",
      "350 m",
      "990 m",
      "1.0 km",
      "1.2 km",
      "9.9 km",
      "10 km",
      "45 km",
    ]);
  });

  it("coordinates are kept to 5 decimal places", () => {
    expect(round5(40.123456789)).toBe(40.12346);
    expect(round5(-72.987654321)).toBe(-72.98765);
  });
});

describe("a fix, by the family's places", () => {
  it("inside a place: at it, with how accurate the fix is", () => {
    expect(describeFix({ ...north(SPOT, 40), accuracyM: 38 }, [school, home])).toMatchObject({ where: { relation: "at", place: { id: "p-school" } }, words: "At School, within 40 m" });
  });

  it("outside every place: how far from the nearest one's center", () => {
    const fix = { ...north(SPOT, 2400), accuracyM: 25 };
    expect(describeFix(fix, [school, home])).toMatchObject({ where: { relation: "from", place: { id: "p-home" } }, words: "1.2 km from Home" });
    expect(describeFix({ ...north(SPOT, 500), accuracyM: 25 }, [school])).toMatchObject({ words: "500 m from School" });
  });

  it("in two places at once: the one whose center is nearest; with no places, nothing to say", () => {
    const town = place("p-town", "Town", north(SPOT, 300), 1000);
    expect(placeOf(north(SPOT, 100), [town, school])).toMatchObject({ relation: "at", place: { id: "p-school" } });
    expect(placeOf(north(SPOT, 900), [town, school])).toMatchObject({ relation: "at", place: { id: "p-town" } });
    expect(describeFix({ ...SPOT, accuracyM: 10 }, [])).toEqual({ where: { relation: "none" }, words: null });
  });

  it("on the edge counts as inside", () => {
    expect(placeOf(north(SPOT, 149.9), [school]).relation).toBe("at");
    expect(placeOf(north(SPOT, 150.5), [school]).relation).toBe("from");
  });
});

describe("Open in a map", () => {
  it("is a plain link to the family's map site, with the coordinates to 5 places", () => {
    expect(mapLink("openstreetmap", 40.1, -73.2)).toBe("https://www.openstreetmap.org/?mlat=40.10000&mlon=-73.20000#map=17/40.10000/-73.20000");
    expect(mapLink("google", 40.1, -73.2)).toBe("https://www.google.com/maps/search/?api=1&query=40.10000,-73.20000");
  });
});
