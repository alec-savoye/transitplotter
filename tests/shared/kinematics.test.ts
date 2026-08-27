import {
  trapezoidDistance,
  trapezoidSpeed,
  locate,
  bearing,
  haversineM,
  projectDistance,
  buildCumMeters,
} from '@transitplotter/shared/kinematics';

describe('kinematics', () => {
  describe('trapezoidDistance', () => {
    it('returns 0 at elapsed=0', () => {
      expect(trapezoidDistance(0, 100, 1000)).toBe(0);
    });

    it('returns len at elapsed=T (dwells at end)', () => {
      expect(trapezoidDistance(100, 100, 1000)).toBe(1000);
    });

    it('clamps elapsed to [0, T]', () => {
      expect(trapezoidDistance(-10, 100, 1000)).toBe(0);
      expect(trapezoidDistance(200, 100, 1000)).toBe(1000);
    });

    it('handles triangular profile when T <= 2*ramp', () => {
      const dist = trapezoidDistance(5, 10, 1000); // T=10, ramp=8 → triangular
      expect(dist).toBeGreaterThan(0);
      expect(dist).toBeLessThan(1000);
    });

    it('is monotonic (never reverses)', () => {
      const T = 100, len = 1000, ramp = 8;
      for (let t = 0; t <= T; t++) {
        expect(
          trapezoidDistance(t, T, len, ramp)
        ).toBeLessThanOrEqual(trapezoidDistance(t + 1, T, len, ramp));
      }
    });

    it('returns 0 for len=0', () => {
      expect(trapezoidDistance(50, 100, 0)).toBe(0);
    });

    it('returns len for T=0 (instant)', () => {
      expect(trapezoidDistance(0, 0, 1000)).toBe(1000);
    });

    it('integrates to total length (∫speed = distance)', () => {
      const T = 100, len = 1000, ramp = 8;
      const speeds = [];
      for (let t = 0; t <= T; t += 0.1) {
        speeds.push(trapezoidSpeed(t, T, len, ramp));
      }
      const integral = speeds.reduce((s, v) => s + v * 0.1, 0);
      expect(Math.abs(integral - len)).toBeLessThan(1);
    });

    it('matches trapezoidSpeed integration', () => {
      const T = 100, len = 1000, ramp = 8;
      const distances = [];
      for (let t = 0; t <= T; t++) {
        distances.push(trapezoidDistance(t, T, len, ramp));
      }
      const integral = distances.reduce((s, d) => s + d * 0.0167, 0);
      expect(Math.abs(integral - len)).toBeLessThan(10);
    });

    it('trapezoidSpeed is derivative of trapezoidDistance', () => {
      const T = 100, len = 1000, ramp = 8;
      for (let t = 10; t <= 90; t += 5) {
        const d1 = trapezoidDistance(t, T, len, ramp);
        const d2 = trapezoidDistance(t + 1, T, len, ramp);
        const approxDeriv = d2 - d1;
        const speed = trapezoidSpeed(t + 0.5, T, len, ramp);
        expect(Math.abs(approxDeriv - speed)).toBeLessThan(0.5);
      }
    });
  });

  describe('trapezoidSpeed', () => {
    it('returns 0 at start and end', () => {
      expect(trapezoidSpeed(0, 100, 1000)).toBe(0);
      expect(trapezoidSpeed(100, 100, 1000)).toBe(0);
    });

    it('has positive speed in middle', () => {
      expect(trapezoidSpeed(50, 100, 1000)).toBeGreaterThan(0);
    });

    it('reaches cruising speed in trapezoidal case', () => {
      const T = 100, len = 1000, ramp = 8;
      const vmax = len / (T - ramp); // 1000 / 92 ≈ 10.87
      const speed = trapezoidSpeed(50, T, len, ramp);
      expect(speed).toBeLessThanOrEqual(vmax);
      expect(speed).toBeGreaterThan(vmax * 0.9);
    });

    it('accelerates during first ramp', () => {
      const T = 100, len = 1000, ramp = 8;
      const a = (len / (T - ramp)) / ramp;
      for (let t = 1; t <= ramp; t++) {
        const speed = trapezoidSpeed(t, T, len, ramp);
        expect(speed).toBeGreaterThan(speed - 1);
      }
    });

    it('decelerates during last ramp', () => {
      const T = 100, len = 1000, ramp = 8;
      for (let t = T - ramp; t < T - 1; t++) {
        const speed = trapezoidSpeed(t, T, len, ramp);
        const nextSpeed = trapezoidSpeed(t + 1, T, len, ramp);
        expect(nextSpeed).toBeLessThan(speed);
      }
    });
  });

  describe('buildCumMeters', () => {
    it('returns correct cumulative distances', () => {
      const pts: [number, number][] = [
        [0, 0],
        [0, 0.0009], // ~100m north
        [0, 0.0018], // ~200m north
      ];
      const cp = buildCumMeters(pts);
      expect(cp.len).toBeCloseTo(200, 0);
      expect(cp.cum[0]).toBe(0);
      expect(cp.cum[1]).toBeCloseTo(100, 0);
      expect(cp.cum[2]).toBeCloseTo(200, 0);
    });

    it('handles single point', () => {
      const pts: [number, number][] = [[-74, 40]];
      const cp = buildCumMeters(pts);
      expect(cp.len).toBe(0);
      expect(cp.cum.length).toBe(1);
    });

    it('handles empty array', () => {
      const pts: [number, number][] = [];
      const cp = buildCumMeters(pts);
      expect(cp.len).toBe(0);
      expect(cp.cum.length).toBe(1);
    });

    it('is monotonic', () => {
      const pts: [number, number][] = [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ];
      const cp = buildCumMeters(pts);
      for (let i = 1; i < cp.cum.length; i++) {
        expect(cp.cum[i]).toBeGreaterThanOrEqual(cp.cum[i - 1]);
      }
    });
  });

  describe('locate', () => {
    it('returns first point for d=0', () => {
      const pts: [number, number][] = [
        [0, 0],
        [1, 1],
        [2, 2],
      ];
      const cp = buildCumMeters(pts);
      const loc = locate(pts, cp, 0);
      expect(loc.lng).toBe(0);
      expect(loc.lat).toBe(0);
    });

    it('returns last point for d=len', () => {
      const pts: [number, number][] = [
        [0, 0],
        [1, 1],
        [2, 2],
      ];
      const cp = buildCumMeters(pts);
      const loc = locate(pts, cp, cp.len);
      expect(loc.lng).toBe(2);
      expect(loc.lat).toBe(2);
    });

    it('interpolates between points', () => {
      const pts: [number, number][] = [
        [0, 0],
        [1, 0],
        [2, 0],
      ];
      const cp = buildCumMeters(pts);
      // Halfway should be at lng=1
      const loc = locate(pts, cp, cp.len / 2);
      expect(loc.lng).toBe(1);
      expect(loc.lat).toBe(0);
    });

    it('clamps to valid range', () => {
      const pts: [number, number][] = [[0, 0], [1, 1]];
      const cp = buildCumMeters(pts);
      expect(locate(pts, cp, -100).lng).toBe(0);
      expect(locate(pts, cp, 1000).lng).toBe(1);
    });

    it('returns bearing along segment', () => {
      const pts: [number, number][] = [
        [-74, 40],
        [-73.99, 40.01], // NE direction
      ];
      const cp = buildCumMeters(pts);
      const loc = locate(pts, cp, cp.len / 2);
      expect(loc.brg).toBeGreaterThan(315);
      expect(loc.brg).toBeLessThan(360);
    });
  });

  describe('bearing', () => {
    it('returns 0 (N) for same longitude', () => {
      const brg = bearing([-74, 40], [-74, 41]);
      expect(brg).toBe(0);
    });

    it('returns 90 (E) for increasing longitude', () => {
      const brg = bearing([-74, 40], [-73.99, 40]);
      expect(brg).toBeGreaterThan(85);
      expect(brg).toBeLessThan(95);
    });

    it('returns 180 (S) for decreasing latitude', () => {
      const brg = bearing([-74, 40], [-74, 39]);
      expect(brg).toBeGreaterThan(175);
      expect(brg).toBeLessThan(185);
    });

    it('returns 270 (W) for decreasing longitude', () => {
      const brg = bearing([-74, 40], [-74.01, 40]);
      expect(brg).toBeGreaterThan(265);
      expect(brg).toBeLessThan(275);
    });
  });

  describe('haversineM', () => {
    it('returns 0 for same point', () => {
      const dist = haversineM([-74, 40], [-74, 40]);
      expect(dist).toBe(0);
    });

    it('approximates 1 degree latitude as ~111km', () => {
      const dist = haversineM([-74, 40], [-74, 41]);
      expect(dist).toBeCloseTo(111000, 0);
    });

    it('is symmetric', () => {
      const a = [-74, 40];
      const b = [-73.99, 40.01];
      expect(haversineM(a, b)).toBe(haversineM(b, a));
    });

    it('returns positive value', () => {
      const dist = haversineM([-74, 40], [-73, 41]);
      expect(dist).toBeGreaterThan(0);
    });
  });

  describe('projectDistance', () => {
    it('returns 0 for single point', () => {
      const pts: [number, number][] = [[-74, 40]];
      const cp = buildCumMeters(pts);
      const dist = projectDistance(pts, cp, -74, 40);
      expect(dist).toBe(0);
    });

    it('projects onto nearest segment', () => {
      const pts: [number, number][] = [
        [0, 0],
        [0, 10],
        [0, 20],
      ];
      const cp = buildCumMeters(pts);
      // Point at y=15 should project to between [0,10] and [0,20]
      const dist = projectDistance(pts, cp, 0, 15);
      expect(dist).toBeGreaterThan(10);
      expect(dist).toBeLessThan(20);
    });
  });
});
