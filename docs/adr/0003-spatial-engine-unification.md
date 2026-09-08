# 0003: Unify Spatial Intelligence into SpatialEngine

## Status
Accepted

## Context
Spatial operations in VigilOne were fractured across multiple shallow services: `DetectionZoneService` (motion filtering and exclusion masks), `SpatialAnalyticsService` (tripwires and loitering dwell calculation), `SpatialProjectionService` (FOV vision cones and floorplan event projections), `FloorplanService` (floorplan and camera placement persistence), and `SmartSearchService` (spatial ROI bounding box searches).

This caused duplicate computational geometry implementations (multiple ray-casting point-in-polygon copies), inconsistent coordinate types, unbounded in-memory track state that leaked memory during continuous multi-camera operation, fragile tripwire sign flips vulnerable to line jitter, and brittle loitering timers that reset on minor detector dropouts.

## Decision
We consolidate all 2D vector geometry, detection zone masking, tripwire line crossing evaluation, continuous dwell loitering, camera FOV vision cones, floorplan projection, and spatial motion searches into a single authoritative deep module: **`SpatialEngine`** (`src/services/spatial/engine/`).

1. **Strict Facade Isolation**:
   - All external consumers and backward-compatibility shims (`DetectionZoneService`, `SpatialAnalyticsService`, `SpatialProjectionService`, `FloorplanService`) must interact **exclusively** with public `SpatialEngine` facade methods. Submodules (`geometry.ts`, `trackStateLedger.ts`, `zoneEvaluator.ts`, `floorplanProjector.ts`) remain private internal implementation details.

2. **Rigorous Polygon-vs-BBox Intersection Semantics**:
   - In `geometry.ts`, distinguish between point containment (`isPointInPolygon`), center containment (`isBBoxCenterInPolygon`), full containment (`isBBoxContainedInPolygon`), and full intersection (`intersectsPolygonBBox`).
   - `intersectsPolygonBBox` implements complete topological intersection: checks if any bbox corner is inside the polygon, any polygon vertex is inside the bbox, or any polygon edge intersects any bbox edge.

3. **Three-State Tripwire Hysteresis with `ON_LINE` Epsilon Band**:
   - Line side classification uses three states: `SIDE_A` ($> +\epsilon$), `ON_LINE` ($[-\epsilon, +\epsilon]$), and `SIDE_B` ($< -\epsilon$).
   - A valid directional crossing requires traversing across the `ON_LINE` boundary buffer, preventing jitter when noise oscillates near the line.

4. **Loitering Observation-Loss Rule**:
   - Distinguish between explicit exit (`OBSERVED_OUTSIDE`) and temporary detector dropout (`TEMPORARILY_UNOBSERVED`).
   - An explicit observation outside the zone immediately resets the dwell timer.
   - If a target is temporarily unobserved for $\le \text{observationTimeoutMs}$ (default 2000ms), the dwell timer is preserved. Only if dropout exceeds the timeout is the track terminated and reset.

5. **Calibrated PTZ FOV with Fallback**:
   - `calculateFovCone` supports calibrated camera FOV profiles with smooth fallback to $\text{FOV}_{\text{eff}} = \max(10^\circ, \min(180^\circ, \text{FOV}_{\text{h}} / \text{zoom}))$.

6. **Bounded Track State Ledger**:
   - `TrackStateLedger` enforces bounded memory via TTL eviction (default 10 minutes), per-camera track caps (default 500), and global track caps (default 5000) using LRU replacement with observable telemetry counters.

7. **Exclusion Precedence**:
   - `EXCLUSION` zones evaluate first and have absolute veto over detections.
   - If `INCLUSION` zones exist, detections must intersect at least one.
   - If no inclusion zones exist, detections are permitted by default (`DEFAULT_ALLOW`).
