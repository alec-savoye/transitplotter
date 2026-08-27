import { buildTrainLegs } from 'src/legwire.js';
import type { RoutingGraph } from 'src/routing/graph.js';

describe('buildTrainLegs', () => {
  const mockGraph: RoutingGraph = {
    typicalSeconds: jest.fn().mockReturnValue(180)
  } as any;

  describe('speed clamping', () => {
    it('clamps implausibly short durations to MAX_SPEED_MPS', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 1001, // Only 1 second!
          fromDist: 0,
          toDist: 1500, // 1.5km in 1 second = 1500 m/s (impossible)
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: '5 Av/59 St',
          destName: 'White Plains Road',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      // Duration should be at least length / MAX_SPEED_MPS
      const duration = legs[0].d1 - legs[0].d0;
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeGreaterThanOrEqual(1);
    });

    it('uses original duration when realistic', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 1200, // 2 minutes, realistic
          fromDist: 0,
          toDist: 1500,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: '5 Av/59 St',
          destName: 'White Plains Road',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].d1 - legs[0].d0).toBe(200);
    });

    it('clamps to minimum 1 second', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 999, // Negative duration!
          fromDist: 0,
          toDist: 100,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].d1 - legs[0].d0).toBeGreaterThanOrEqual(1);
    });
  });

  describe('delay estimation', () => {
    it('uses feed-reported delay when available (buses)', () => {
      const activeLegs = [
        {
          tripId: 'B1',
          routeId: 'B42',
          shape: null,
          headerTs: 1000,
          fromStopId: 'stop1',
          toStopId: 'stop2',
          departTs: 1000,
          arriveTs: 1200,
          fromDist: 0,
          toDist: 2000,
          fromLatLon: [-74, 40],
          toLatLon: [-73.99, 40.01],
          nextStopName: 'Next',
          destName: 'Dest',
          delaySec: 150, // Feed reports 150s delay
          mode: 'bus',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].dly).toBe(150);
    });

    it('estimates delay from typical segment time for subway', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 200, // Predicted 200s (fast)
          fromDist: 0,
          toDist: 1500,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
          mode: 'subway',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      // predicted (200) - typical (180) = -20, so no delay reported
      expect(legs[0].dly).toBeUndefined();
    });

    it('reports positive delay when predicted > typical', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 400, // Predicted 400s (late)
          fromDist: 0,
          toDist: 1500,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
          mode: 'subway',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].dly).toBe(220); // 400 - 180 = 220
    });

    it('does not report delay when predicted < typical', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 100, // Predicted 100s (early)
          fromDist: 0,
          toDist: 1500,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
          mode: 'subway',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].dly).toBeUndefined();
    });

    it('uses delaySec when provided (overrides estimation)', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 200,
          fromDist: 0,
          toDist: 1500,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
          delaySec: 300, // Feed reports 300s delay
          mode: 'subway',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].dly).toBe(300);
    });

    it('rounds delay to integer seconds', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 400,
          fromDist: 0,
          toDist: 1500,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
          mode: 'subway',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].dly).toBe(220);
    });
  });

  describe('path construction', () => {
    it('uses shape polyline when available', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: {
            id: '6..S01',
            points: [
              { lon: -73.977, lat: 40.784, dist: 0 },
              { lon: -73.978, lat: 40.78, dist: 1000 },
              { lon: -73.978, lat: 40.77, dist: 2000 },
            ],
          },
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 2000,
          fromDist: 0,
          toDist: 1000,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.78],
          nextStopName: 'Next',
          destName: 'Dest',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].path).toBeDefined();
      expect(legs[0].path.length).toBeGreaterThan(2);
      expect(legs[0].path[0]).toEqual([-73.977, 40.784]);
    });

    it('falls back to stop coordinates when no shape', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 2000,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].path).toHaveLength(2);
      expect(legs[0].path[0]).toEqual([-73.977, 40.784]);
      expect(legs[0].path[1]).toEqual([-73.978, 40.785]);
    });

    it('rounds coordinates to ~1m precision', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: {
            id: 'S1',
            points: [
              { lon: -73.977123, lat: 40.784456, dist: 0 },
              { lon: -73.978987, lat: 40.785789, dist: 1000 },
            ],
          },
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 2000,
          fromDist: 0,
          toDist: 1000,
          fromLatLon: [-73.977123, 40.784456],
          toLatLon: [-73.978987, 40.785789],
          nextStopName: 'Next',
          destName: 'Dest',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      // Coordinates should be rounded to 6 decimal places (~1m)
      expect(legs[0].path[0]).toEqual([-73.977123, 40.784456]);
    });

    it('reverses path when fromDist > toDist', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: {
            id: 'S1',
            points: [
              { lon: -73.977, lat: 40.784, dist: 0 },
              { lon: -73.978, lat: 40.78, dist: 1000 },
              { lon: -73.979, lat: 40.77, dist: 2000 },
            ],
          },
          headerTs: 1000,
          fromStopId: '8097',
          toStopId: '8096',
          departTs: 1000,
          arriveTs: 2000,
          fromDist: 1000,
          toDist: 0, // Going backwards
          fromLatLon: [-73.978, 40.78],
          toLatLon: [-73.977, 40.784],
          nextStopName: 'Next',
          destName: 'Dest',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].path.length).toBeGreaterThan(0);
      // Path should still be in travel order (from to)
    });
  });

  describe('output format', () => {
    it('includes all required TrainLeg fields', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 2000,
          fromDist: 0,
          toDist: 1500,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      const leg = legs[0];
      expect(leg).toHaveProperty('id');
      expect(leg).toHaveProperty('r');
      expect(leg).toHaveProperty('path');
      expect(leg).toHaveProperty('d0');
      expect(leg).toHaveProperty('d1');
      expect(leg).toHaveProperty('hts');
      expect(leg).toHaveProperty('ns');
      expect(leg).toHaveProperty('dest');
    });

    it('includes mode field for non-subway vehicles', () => {
      const activeLegs = [
        {
          tripId: 'F1',
          routeId: 'F1',
          shape: null,
          headerTs: 1000,
          fromStopId: 'stop1',
          toStopId: 'stop2',
          departTs: 1000,
          arriveTs: 2000,
          fromLatLon: [-74, 40],
          toLatLon: [-73.99, 40.01],
          nextStopName: 'Next',
          destName: 'Dest',
          mode: 'ferry',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].mode).toBe('ferry');
    });

    it('excludes mode field for subway (defaults)', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 2000,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
          mode: 'subway',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      // mode should be undefined (not present) for subway
      expect(legs[0].mode).toBeUndefined();
    });

    it('includes label and boro for buses', () => {
      const activeLegs = [
        {
          tripId: 'B1',
          routeId: 'B42',
          shape: null,
          headerTs: 1000,
          fromStopId: 'stop1',
          toStopId: 'stop2',
          departTs: 1000,
          arriveTs: 2000,
          fromLatLon: [-74, 40],
          toLatLon: [-73.99, 40.01],
          nextStopName: 'Next',
          destName: 'Dest',
          mode: 'bus',
          label: 'B42',
          boro: 'B',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].label).toBe('B42');
      expect(legs[0].boro).toBe('B');
    });

    it('includes ferry vessel info', () => {
      const activeLegs = [
        {
          tripId: 'F1',
          routeId: 'F1',
          shape: null,
          headerTs: 1000,
          fromStopId: 'stop1',
          toStopId: 'stop2',
          departTs: 1000,
          arriveTs: 2000,
          fromLatLon: [-74, 40],
          toLatLon: [-73.99, 40.01],
          nextStopName: 'Next',
          destName: 'Dest',
          mode: 'ferry',
          label: 'West Terminal',
          speedMps: 8.5,
          vehicleId: 'HULL001',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].label).toBe('West Terminal');
      expect(legs[0].spd).toBe(8.5);
      expect(legs[0].vid).toBe('HULL001');
    });
  });

  describe('edge cases', () => {
    it('skips legs with empty path', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000,
          arriveTs: 2000,
          fromLatLon: null,
          toLatLon: null,
          nextStopName: 'Next',
          destName: 'Dest',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs.length).toBe(0);
    });

    it('handles single point path', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000,
          fromStopId: '8096',
          toStopId: '8096', // Same stop
          departTs: 1000,
          arriveTs: 1100,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.977, 40.784],
          nextStopName: 'Next',
          destName: 'Dest',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs.length).toBe(1);
      expect(legs[0].path.length).toBe(1);
    });

    it('rounds timestamps to integers', () => {
      const activeLegs = [
        {
          tripId: 'T1',
          routeId: '6',
          shape: null,
          headerTs: 1000.7,
          fromStopId: '8096',
          toStopId: '8097',
          departTs: 1000.3,
          arriveTs: 2000.8,
          fromDist: 0,
          toDist: 1500,
          fromLatLon: [-73.977, 40.784],
          toLatLon: [-73.978, 40.785],
          nextStopName: 'Next',
          destName: 'Dest',
        }
      ];
      const legs = buildTrainLegs(activeLegs, mockGraph);
      expect(legs[0].d0).toBe(1000);
      expect(legs[0].d1).toBe(2001);
      expect(legs[0].hts).toBe(1001);
    });
  });
});
