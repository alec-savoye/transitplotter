module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { useESM: true, tsconfig: { esModuleInterop: true, moduleResolution: "node" } }]
  },
  moduleNameMapper: {
    "^\\.{2,}/(server|shared)/(.*)(\\.js)?$": "<rootDir>/$1/src/$2"
  },
  testMatch: ["**/*.test.ts"],
  testPathIgnorePatterns: [],
  collectCoverageFrom: [
    "shared/src/**/*.ts",
    "server/src/**/*.ts",
    "!server/src/index.ts",
    "!server/src/ws.ts",
    "!server/src/tick.ts",
  ],
  coverageReporters: ["text", "lcov", "html"],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 70,
      lines: 75,
      statements: 75,
    },
  },
};
