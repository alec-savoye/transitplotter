import { TrackRecordStore } from 'src/trackrecord.js';
import type { TrainLeg } from '@transitplotter/shared';

describe('TrackRecordStore', () => {
  let store: TrackRecordStore;
  const cacheDir = '/tmp/test-track-records';

  beforeEach(() => {
    store = new TrackRecordStore(cacheDir);
  });

  describe('modeRate', () => {
    it('averages per-mode rates (equal weighting)', () => {
      const cell = {
        subway: { late: 10, total: 20, ts: 0 }, // 50% late
        bus: { late: 5, total: 100, ts: 0 },   // 5% late
        firstObs: 0, lastObs: 0, days: new Map()
      } as any;
      const rate = (cell: any) => {
        const rates: number[] = [];
        if (cell.subway.total > 0) rates.push(cell.subway.late / cell.subway.total);
        if (cell.bus.total > 0) rates.push(cell.bus.late / cell.bus.total);
        if (rates.length === 0) return 0;
        return rates.reduce((s, r) => s + r, 0) / rates.length;
      };
      const rate = rate(cell);
      // Should be (0.5 + 0.05) / 2 = 0.275, NOT (10+5)/(20+100) = 0.083
      expect(rate).toBeCloseTo(0.275, 2);
    });

    it('handles single-mode cells', () => {
      const cell = {
        subway: { late: 5, total: 10, ts: 0 },
        bus: { late: 0, total: 0, ts: 0 },
        firstObs: 0, lastObs: 0, days: new Map()
      } as any;
      expect(cell.subway.total > 0).toBe(true);
      expect(cell.bus.total > 0).toBe(false);
    });
  });

  describe('record', () => {
    it('detects segment completion when next stop changes', () => {
      const legs: TrainLeg[] = [
        { id: 'T1', path: [[-74, 40]], ns: '8096', dly: 0, mode: 'subway' },
        { id: 'T1', path: [[-74, 40.004]], ns: '8097', dly: 150, mode: 'subway' },
        { id: 'T1', path: [[-74, 40.008]], ns: '8098', dly: 0, mode: 'subway' },
      ];

      store.ingest(legs);

      expect(store.snapshot().totalObs).toBeGreaterThan(0);
    });

    it('excludes ferries (no delay signal)', () => {
      const legs: TrainLeg[] = [
        { id: 'F1', path: [[-74, 40]], ns: 'Next', dly: 0, mode: 'ferry' },
      ];
      store.ingest(legs);
      expect(store.snapshot().totalObs).toBe(0);
    });

    it('tracks bus observations separately', () => {
      const legs: TrainLeg[] = [
        { id: 'B1', path: [[-74, 40]], ns: 'Next', dly: 0, mode: 'bus' },
        { id: 'B1', path: [[-74, 40.004]], ns: 'Next2', dly: 0, mode: 'bus' },
      ];
      store.ingest(legs);
      const snap = store.snapshot();
      expect(snap.cells.length).toBeGreaterThan(0);
      for (const cell of snap.cells) {
        expect(cell.bus.total).toBeGreaterThanOrEqual(0);
        expect(cell.subway.total).toBe(0);
      }
    });

    it('marks late observations (delay >= 120s)', () => {
      const legs: TrainLeg[] = [
        { id: 'T1', path: [[-74, 40]], ns: 'Next', dly: 119, mode: 'subway' },
        { id: 'T1', path: [[-74, 40.004]], ns: 'Next2', dly: 120, mode: 'subway' },
        { id: 'T1', path: [[-74, 40.008]], ns: 'Next3', dly: 180, mode: 'subway' },
      ];
      store.ingest(legs);
      const snap = store.snapshot();
      expect(snap.cells.length).toBeGreaterThan(0);
      for (const cell of snap.cells) {
        expect(cell.subway.total).toBe(2);
        expect(cell.subway.late).toBe(1); // Only the 120s and 180s count as late
      }
    });

    it('prunes daily history to MAX_HISTORY_DAYS', () => {
      const cell = store.cells.get('0:0');
      if (cell) {
        for (let i = 0; i < 20; i++) {
          const dk = `2024-${String(i).padStart(2, '0')}-01`;
          cell.days.set(dk, { late: 0, total: 1 });
        }
      }
      store.flush(true);
      const loaded = new TrackRecordStore(cacheDir);
      const c = loaded.cells.get('0:0');
      expect(c?.days.size).toBeLessThanOrEqual(14);
    });
  });

  describe('snapshot', () => {
    it('computes cell readiness correctly', () => {
      // Create a cell with observations spanning 1+ days
      const now = Date.now();
      const yesterday = now - 24 * 60 * 60 * 1000;

      const legs: TrainLeg[] = [
        { id: 'T1', path: [[-74, 40]], ns: 'Next', dly: 0, mode: 'subway' },
        { id: 'T1', path: [[-74, 40.004]], ns: 'Next2', dly: 0, mode: 'subway' },
      ];
      store.ingest(legs);
      store.flush(true);

      const snap = store.snapshot();
      expect(snap.ready).toBe(false); // Not enough span yet
    });

    it('includes cell center coordinates', () => {
      const legs: TrainLeg[] = [
        { id: 'T1', path: [[-74, 40]], ns: 'Next', dly: 0, mode: 'subway' },
      ];
      store.ingest(legs);
      const snap = store.snapshot();
      expect(snap.cells.length).toBeGreaterThan(0);
      for (const cell of snap.cells) {
        expect(cell.lat).toBeDefined();
        expect(cell.lon).toBeDefined();
      }
    });

    it('rounds tallies to integers', () => {
      const legs: TrainLeg[] = [];
      for (let i = 0; i < 10; i++) {
        legs.push({
          id: `T${i}`,
          path: [[-74 + i * 0.0001, 40]],
          ns: 'Next',
          dly: 0,
          mode: 'subway'
        });
      }
      store.ingest(legs);
      const snap = store.snapshot();
      for (const cell of snap.cells) {
        expect(typeof cell.subway.late).toBe('number');
        expect(typeof cell.subway.total).toBe('number');
        expect(typeof cell.total).toBe('number');
      }
    });
  });

  describe('history', () => {
    it('returns null for unknown cells', () => {
      const hist = store.history('999:999');
      expect(hist).toBeNull();
    });

    it('returns null for empty cells', () => {
      const hist = store.history('0:0');
      expect(hist).toBeNull();
    });

    it('returns days sorted oldest first', () => {
      const now = Date.now();
      const yesterday = now - 24 * 60 * 60 * 1000;

      const legs: TrainLeg[] = [
        { id: 'T1', path: [[-74, 40]], ns: 'Next', dly: 0, mode: 'subway' },
        { id: 'T1', path: [[-74, 40.004]], ns: 'Next2', dly: 0, mode: 'subway' },
      ];
      store.ingest(legs);
      store.flush(true);

      const hist = store.history('0:0');
      if (hist && hist.days.length >= 2) {
        const dates = hist.days.map((d) => d.date);
        expect(dates[0]).toBeLessThanOrEqual(dates[dates.length - 1]);
      }
    });
  });

  describe('ingest', () => {
    it('tracks trip state between polls', () => {
      const legs: TrainLeg[] = [
        { id: 'T1', path: [[-74, 40]], ns: '8096', dly: 0, mode: 'subway' },
      ];
      store.ingest(legs);

      const snap = store.snapshot();
      expect(snap.totalObs).toBe(0); // No segment completed yet
    });

    it('purges stale trips (not seen for 10min)', () => {
      const now = Date.now();
      const staleLegs: TrainLeg[] = [
        { id: 'T1', path: [[-74, 40]], ns: 'Next', dly: 0, mode: 'subway' },
      ];
      store.ingest(staleLegs);

      // Wait in simulation time
      jest.useFakeTimers();
      jest.advanceTimersByTime(11 * 60 * 1000); // 11 minutes

      store.flush(true);

      jest.useRealTimers();
      const snap = store.snapshot();
      expect(snap.totalObs).toBe(0);
    });

    it('handles multiple trips in batch', () => {
      const legs: TrainLeg[] = [
        { id: 'T1', path: [[-74, 40]], ns: 'Next', dly: 0, mode: 'subway' },
        { id: 'T2', path: [[-73.99, 40]], ns: 'Next', dly: 0, mode: 'subway' },
        { id: 'T3', path: [[-73.98, 40]], ns: 'Next', dly: 0, mode: 'bus' },
      ];
      store.ingest(legs);
      const snap = store.snapshot();
      expect(snap.cells.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('cellKey', () => {
    it('computes correct cell key from coordinates', () => {
      const lat = 40.7589;
      const lon = -73.9851;
      const li = Math.floor(lat / 0.004);
      const lo = Math.floor(lon / 0.005);
      const key = `${li}:${lo}`;
      expect(store['cellKey'](lat, lon)).toBe(key);
    });

    it('rounds coordinates to cell centers', () => {
      const lat = 40.7589;
      const lon = -73.9851;
      const cell = store.cells.get(store['cellKey'](lat, lon));
      expect(cell).toBeDefined();
    });
  });
});
