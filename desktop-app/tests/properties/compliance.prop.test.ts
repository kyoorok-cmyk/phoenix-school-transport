/**
 * Property 4: Vehicle Compliance Blocks Assignment
 *
 * For any vehicle with expired compliance_certificate_expiry (< today),
 * the system rejects assignment to active routes.
 *
 * **Validates: Requirements 3.4**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Determines whether a vehicle can be assigned to an active route
 * based on its compliance certificate expiry date.
 * Returns true only if the expiry date is today or in the future.
 */
function canAssignVehicle(complianceExpiry: string, today: Date): boolean {
  return new Date(complianceExpiry) >= today;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Generate a fixed "today" date at midnight UTC (date-level comparison) */
const todayArb = fc
  .integer({ min: 1700000000000, max: 1800000000000 }) // ~2023-2027
  .map((ms) => {
    // Normalize to midnight UTC to match YYYY-MM-DD date string parsing behavior
    const d = new Date(ms);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  });

/** Generate a past expiry date relative to a given "today" */
function pastExpiryArb(today: Date): fc.Arbitrary<string> {
  const todayMs = today.getTime();
  // Between 1 day and 3 years in the past
  return fc
    .integer({ min: 1, max: 365 * 3 })
    .map((daysAgo) => {
      const pastDate = new Date(todayMs - daysAgo * 24 * 60 * 60 * 1000);
      return pastDate.toISOString().split('T')[0]; // YYYY-MM-DD
    });
}

/** Generate a future or today expiry date relative to a given "today" */
function futureOrTodayExpiryArb(today: Date): fc.Arbitrary<string> {
  const todayMs = today.getTime();
  // Between 0 days (today) and 3 years in the future
  return fc
    .integer({ min: 0, max: 365 * 3 })
    .map((daysAhead) => {
      const futureDate = new Date(todayMs + daysAhead * 24 * 60 * 60 * 1000);
      return futureDate.toISOString().split('T')[0]; // YYYY-MM-DD
    });
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 4: Vehicle Compliance Blocks Assignment', () => {
  it('rejects assignment when compliance expiry is in the past (before today)', () => {
    fc.assert(
      fc.property(
        todayArb.chain((today) =>
          pastExpiryArb(today).map((expiry) => ({ today, expiry }))
        ),
        ({ today, expiry }) => {
          const result = canAssignVehicle(expiry, today);
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('allows assignment when compliance expiry is today or in the future', () => {
    fc.assert(
      fc.property(
        todayArb.chain((today) =>
          futureOrTodayExpiryArb(today).map((expiry) => ({ today, expiry }))
        ),
        ({ today, expiry }) => {
          const result = canAssignVehicle(expiry, today);
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('canAssignVehicle returns false iff expiry < today, true iff expiry >= today', () => {
    fc.assert(
      fc.property(
        todayArb,
        fc.integer({ min: -365 * 3, max: 365 * 3 }),
        (today, dayOffset) => {
          const expiryMs = today.getTime() + dayOffset * 24 * 60 * 60 * 1000;
          const expiryDate = new Date(expiryMs);
          // Format as YYYY-MM-DD (same format used in database DATE columns)
          const expiryStr = expiryDate.toISOString().split('T')[0];

          const result = canAssignVehicle(expiryStr, today);

          // new Date("YYYY-MM-DD") parses as midnight UTC, today is also midnight UTC
          const parsedExpiry = new Date(expiryStr);
          const expectedResult = parsedExpiry >= today;
          expect(result).toBe(expectedResult);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Property 5: Vehicle Deletion Protection During Active Trip
//
// For any vehicle currently assigned to a trip with status 'in_progress',
// the system shall reject deletion of that vehicle record.
//
// **Validates: Requirements 3.5**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Determines whether a vehicle can be deleted.
 * Returns false if the vehicle has an active (in_progress) trip.
 */
function canDeleteVehicle(hasActiveTrip: boolean): boolean {
  return !hasActiveTrip;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 5: Vehicle Deletion Protection During Active Trip', () => {
  it('vehicle with in_progress trip cannot be deleted', () => {
    fc.assert(
      fc.property(fc.constant(true), (hasActiveTrip) => {
        const result = canDeleteVehicle(hasActiveTrip);
        expect(result).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('vehicle without active trip can be deleted', () => {
    fc.assert(
      fc.property(fc.constant(false), (hasActiveTrip) => {
        const result = canDeleteVehicle(hasActiveTrip);
        expect(result).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('canDeleteVehicle returns true iff hasActiveTrip is false', () => {
    fc.assert(
      fc.property(fc.boolean(), (hasActiveTrip) => {
        const result = canDeleteVehicle(hasActiveTrip);
        expect(result).toBe(!hasActiveTrip);
      }),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 6: Compliance Expiry Notification Threshold
//
// Alert fires iff expiry is between today and today + 30 days (inclusive).
// No alert for expiry > 30 days away or already expired.
//
// **Validates: Requirements 3.3**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Determines whether a compliance expiry alert should fire.
 * Alert fires iff expiry date is between today and today+30 days (inclusive).
 */
function shouldAlertExpiry(expiryDate: string, today: Date): boolean {
  const expiry = new Date(expiryDate);
  const todayMs = today.getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const thirtyDaysFromNow = new Date(todayMs + thirtyDaysMs);

  return expiry >= today && expiry <= thirtyDaysFromNow;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 6: Compliance Expiry Notification Threshold', () => {
  it('alert fires when expiry is between today and today+30 days', () => {
    fc.assert(
      fc.property(
        todayArb.chain((today) =>
          fc.integer({ min: 0, max: 30 }).map((daysAhead) => {
            const expiryDate = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);
            return { today, expiryDate: expiryDate.toISOString().split('T')[0] };
          })
        ),
        ({ today, expiryDate }) => {
          const result = shouldAlertExpiry(expiryDate, today);
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no alert when expiry is more than 30 days away', () => {
    fc.assert(
      fc.property(
        todayArb.chain((today) =>
          fc.integer({ min: 31, max: 365 * 3 }).map((daysAhead) => {
            const expiryDate = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);
            return { today, expiryDate: expiryDate.toISOString().split('T')[0] };
          })
        ),
        ({ today, expiryDate }) => {
          const result = shouldAlertExpiry(expiryDate, today);
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no alert when expiry is in the past', () => {
    fc.assert(
      fc.property(
        todayArb.chain((today) =>
          fc.integer({ min: 1, max: 365 * 3 }).map((daysAgo) => {
            const expiryDate = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
            return { today, expiryDate: expiryDate.toISOString().split('T')[0] };
          })
        ),
        ({ today, expiryDate }) => {
          const result = shouldAlertExpiry(expiryDate, today);
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
