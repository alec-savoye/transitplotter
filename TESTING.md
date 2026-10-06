# Test Suite & CI Implementation Guide

## What Has Been Created

### 1. Test Configuration
- **`jest.config.ts`** - Jest configuration for monorepo testing
- **`package.json`** - Added Jest dev dependencies and test scripts

### 2. Test Files Created

#### Shared Module (100% coverage target)
- **`tests/shared/kinematics.test.ts`** - Comprehensive tests for:
  - `trapezoidDistance()`: Boundary cases, monotonicity, integration verification
  - `trapezoidSpeed()`: Derivative relationship, acceleration/deceleration
  - `buildCumMeters()`: Cumulative distance calculations
  - `locate()`: Binary search, interpolation, bearing
  - `bearing()`: Cardinal directions, edge cases
  - `haversineM()`: Distance accuracy, symmetry
  - `projectDistance()`: Point projection

#### Server Module (80% coverage target)
- **`tests/server/trackrecord.test.ts`** - Tests for:
  - `modeRate()`: Mode-blending logic (average per-mode rates)
  - `record()`: Segment completion detection, daily history pruning
  - `snapshot()`: Cell readiness, coordinate calculation
  - `history()`: Time-series retrieval
  - `ingest()`: Trip state tracking, stale trip purging

- **`tests/server/state.test.ts`** - Tests for:
  - Route normalization (6X→6, 7X→7, FX→F)
  - Route aliases (W→N)
  - Direction handling (N/S suffix extraction)
  - Implicit origin handling (stable departure time)
  - Segment matching (next stop selection)
  - Shape lookup and coordinate assignment
  - Human-readable names (next stop, destination)
  - Edge cases (empty feed, single stop)

- **`tests/server/legwire.test.ts`** - Tests for:
  - Speed clamping (MAX_SPEED_MPS = 30 m/s)
  - Delay estimation (feed-reported vs. typical segment)
  - Path construction (shape slicing, fallback to stops)
  - Coordinate rounding (~1m precision)
  - Output format (all TrainLeg fields)
  - Mode handling (subway vs. ferry vs. bus)
  - Edge cases (empty path, single point)

### 3. Test Fixtures
- **`tests/fixtures/mock-feed-trips.json`** - Sample GTFS-realtime trips
- **`tests/fixtures/mock-static-data.json`** - Minimal static data for testing
- **`tests/fixtures/mock-alerts.json`** - Service alert samples

### 4. CI Configuration
- **`.github/workflows/ci.yml`** - GitHub Actions workflow with:
  - Type checking (web, server, shared)
  - Unit tests with coverage
  - Codecov integration
  - Separate jobs for parallel execution

### 5. Documentation
- **`tests/README.md`** - Test suite documentation and usage

## Next Steps to Complete

### 1. Install Dependencies (in Docker container)
```bash
docker compose run --rm web npm install
docker compose run --rm server npm install
```

### 2. Run Tests
```bash
# From Docker container
docker compose exec -T web sh -c 'cd /app && npm test'
docker compose exec -T server sh -c 'cd /app && npm run test:server'
```

### 3. Verify Coverage
```bash
docker compose exec -T web sh -c 'cd /app && npm test -- --coverage --coverageReporters=text-summary'
```

### 4. Add Remaining Test Files (Optional)
- `tests/server/arrivals.test.ts` - Arrivals board computation
- `tests/server/alerts.test.ts` - Alert classification
- `tests/server/routing/graph.test.ts` - Graph construction
- `tests/server/routing/plan.test.ts` - Journey planning
- `tests/server/static/geometry.test.ts` - Geometry helpers

### 5. Integration Tests (Optional)
```bash
mkdir -p tests/integration
cat > tests/integration.test.ts << 'EOF'
import { buildActiveLegs } from 'src/state.js';
import { buildTrainLegs } from 'src/legwire.js';

describe('Server Integration', () => {
  it('builds complete train leg pipeline', () => {
    // Load fixtures
    const feed = JSON.parse(readFileSync('tests/fixtures/mock-feed-trips.json', 'utf8'));
    const staticData = JSON.parse(readFileSync('tests/fixtures/mock-static-data.json', 'utf8'));
    
    // Build active legs
    const activeLegs = buildActiveLegs(feed, staticData as any, undefined);
    expect(activeLegs.length).toBeGreaterThan(0);
    
    // Build train legs
    const trainLegs = buildTrainLegs(activeLegs, {} as any);
    expect(trainLegs.length).toBeGreaterThan(0);
    
    // Verify structure
    expect(trainLegs[0]).toHaveProperty('id');
    expect(trainLegs[0]).toHaveProperty('path');
  });
});
EOF
```

## Coverage Goals by Priority

### Critical (Must Test)
1. **kinematics.ts** - Motion math is shared and critical
2. **state.ts** - Segment matching is the most complex logic
3. **trackrecord.ts** - Business logic for reliability tracking

### High Priority
4. **legwire.ts** - Wire format correctness
5. **alerts.ts** - Alert classification heuristics

### Medium Priority
6. **arrivals.ts** - Arrivals board computation
7. **routing/graph.ts** - Graph construction

### Low Priority
8. **routing/plan.ts** - Journey planning (complex, well-tested algorithms)
9. **static/geometry.ts** - Geometry helpers

## Running in Production-like Environment

```bash
# Build and start containers
docker compose build
docker compose up -d

# Run tests inside server container
docker compose exec -T server sh -c 'cd /app && npm test'

# Check coverage
docker compose exec -T server sh -c 'cd /app && npm test -- --coverage --coverageThreshold={\"global\":{\"branches\":80,\"functions\":80,\"lines\":80,\"statements\":80}}'
```

## CI Pipeline Status

The CI workflow will:
1. ✅ Checkout code
2. ✅ Setup Node.js 22 with npm cache
3. ✅ Install dependencies via `npm ci`
4. ✅ Type check all workspaces
5. ✅ Run tests with coverage
6. ✅ Upload coverage to Codecov
7. ❌ Fail if coverage < 80%

## Test Quality Standards

- **Descriptive test names** - Clearly describe behavior
- **Edge case coverage** - Test boundary conditions
- **Integration tests** - Verify module interfaces
- **No flaky tests** - Deterministic, no timing dependencies
- **High code coverage** - 80% minimum, 100% for math functions

## Notes

- Tests use real TypeScript files (no compilation for server/shared)
- Mock data is realistic but simplified for speed
- All tests run in Node.js environment (no browser)
- Web UI tests would require Playwright/Cypress (out of scope)
- Server runs via `tsx` (runtime TypeScript execution)

## Maintenance

When adding new features:
1. Add unit tests alongside the implementation
2. Update coverage thresholds if needed
3. Add integration tests for new module interfaces
4. Run `npm test` before committing
