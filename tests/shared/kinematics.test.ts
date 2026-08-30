import {
  trapezoidDistance,
  trapezoidSpeed,
  locate,
  bearing,
  haversineM,
  buildCumMeters,
} from "../../shared/src/kinematics";

describe("kinematics", () => {
  describe("trapezoidDistance", () => {
    it("returns 0 at elapsed=0", () => {
      expect(trapezoidDistance(0, 100, 1000)).toBe(0);
    });
    it("returns len at elapsed=T", () => {
      expect(trapezoidDistance(100, 100, 1000)).toBe(1000);
    });
    it("is monotonic", () => {
      for (let t = 0; t <= 100; t++) {
        expect(trapezoidDistance(t, 100, 1000)).toBeLessThanOrEqual(
          trapezoidDistance(t + 1, 100, 1000)
        );
      }
    });
    it("integrates to total length", () => {
      const T = 100, len = 1000;
      const speeds: number[] = [];
      for (let t = 0; t <= T; t += 0.1) {
        speeds.push(trapezoidSpeed(t, T, len));
      }
      const integral = speeds.reduce((s, v) => s + v * 0.1, 0);
      expect(Math.abs(integral - len)).toBeLessThan(1);
    });
  });
  describe("trapezoidSpeed", () => {
    it("returns 0 at start and end", () => {
      expect(trapezoidSpeed(0, 100, 1000)).toBe(0);
      expect(trapezoidSpeed(100, 100, 1000)).toBe(0);
    });
    it("has positive speed in middle", () => {
      expect(trapezoidSpeed(50, 100, 1000)).toBeGreaterThan(0);
    });
  });
  describe("buildCumMeters", () => {
    it("returns correct cumulative distances", () => {
      const pts: [number, number][] = [
        [0, 0],
        [0, 0.0009],
        [0, 0.0018],
      ];
      const cp = buildCumMeters(pts);
      expect(cp.len).toBeCloseTo(200, 1);
    });
  });
  describe("locate", () => {
    it("returns first point for d=0", () => {
      const pts: [number, number][] = [[0, 0], [1, 1], [2, 2]];
      const cp = buildCumMeters(pts);
      const loc = locate(pts, cp, 0);
      expect(loc.lng).toBe(0);
      expect(loc.lat).toBe(0);
    });
    it("returns last point for d=len", () => {
      const pts: [number, number][] = [[0, 0], [1, 1], [2, 2]];
      const cp = buildCumMeters(pts);
      const loc = locate(pts, cp, cp.len);
      expect(loc.lng).toBe(2);
      expect(loc.lat).toBe(2);
    });
  });
  describe("bearing", () => {
    it("returns 0 (N) for same longitude", () => {
      const brg = bearing([-74, 40], [-74, 41]);
      expect(brg).toBe(0);
    });
    it("returns 90 (E) approximately", () => {
      const brg = bearing([-74, 40], [-73.99, 40]);
      expect(brg).toBeGreaterThan(85);
      expect(brg).toBeLessThan(95);
    });
  });
  describe("haversineM", () => {
    it("returns 0 for same point", () => {
      const dist = haversineM([-74, 40], [-74, 40]);
      expect(dist).toBe(0);
    });
    it("approximates 1 degree latitude as ~111km", () => {
      const dist = haversineM([-74, 40], [-74, 41]);
      expect(dist).toBeCloseTo(111195, 0);
    });
  });
});
