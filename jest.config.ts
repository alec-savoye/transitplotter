export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleNameMapper: {
    '^@transitplotter/shared$': '<rootDir>/shared/src/types.ts',
    '^@transitplotter/shared/kinematics$': '<rootDir>/shared/src/kinematics.ts',
    '^src/(.*)$': '<rootDir>/server/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useEsm: true }],
  },
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'shared/src/**/*.ts',
    'server/src/**/*.ts',
    '!server/src/index.ts',
    '!server/src/ws.ts',
    '!server/src/tick.ts',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
