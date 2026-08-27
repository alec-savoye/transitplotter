# TransitPlotter Test Suite

This directory contains unit tests for the TransitPlotter codebase.

## Structure

```
tests/
├── shared/
│   └── kinematics.test.ts     # Pure math functions (100% target)
├── server/
│   ├── state.test.ts          # Active leg construction
│   ├── trackrecord.test.ts    # Reliability mesh logic
│   └── legwire.test.ts        # TrainLeg wire format
├── fixtures/                  # Mock data files
│   ├── mock-feed-trips.json
│   ├── mock-static-data.json
│   └── mock-alerts.json
└── integration.test.ts        # End-to-end tests (optional)
```

## Running Tests

```bash
# All tests with coverage
npm test

# Server tests only
npm run test:server

# Shared tests only
npm run test:shared

# Watch mode
npm run test:watch
```

## Coverage Thresholds

| Module | Target | Rationale |
|--------|--------|-----------|
| `kinematics.ts` | 100% | Pure math, shared by server & web, critical for correctness |
| `state.ts` | 90% | Most complex logic (segment matching, route normalization) |
| `trackrecord.ts` | 85% | Time-decayed math, decay edge cases |
| `legwire.ts` | 80% | Speed clamping, delay estimation |
| `routing/*` | 70% | Graph algorithms (well-tested libraries available) |
| **Overall** | **80%** | Balance between coverage and practical effort |

## Coverage Report

```bash
npm test -- --coverage --coverageReporters=text-summary
```

Coverage reports are generated in `coverage/`:
- `coverage/lcov.info` - For Codecov upload
- `coverage/index.html` - Interactive HTML report
- `coverage/text-summary` - Console summary

## Test Philosophy

### Pure Functions (100% coverage)
Functions that don't depend on external state get comprehensive testing:
- `trapezoidDistance()` - All edge cases, integration tests
- `trapezoidSpeed()` - Derivative verification
- `haversineM()` - Distance accuracy
- `bearing()` - Direction calculations

### Business Logic (80-90% coverage)
Complex logic gets focused testing on critical paths:
- `buildActiveLegs()` - Segment matching, route normalization
- `TrackRecordStore` - Decay math, readiness calculation
- `buildTrainLegs()` - Speed clamping, delay estimation

### Integration Tests
End-to-end tests verify module interfaces:
- Feed → state → legwire → TrainLeg
- Full data flow from mock inputs to outputs

## Adding New Tests

1. Create test file in appropriate directory
2. Use descriptive test names following pattern:
   ```
   it('describes behavior when [condition]', () => {
     // ...
   })
   ```
3. Add to relevant test suite in `jest.config.ts` if needed
4. Run tests to verify coverage

## Mock Data

Fixtures are in `tests/fixtures/`:
- Realistic but simplified GTFS-realtime feeds
- Minimal static data for testing
- Service alert samples

## CI Integration

Tests run on every PR to `main` and `exp` branches:
1. Type check all workspaces
2. Run unit tests with coverage
3. Upload coverage to Codecov
4. Fail if coverage < 80%

## Notes

- Tests use Jest with ts-jest for TypeScript support
- All tests run in Node.js environment
- No browser tests (web app is integration-tested via E2E)
- Server runs via `tsx` (no compile step)
- Shared module imported as raw `.ts` files
