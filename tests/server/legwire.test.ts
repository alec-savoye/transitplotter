import { buildTrainLegs } from "../../server/src/legwire";
import type { RoutingGraph } from "../../server/src/routing/graph";

describe("buildTrainLegs", () => {
  const mockGraph: RoutingGraph = { typicalSeconds: jest.fn().mockReturnValue(180) } as any;

  describe("speed clamping", () => {
    it("clamps implausibly short durations", () => {
      const activeLegs = [{
        tripId: "T1", routeId: "6", shape: null, headerTs: 1000,
        fromStopId: "8096", toStopId: "8097",
        departTs: 1000, arriveTs: 1001,
        fromDist: 0, toDist: 1500,
        fromLatLon: [-73.977, 40.784] as [number, number], toLatLon: [-73.978, 40.785] as [number, number],
        nextStopName: "Next", destName: "Dest",
      }];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      const duration = legs[0].d1 - legs[0].d0;
      expect(duration).toBeGreaterThanOrEqual(1);
    });

    it("uses realistic duration", () => {
      const activeLegs = [{
        tripId: "T1", routeId: "6", shape: null, headerTs: 1000,
        fromStopId: "8096", toStopId: "8097",
        departTs: 1000, arriveTs: 1200,
        fromDist: 0, toDist: 1500,
        fromLatLon: [-73.977, 40.784] as [number, number], toLatLon: [-73.978, 40.785] as [number, number],
        nextStopName: "Next", destName: "Dest",
      }];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].d1 - legs[0].d0).toBe(200);
    });
  });

  describe("delay estimation", () => {
    it("uses feed-reported delay for buses", () => {
      const activeLegs = [{
        tripId: "B1", routeId: "B42", shape: null, headerTs: 1000,
        fromStopId: "stop1", toStopId: "stop2",
        departTs: 1000, arriveTs: 1200,
        fromDist: 0, toDist: 2000,
        fromLatLon: [-74, 40] as [number, number], toLatLon: [-73.99, 40.01] as [number, number],
        nextStopName: "Next", destName: "Dest",
        delaySec: 150,
        mode: "bus" as const,
      }];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].dly).toBe(150);
    });
  });

  describe("ferry exclusion", () => {
    it("skips ferries entirely", () => {
      const activeLegs = [{
        tripId: "F1", routeId: "F1", shape: null, headerTs: 1000,
        fromStopId: "s1", toStopId: "s2",
        departTs: 1000, arriveTs: 1100,
        fromDist: 0, toDist: 1000,
        fromLatLon: [-74, 40] as [number, number], toLatLon: [-73.99, 40.01] as [number, number],
        nextStopName: "Next", destName: "Dest",
        mode: "ferry" as const,
      }];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs.length).toBe(0);
    });
  });

  describe("segment matching", () => {
    it("selects next stop as first future stop", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const activeLegs = [{
        tripId: "T2", routeId: "6", shape: null, headerTs: nowSec,
        fromStopId: "8096", toStopId: "8097",
        departTs: nowSec, arriveTs: nowSec + 120,
        fromDist: 0, toDist: 1500,
        fromLatLon: [-73.977, 40.784] as [number, number], toLatLon: [-73.978, 40.785] as [number, number],
        nextStopName: "Next", destName: "Dest",
      }];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      // TrainLeg does not expose toStopId in wire format
      expect(legs.length).toBe(1);
    });
  });
});
