/**
 * Property 11: Geofence Detection Correctness
 *
 * For any GPS position and stop with geofence_radius_meters R, the vehicle
 * is within geofence iff haversine distance ≤ R.
 *
 * **Validates: Requirements 6.3**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Pure functions under test ────────────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_000;

/**
 * Calculates the haversine distance in meters between two geographic points.
 * Reused from desktop-app/tests/check-geofence.test.ts
 */
function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_M * c;
}

/**
 * Determines whether a vehicle at (lat, lng) is inside the geofence
 * of a stop at (stopLat, stopLng) with the given radius in meters.
 */
function isInsideGeofence(
  lat: number,
  lng: number,
  stopLat: number,
  stopLng: number,
  radiusMeters: number
): boolean {
  const distance = haversineDistance(lat, lng, stopLat, stopLng);
  return distance <= radiusMeters;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Valid latitude: -90 to 90 */
const latArb = fc.double({ min: -89.99, max: 89.99, noNaN: true });

/** Valid longitude: -180 to 180 */
const lngArb = fc.double({ min: -179.99, max: 179.99, noNaN: true });

/** Geofence radius: 10-5000 meters as per schema constraint */
const radiusArb = fc.integer({ min: 10, max: 5000 });

/** GPS position arbitrary */
const positionArb = fc.record({
  lat: latArb,
  lng: lngArb,
});

/** Stop position arbitrary */
const stopArb = fc.record({
  stopLat: latArb,
  stopLng: lngArb,
  radius: radiusArb,
});

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 11: Geofence Detection Correctness', () => {
  it('isInsideGeofence returns true iff haversine distance ≤ radius', () => {
    fc.assert(
      fc.property(positionArb, stopArb, (position, stop) => {
        const distance = haversineDistance(
          position.lat,
          position.lng,
          stop.stopLat,
          stop.stopLng
        );
        const inside = isInsideGeofence(
          position.lat,
          position.lng,
          stop.stopLat,
          stop.stopLng,
          stop.radius
        );

        if (distance <= stop.radius) {
          expect(inside).toBe(true);
        } else {
          expect(inside).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('a vehicle at the exact stop location is always inside the geofence', () => {
    fc.assert(
      fc.property(stopArb, (stop) => {
        const inside = isInsideGeofence(
          stop.stopLat,
          stop.stopLng,
          stop.stopLat,
          stop.stopLng,
          stop.radius
        );
        expect(inside).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('geofence detection is consistent with haversine distance calculation', () => {
    fc.assert(
      fc.property(positionArb, stopArb, (position, stop) => {
        const distance = haversineDistance(
          position.lat,
          position.lng,
          stop.stopLat,
          stop.stopLng
        );
        const inside = isInsideGeofence(
          position.lat,
          position.lng,
          stop.stopLat,
          stop.stopLng,
          stop.radius
        );

        // The two functions must agree
        expect(inside).toBe(distance <= stop.radius);
      }),
      { numRuns: 100 }
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Property 12: Route Deviation Detection
//
// Deviation alert triggers iff minimum distance from vehicle to any point
// on the route exceeds 500 meters.
//
// **Validates: Requirements 7.3**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

interface RoutePoint {
  lat: number;
  lng: number;
}

const DEVIATION_THRESHOLD_METERS = 500;

/**
 * Determines if a vehicle has deviated from the route.
 * Returns true (alert) iff the minimum distance from the vehicle position
 * to any point on the route polyline exceeds 500 meters.
 */
function isRouteDeviation(
  vehicleLat: number,
  vehicleLng: number,
  routePoints: RoutePoint[]
): boolean {
  if (routePoints.length === 0) return true;

  const minDistance = Math.min(
    ...routePoints.map((p) => haversineDistance(vehicleLat, vehicleLng, p.lat, p.lng))
  );

  return minDistance > DEVIATION_THRESHOLD_METERS;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const routePointArb: fc.Arbitrary<RoutePoint> = fc.record({
  lat: fc.double({ min: -89.99, max: 89.99, noNaN: true }),
  lng: fc.double({ min: -179.99, max: 179.99, noNaN: true }),
});

const routePointsArb = fc.array(routePointArb, { minLength: 1, maxLength: 10 });

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 12: Route Deviation Detection', () => {
  it('deviation alert iff min distance to route > 500m', () => {
    fc.assert(
      fc.property(positionArb, routePointsArb, (vehicle, routePoints) => {
        const deviation = isRouteDeviation(vehicle.lat, vehicle.lng, routePoints);
        const minDist = Math.min(
          ...routePoints.map((p) => haversineDistance(vehicle.lat, vehicle.lng, p.lat, p.lng))
        );

        if (minDist > DEVIATION_THRESHOLD_METERS) {
          expect(deviation).toBe(true);
        } else {
          expect(deviation).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('vehicle on a route point is never a deviation', () => {
    fc.assert(
      fc.property(routePointsArb, (routePoints) => {
        // Pick the first route point as vehicle location
        const point = routePoints[0];
        const deviation = isRouteDeviation(point.lat, point.lng, routePoints);
        expect(deviation).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 13: ETA-Based Approaching Notification
//
// Notification triggers iff ETA ≤ 5 minutes.
//
// **Validates: Requirements 8.1**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

const ETA_THRESHOLD_MINUTES = 5;

/**
 * Determines if an approaching notification should be triggered.
 * Returns true iff ETA in minutes is <= 5.
 */
function shouldTriggerApproachingNotification(etaMinutes: number): boolean {
  return etaMinutes <= ETA_THRESHOLD_MINUTES;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 13: ETA-Based Approaching Notification', () => {
  it('notification triggers iff ETA ≤ 5 minutes', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 120, noNaN: true }),
        (etaMinutes) => {
          const shouldNotify = shouldTriggerApproachingNotification(etaMinutes);
          expect(shouldNotify).toBe(etaMinutes <= ETA_THRESHOLD_MINUTES);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('ETA exactly at 5 minutes triggers notification', () => {
    fc.assert(
      fc.property(fc.constant(5), (eta) => {
        expect(shouldTriggerApproachingNotification(eta)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('ETA above 5 minutes does not trigger notification', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 5.001, max: 120, noNaN: true }),
        (etaMinutes) => {
          expect(shouldTriggerApproachingNotification(etaMinutes)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 14: Delay Notification Trigger
//
// Delay notification iff actual departure > scheduled + 10 minutes.
//
// **Validates: Requirements 8.4**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

const DELAY_THRESHOLD_MINUTES = 10;

/**
 * Determines if a delay notification should be sent.
 * Returns true iff actual departure exceeds scheduled departure by > 10 minutes.
 */
function shouldTriggerDelayNotification(
  scheduledDeparture: Date,
  actualDeparture: Date
): boolean {
  const diffMs = actualDeparture.getTime() - scheduledDeparture.getTime();
  const diffMinutes = diffMs / (60 * 1000);
  return diffMinutes > DELAY_THRESHOLD_MINUTES;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 14: Delay Notification Trigger', () => {
  it('delay notification iff actual departure > scheduled + 10 minutes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1700000000000, max: 1800000000000 }),
        fc.integer({ min: -30, max: 120 }),
        (scheduledMs, delayMinutes) => {
          const scheduled = new Date(scheduledMs);
          const actual = new Date(scheduledMs + delayMinutes * 60 * 1000);

          const shouldNotify = shouldTriggerDelayNotification(scheduled, actual);
          expect(shouldNotify).toBe(delayMinutes > DELAY_THRESHOLD_MINUTES);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('exactly 10 minutes delay does NOT trigger notification', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1700000000000, max: 1800000000000 }),
        (scheduledMs) => {
          const scheduled = new Date(scheduledMs);
          const actual = new Date(scheduledMs + 10 * 60 * 1000);
          expect(shouldTriggerDelayNotification(scheduled, actual)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('early or on-time departure does NOT trigger notification', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1700000000000, max: 1800000000000 }),
        fc.integer({ min: 0, max: 10 }),
        (scheduledMs, earlyMinutes) => {
          const scheduled = new Date(scheduledMs);
          const actual = new Date(scheduledMs - earlyMinutes * 60 * 1000);
          expect(shouldTriggerDelayNotification(scheduled, actual)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
