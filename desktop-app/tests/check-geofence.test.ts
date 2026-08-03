/**
 * Unit tests for check-geofence Edge Function pure functions.
 *
 * Tests the haversineDistance, pointToSegmentDistance, and calculateEtaMinutes
 * functions that form the core logic of geofence detection, route deviation,
 * and ETA-based approaching notifications.
 *
 * Requirements: 6.3, 7.3, 8.1
 */
import { describe, it, expect } from 'vitest';

// ─── Re-implement pure functions for testing ──────────────────────────────────
// (These mirror the implementations in check-geofence/index.ts)

const EARTH_RADIUS_M = 6_371_000;

/**
 * Calculates the haversine distance in meters between two geographic points.
 */
export function haversineDistance(
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
 * Calculates the minimum distance from a point to a line segment.
 */
export function pointToSegmentDistance(
  pLat: number,
  pLng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const cosLat = Math.cos(toRad((aLat + bLat + pLat) / 3));

  const px = (pLng - aLng) * cosLat * (EARTH_RADIUS_M * Math.PI / 180);
  const py = (pLat - aLat) * (EARTH_RADIUS_M * Math.PI / 180);
  const bx = (bLng - aLng) * cosLat * (EARTH_RADIUS_M * Math.PI / 180);
  const by = (bLat - aLat) * (EARTH_RADIUS_M * Math.PI / 180);

  const segLenSq = bx * bx + by * by;

  if (segLenSq === 0) {
    return haversineDistance(pLat, pLng, aLat, aLng);
  }

  let t = (px * bx + py * by) / segLenSq;
  t = Math.max(0, Math.min(1, t));

  const nearestLat = aLat + t * (bLat - aLat);
  const nearestLng = aLng + t * (bLng - aLng);

  return haversineDistance(pLat, pLng, nearestLat, nearestLng);
}

/**
 * Calculates ETA in minutes given distance and speed.
 */
export function calculateEtaMinutes(distanceM: number, speedKmh: number): number {
  if (speedKmh <= 0) return Infinity;
  const speedMs = (speedKmh * 1000) / 3600;
  const timeSeconds = distanceM / speedMs;
  return timeSeconds / 60;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('haversineDistance', () => {
  it('returns 0 for the same point', () => {
    const dist = haversineDistance(-26.2041, 28.0473, -26.2041, 28.0473);
    expect(dist).toBe(0);
  });

  it('calculates distance between Johannesburg and Pretoria (~58 km)', () => {
    // Johannesburg: -26.2041, 28.0473
    // Pretoria: -25.7479, 28.2293
    const dist = haversineDistance(-26.2041, 28.0473, -25.7479, 28.2293);
    // Should be approximately 56-60 km
    expect(dist).toBeGreaterThan(50_000);
    expect(dist).toBeLessThan(65_000);
  });

  it('calculates a short distance (~100m) accurately', () => {
    // Two points approximately 100m apart in Johannesburg
    // 0.001 degrees latitude ≈ 111m
    const lat1 = -26.2041;
    const lng1 = 28.0473;
    const lat2 = -26.2041 + 0.0009; // ~100m north
    const lng2 = 28.0473;
    const dist = haversineDistance(lat1, lng1, lat2, lng2);
    expect(dist).toBeGreaterThan(90);
    expect(dist).toBeLessThan(110);
  });

  it('is symmetric (distance A→B equals B→A)', () => {
    const d1 = haversineDistance(-26.2041, 28.0473, -25.7479, 28.2293);
    const d2 = haversineDistance(-25.7479, 28.2293, -26.2041, 28.0473);
    expect(d1).toBeCloseTo(d2, 5);
  });

  it('handles antipodal points (maximum distance ~20,000 km)', () => {
    const dist = haversineDistance(0, 0, 0, 180);
    // Half circumference ≈ 20,015 km
    expect(dist).toBeGreaterThan(19_000_000);
    expect(dist).toBeLessThan(21_000_000);
  });

  it('handles points on the equator', () => {
    // 1 degree of longitude at equator ≈ 111.32 km
    const dist = haversineDistance(0, 0, 0, 1);
    expect(dist).toBeGreaterThan(110_000);
    expect(dist).toBeLessThan(112_000);
  });
});

describe('pointToSegmentDistance', () => {
  it('returns 0 when point is at segment start', () => {
    const dist = pointToSegmentDistance(
      -26.2041, 28.0473, // point
      -26.2041, 28.0473, // segment start (same as point)
      -26.2000, 28.0500  // segment end
    );
    expect(dist).toBeLessThan(1); // Should be essentially 0
  });

  it('returns 0 when point is at segment end', () => {
    const dist = pointToSegmentDistance(
      -26.2000, 28.0500, // point (same as segment end)
      -26.2041, 28.0473, // segment start
      -26.2000, 28.0500  // segment end
    );
    expect(dist).toBeLessThan(1);
  });

  it('returns distance to nearest endpoint when projection falls outside segment', () => {
    // Point is far beyond segment end
    const distToEnd = haversineDistance(-26.1900, 28.0600, -26.2000, 28.0500);
    const segDist = pointToSegmentDistance(
      -26.1900, 28.0600, // point (beyond segment)
      -26.2041, 28.0473, // segment start
      -26.2000, 28.0500  // segment end
    );
    // Should be close to the distance to the segment end
    expect(segDist).toBeLessThanOrEqual(distToEnd + 10);
  });

  it('returns smaller distance when point is closer to segment midpoint', () => {
    // Segment from A to B, point P perpendicular to midpoint
    const aLat = -26.2041, aLng = 28.0400;
    const bLat = -26.2041, bLng = 28.0600;
    // Point slightly north of the midpoint
    const pLat = -26.2031, pLng = 28.0500;

    const distToSegment = pointToSegmentDistance(pLat, pLng, aLat, aLng, bLat, bLng);
    const distToStart = haversineDistance(pLat, pLng, aLat, aLng);

    // Distance to segment should be less than distance to either endpoint
    expect(distToSegment).toBeLessThan(distToStart);
  });

  it('handles zero-length segment (returns distance to point)', () => {
    const dist = pointToSegmentDistance(
      -26.2000, 28.0500, // point
      -26.2041, 28.0473, // segment start
      -26.2041, 28.0473  // segment end (same as start)
    );
    const expected = haversineDistance(-26.2000, 28.0500, -26.2041, 28.0473);
    expect(dist).toBeCloseTo(expected, 0);
  });
});

describe('calculateEtaMinutes', () => {
  it('returns correct ETA for simple values', () => {
    // 1000m at 60 km/h = 1 minute
    const eta = calculateEtaMinutes(1000, 60);
    expect(eta).toBeCloseTo(1, 1);
  });

  it('returns Infinity when speed is 0', () => {
    const eta = calculateEtaMinutes(1000, 0);
    expect(eta).toBe(Infinity);
  });

  it('returns Infinity when speed is negative', () => {
    const eta = calculateEtaMinutes(1000, -10);
    expect(eta).toBe(Infinity);
  });

  it('returns 0 when distance is 0', () => {
    const eta = calculateEtaMinutes(0, 60);
    expect(eta).toBe(0);
  });

  it('calculates correctly for typical school bus speed (40 km/h, 2km distance)', () => {
    // 2000m at 40 km/h = 3 minutes
    const eta = calculateEtaMinutes(2000, 40);
    expect(eta).toBeCloseTo(3, 1);
  });

  it('calculates ETA ≤ 5 minutes correctly for threshold check', () => {
    // At 30 km/h, 5 minutes covers 2500m
    // So 2400m at 30 km/h should be < 5 min
    const eta = calculateEtaMinutes(2400, 30);
    expect(eta).toBeLessThan(5);

    // And 2600m at 30 km/h should be > 5 min
    const eta2 = calculateEtaMinutes(2600, 30);
    expect(eta2).toBeGreaterThan(5);
  });
});

describe('Geofence detection logic', () => {
  it('detects vehicle inside geofence when distance ≤ radius', () => {
    // Stop at Sandton City: -26.1076, 28.0567 with 100m radius
    const stopLat = -26.1076;
    const stopLng = 28.0567;
    const radius = 100;

    // Vehicle 50m away (within geofence)
    const vehicleLat = -26.1076 + 0.00045; // ~50m north
    const vehicleLng = 28.0567;

    const distance = haversineDistance(vehicleLat, vehicleLng, stopLat, stopLng);
    expect(distance).toBeLessThanOrEqual(radius);
  });

  it('detects vehicle outside geofence when distance > radius', () => {
    const stopLat = -26.1076;
    const stopLng = 28.0567;
    const radius = 100;

    // Vehicle 200m away (outside geofence)
    const vehicleLat = -26.1076 + 0.0018; // ~200m north
    const vehicleLng = 28.0567;

    const distance = haversineDistance(vehicleLat, vehicleLng, stopLat, stopLng);
    expect(distance).toBeGreaterThan(radius);
  });
});

describe('Route deviation detection logic', () => {
  it('detects deviation when vehicle is > 500m from route', () => {
    // Route segment: straight line along a road
    const aLat = -26.2041, aLng = 28.0400;
    const bLat = -26.2041, bLng = 28.0600;

    // Vehicle 600m north of the route segment
    const vehicleLat = -26.2041 + 0.0054; // ~600m north
    const vehicleLng = 28.0500;

    const dist = pointToSegmentDistance(vehicleLat, vehicleLng, aLat, aLng, bLat, bLng);
    expect(dist).toBeGreaterThan(500);
  });

  it('does not flag deviation when vehicle is close to route', () => {
    // Route segment
    const aLat = -26.2041, aLng = 28.0400;
    const bLat = -26.2041, bLng = 28.0600;

    // Vehicle 100m north of the route
    const vehicleLat = -26.2041 + 0.0009; // ~100m north
    const vehicleLng = 28.0500;

    const dist = pointToSegmentDistance(vehicleLat, vehicleLng, aLat, aLng, bLat, bLng);
    expect(dist).toBeLessThan(500);
  });
});
