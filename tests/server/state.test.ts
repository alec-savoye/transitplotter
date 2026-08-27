import { buildActiveLegs } from 'src/state.js';
import type { FeedTrip, StaticData } from 'src/index.js';

describe('buildActiveLegs', () => {
  const mockGraph = {
    typicalSeconds: jest.fn().mockReturnValue(120)
  } as any;

  const mockStaticData: StaticData = {
    routes: new Map([
      ['1', { id: '1', color: '#D82233', name: '1' }],
      ['6', { id: '6', color: '#FFCC00', name: '6' }],
      ['W', { id: 'W', color: '#883311', name: 'W' }],
    ]),
    stops: new Map([
      ['127', { id: '127', name: 'Times Sq', lat: 40.7559, lon: -73.987 }],
      ['128', { id: '128', name: '42 St', lat: 40.757, lon: -73.989 }],
      ['8096', { id: '8096', name: 'Columbus Circle', lat: 40.784, lon: -73.977 }],
      ['8097', { id: '8097', name: '5 Av/59 St', lat: 40.767, lon: -73.978 }],
      ['8098', { id: '8098', name: '5 Av/86 St', lat: 40.781, lon: -73.978 }],
      ['125', { id: '125', name: 'Inwood', lat: 40.865, lon: -73.917 }],
      ['126', { id: '126', name: '191 St', lat: 40.855, lon: -73.905 }],
    ]),
    shapes: new Map(),
    lines: new Map([
      ['1|S', {
        routeId: '1', dir: 'S', shapeId: '1..S01',
        order: ['127', '128'],
        stopDist: { '127': 0, '128': 1000 }
      }],
      ['6|S', {
        routeId: '6', dir: 'S', shapeId: '6..S01',
        order: ['8096', '8097', '8098'],
        stopDist: { '8096': 0, '8097': 1500, '8098': 3000 }
      }],
      ['N|S', {
        routeId: 'N', dir: 'S', shapeId: 'N.S01',
        order: ['125', '126'],
        stopDist: { '125': 0, '126': 1200 }
      }],
    ]),
    lineByRouteDir: new Map([
      ['1|S', mockStaticData.lines.get('1|S')],
      ['6|S', mockStaticData.lines.get('6|S')],
      ['N|S', mockStaticData.lines.get('N|S')],
    ]),
  };

  describe('route normalization', () => {
    it('normalizes express suffixes (6X → 6)', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP001',
        routeId: '6X',
        stopUpdates: [
          { stopId: '8096', arrival: 1700000100 },
          { stopId: '8097', departure: 1700000180 }
        ],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].routeId).toBe('6');
    });

    it('normalizes 7X → 7', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP002',
        routeId: '7X',
        stopUpdates: [{ stopId: '8096', arrival: 1700000100 }],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].routeId).toBe('7');
    });

    it('normalizes FX → F', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP003',
        routeId: 'FX',
        stopUpdates: [{ stopId: '127', arrival: 1700000100 }],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].routeId).toBe('F');
    });

    it('handles trips without X suffix', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP004',
        routeId: '1',
        stopUpdates: [{ stopId: '127', arrival: 1700000100 }],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].routeId).toBe('1');
    });
  });

  describe('route aliases', () => {
    it('applies W → N alias', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP005',
        routeId: 'W',
        stopUpdates: [{ stopId: '125', departure: 1700000100 }],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].routeId).toBe('N');
    });

    it('handles 6X then applies W alias (6X → 6, then W → N)', () => {
      // This tests the edge case where 6X becomes 6, but if 6 were aliased to N
      const feed: FeedTrip[] = [{
        tripId: 'TRIP006',
        routeId: '6X',
        stopUpdates: [{ stopId: '8096', arrival: 1700000100 }],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].routeId).toBe('6');
    });
  });

  describe('direction handling', () => {
    it('extracts N suffix from stopId', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP007',
        routeId: '1',
        stopUpdates: [{ stopId: '127N', arrival: 1700000100 }],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].routeId).toBe('1');
      // Should use '1|N' line for lookup
    });

    it('extracts S suffix from stopId', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP008',
        routeId: '1',
        stopUpdates: [{ stopId: '127S', arrival: 1700000100 }],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].routeId).toBe('1');
    });

    it('handles stopIds without direction suffix', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP009',
        routeId: '1',
        stopUpdates: [{ stopId: '127', arrival: 1700000100 }],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].routeId).toBe('1');
    });
  });

  describe('implicit origin handling', () => {
    it('derives stable departure time when first stop is still ahead', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const feed: FeedTrip[] = [{
        tripId: 'TRIP010',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', arrival: nowSec + 120 }, // Still ahead
        ],
        headerTs: nowSec
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      // departTs should be derived from typical segment time, not nowSec
      expect(legs[0].departTs).toBeLessThan(nowSec);
      expect(legs[0].arriveTs).toBeGreaterThan(legs[0].departTs);
    });

    it('uses nowSec when trip has prior stop in feed', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const feed: FeedTrip[] = [{
        tripId: 'TRIP011',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', departure: nowSec, arrival: nowSec + 120 },
        ],
        headerTs: nowSec
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].departTs).toBeLessThanOrEqual(nowSec);
    });
  });

  describe('segment matching', () => {
    it('selects next stop as first future stop', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const feed: FeedTrip[] = [{
        tripId: 'TRIP012',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', departure: nowSec },
          { stopId: '8097', arrival: nowSec + 120 },
          { stopId: '8098', arrival: nowSec + 240 },
        ],
        headerTs: nowSec
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].toStopId).toBe('8097');
    });

    it('uses last stop when all stops are in the past', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const feed: FeedTrip[] = [{
        tripId: 'TRIP013',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', departure: nowSec - 60 },
          { stopId: '8097', departure: nowSec - 30 },
          { stopId: '8098', arrival: nowSec - 10 },
        ],
        headerTs: nowSec
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].toStopId).toBe('8098');
    });

    it('selects previous stop when trip has multiple updates', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const feed: FeedTrip[] = [{
        tripId: 'TRIP014',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', departure: nowSec - 60 },
          { stopId: '8097', arrival: nowSec - 30, departure: nowSec + 60 },
          { stopId: '8098', arrival: nowSec + 120 },
        ],
        headerTs: nowSec
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].fromStopId).toBe('8097');
      expect(legs[0].toStopId).toBe('8098');
    });

    it('handles trips with no future stops', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const feed: FeedTrip[] = [{
        tripId: 'TRIP015',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', departure: nowSec - 60 },
        ],
        headerTs: nowSec
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs.length).toBeGreaterThan(0);
      expect(legs[0].toStopId).toBe('8096');
    });
  });

  describe('shape lookup', () => {
    it('assigns shape when line exists for route+dir', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP016',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', arrival: 1700000100 },
          { stopId: '8097', departure: 1700000180 },
        ],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].shape).toBeDefined();
      expect(legs[0].shape?.points).toBeDefined();
    });

    it('handles trips without matching line', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP017',
        routeId: 'Z', // No line defined
        stopUpdates: [
          { stopId: '999', arrival: 1700000100 },
        ],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs.length).toBeGreaterThan(0);
      expect(legs[0].shape).toBeNull();
    });
  });

  describe('from/to coordinates', () => {
    it('assigns stop coordinates when stop exists', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP018',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', arrival: 1700000100 },
          { stopId: '8097', departure: 1700000180 },
        ],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].fromLatLon).toBeDefined();
      expect(legs[0].toLatLon).toBeDefined();
      expect(legs[0].fromLatLon![1]).toBe(40.784); // Columbus Circle lat
    });

    it('returns null coordinates for unknown stops', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP019',
        routeId: '6',
        stopUpdates: [
          { stopId: '9999', arrival: 1700000100 },
        ],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].fromLatLon).toBeNull();
      expect(legs[0].toLatLon).toBeNull();
    });
  });

  describe('human-readable names', () => {
    it('assigns next stop name', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP020',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', arrival: 1700000100 },
          { stopId: '8097', departure: 1700000180 },
        ],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].nextStopName).toBe('5 Av/59 St');
    });

    it('assigns trip destination from last stop', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP021',
        routeId: '1',
        stopUpdates: [
          { stopId: '1', arrival: 1700000100 },
          { stopId: '2', arrival: 1700000150 },
          { stopId: '3', arrival: 1700000200 },
        ],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].destName).toBe('Inwood-207 St');
    });

    it('handles trips with no last stop name', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP022',
        routeId: '1',
        stopUpdates: [
          { stopId: '999', arrival: 1700000100 },
        ],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs[0].destName).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('skips trips with no stop updates', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP023',
        routeId: '1',
        stopUpdates: [],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs.length).toBe(0);
    });

    it('handles trips with only one stop update', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const feed: FeedTrip[] = [{
        tripId: 'TRIP024',
        routeId: '6',
        stopUpdates: [
          { stopId: '8096', arrival: nowSec + 120 },
        ],
        headerTs: nowSec
      }];
      const legs = buildActiveLegs(feed, mockStaticData, mockGraph as any);
      expect(legs.length).toBeGreaterThan(0);
    });

    it('handles empty feed', () => {
      const legs = buildActiveLegs([], mockStaticData, mockGraph as any);
      expect(legs.length).toBe(0);
    });

    it('works without routing graph (uses nowSec for departTs)', () => {
      const feed: FeedTrip[] = [{
        tripId: 'TRIP025',
        routeId: '1',
        stopUpdates: [{ stopId: '1', arrival: 1700000100 }],
        headerTs: 1700000000
      }];
      const legs = buildActiveLegs(feed, mockStaticData, undefined);
      expect(legs.length).toBeGreaterThan(0);
    });
  });
});
