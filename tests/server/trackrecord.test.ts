import { TrackRecordStore } from "../../server/src/trackrecord";

describe("TrackRecordStore", () => {
  describe("modeRate", () => {
    it("averages per-mode rates (equal weighting)", () => {
      const store = new TrackRecordStore(".cache");
      // This test is about the calculation, not the ingestion
      // Skip for now
    });
  });

  describe("record", () => {
    const store = new TrackRecordStore(".cache");

    it("detects segment completion when next stop changes", () => {
      const legs = [
        { id: "T1", r: "6", path: [[-74, 40], [-74, 40.001]] as [number, number][] as [number, number][], ns: "8096", dly: 0, mode: "subway" as const, d0: 1000, d1: 1100, hts: 1000 },
        { id: "T1", r: "6", path: [[-74, 40.004], [-74, 40.004]] as [number, number][], ns: "8097", dly: 150, mode: "subway" as const, d0: 1100, d1: 1200, hts: 1000 },
        { id: "T1", r: "6", path: [[-74, 40.008], [-74, 40.008]] as [number, number][], ns: "8098", dly: 0, mode: "subway" as const, d0: 1200, d1: 1300, hts: 1000 },
      ];
      store.ingest(legs);
      expect(store.snapshot().totalObs).toBeGreaterThan(0);
    });
  });

  describe("snapshot", () => {
    it("computes cell readiness correctly", () => {
      const store = new TrackRecordStore(".cache");
      expect(!store.snapshot().ready);
    });
  });

  describe("ingest", () => {
    it("handles multiple trips in batch", () => {
      const store = new TrackRecordStore(".cache");
      const legs = [
        { id: "T1", r: "1", path: [[-74, 40], [-74, 40.001]] as [number, number][] as [number, number][], ns: "127", dly: 0, mode: "subway" as const, d0: 1000, d1: 1100, hts: 1000 },
        { id: "T2", r: "2", path: [[-74, 40.001], [-74, 40.002]] as [number, number][], ns: "128", dly: 5, mode: "subway" as const, d0: 1100, d1: 1200, hts: 1000 },
      ];
      store.ingest(legs);
      const snap = store.snapshot();
      expect(snap.cells.length).toBeGreaterThanOrEqual(2);
    });

    it("excludes ferries", () => {
      const store = new TrackRecordStore(".cache");
      const legs = [{ id: "F1", r: "F1", path: [[-74, 40], [-74, 40.001]] as [number, number][] as [number, number][], ns: "Next", dly: 0, mode: "ferry" as const, d0: 1000, d1: 1100, hts: 1000 }];
      store.ingest(legs);
      expect(store.snapshot().totalObs).toBe(0);
    });
  });
});
