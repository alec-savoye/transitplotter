import { buildActiveLegs } from "../../server/src/state";
import { typicalSeconds } from "../../server/src/routing/graph.js";

describe("buildActiveLegs", () => {
  const mockGraph = { typicalSeconds: jest.fn().mockReturnValue(120) } as any;

  const mockStaticData = {
    routes: new Map([
      ["1", { id: "1", color: "#D82233", name: "1" }],
      ["6", { id: "6", color: "#FFCC00", name: "6" }],
      ["W", { id: "W", color: "#883311", name: "W" }],
    ]),
    stops: new Map([
      ["127", { id: "127", name: "Times Sq", lat: 40.7559, lon: -73.987 }],
      ["128", { id: "128", name: "42 St", lat: 40.757, lon: -73.989 }],
      ["8096", { id: "8096", name: "Columbus Circle", lat: 40.784, lon: -73.977 }],
      ["8097", { id: "8097", name: "5 Av/59 St", lat: 40.767, lon: -73.978 }],
      ["125", { id: "125", name: "Inwood", lat: 40.865, lon: -73.917 }],
      ["126", { id: "126", name: "191 St", lat: 40.855, lon: -73.905 }],
    ]),
    shapes: new Map(),
    lines: mockLines,
    lineByRouteDir: new Map([
      ["1|S", { key: "1|S", shape: {} as any, stopDist: new Map(), order: ["127", "128"] }],
      ["6|S", { key: "6|S", shape: {} as any, stopDist: new Map(), order: ["8096", "8097", "8098"] }],
      ["N|S", { key: "N|S", shape: {} as any, stopDist: new Map(), order: ["125", "126"] }],
    ]),
    trips: new Map(),
    tripStops: new Map(),
    shapesByRouteDir: new Map(),
    routeAgency: new Map(),
  };

  const mockLines = new Map([
    ["1|S", { routeId: "1", dir: "S", shapeId: "1..S01", order: ["127", "128"], stopDist: { "127": 0, "128": 1000 } }],
    ["6|S", { routeId: "6", dir: "S", shapeId: "6..S01", order: ["8096", "8097", "8098"], stopDist: { "8096": 0, "8097": 1500, "8098": 3000 } }],
    ["N|S", { routeId: "N", dir: "S", shapeId: "N.S01", order: ["125", "126"], stopDist: { "125": 0, "126": 1200 } }],
  ]);

  describe("route normalization", () => {
    it("normalizes express suffixes (6X -> 6)", () => {
      const feed: Array<{ tripId: string; routeId: string; stopUpdates: Array<{ stopId: string; arrival: number; departure: number }>; headerTs: number }> = [{ tripId: "TRIP001", routeId: "6X", stopUpdates: [{ stopId: "8096", arrival: 1700000100, departure: 0 }], headerTs: 1700000000 }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph);
      expect(legs[0].routeId).toBe("6");
    });

    it("applies W -> N alias", () => {
      const feed: Array<{ tripId: string; routeId: string; stopUpdates: Array<{ stopId: string; arrival: number; departure: number }>; headerTs: number }> = [{ tripId: "TRIP002", routeId: "W", stopUpdates: [{ stopId: "125", arrival: 0, departure: 1700000100 }], headerTs: 1700000000 }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph);
      expect(legs[0].routeId).toBe("N");
    });
  });

  describe("direction handling", () => {
    it("extracts N suffix from stopId", () => {
      const feed: Array<{ tripId: string; routeId: string; stopUpdates: Array<{ stopId: string; arrival: number; departure: number }>; headerTs: number }> = [{ tripId: "TRIP003", routeId: "1", stopUpdates: [{ stopId: "127N", arrival: 1700000100, departure: 0 }], headerTs: 1700000000 }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph);
      expect(legs[0].routeId).toBe("1");
    });
  });

  describe("implicit origin handling", () => {
    it("derives stable departure time", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const feed: Array<{ tripId: string; routeId: string; stopUpdates: Array<{ stopId: string; arrival: number; departure: number }>; headerTs: number }> = [{ tripId: "TRIP004", routeId: "6", stopUpdates: [{ stopId: "8096", arrival: nowSec + 120, departure: 0 }], headerTs: nowSec }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph);
      expect(legs[0].departTs).toBeLessThan(nowSec);
    });
  });

  describe("segment matching", () => {
    it("selects next stop as first future stop", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const feed: Array<{ tripId: string; routeId: string; stopUpdates: Array<{ stopId: string; arrival: number; departure: number }>; headerTs: number }> = [{ tripId: "TRIP005", routeId: "6", stopUpdates: [
        { stopId: "8096", arrival: 0, departure: nowSec },
        { stopId: "8097", arrival: nowSec + 120, departure: 0 },
      ], headerTs: nowSec }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph);
      expect(legs[0].toStopId).toBe("8097");
    });
  });
});
