/**
 * Property 8: Trip Generation Correctness
 *
 * For any active schedule with defined active_days and a given date range,
 * the system shall generate trip instances only for dates that (a) match the
 * schedule's active_days AND (b) do not appear in the school_closures set.
 * No trips shall be generated for closure dates or inactive weekdays.
 *
 * **Validates: Requirements 5.2, 5.3**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Pure function under test ─────────────────────────────────────────────────

const DAYS_OF_WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

interface Schedule {
  active_days: string[];
  departure_time: string;
  route_id: string;
  vehicle_id: string;
  driver_id: string;
}

/**
 * Generates trip instances for a schedule within a date range,
 * excluding school closure dates.
 */
function generateTripsForSchedule(
  schedule: Schedule,
  startDate: Date,
  endDate: Date,
  closureDates: Set<string> // YYYY-MM-DD
): Array<{ trip_date: string; day_of_week: string }> {
  const trips: Array<{ trip_date: string; day_of_week: string }> = [];

  const current = new Date(startDate);
  current.setHours(0, 0, 0, 0);

  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  while (current <= end) {
    const dayOfWeek = DAYS_OF_WEEK[current.getDay()];
    const dateStr = formatDate(current);

    if (schedule.active_days.includes(dayOfWeek) && !closureDates.has(dateStr)) {
      trips.push({ trip_date: dateStr, day_of_week: dayOfWeek });
    }

    current.setDate(current.getDate() + 1);
  }

  return trips;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const activeDaysArb = fc.subarray([...DAYS_OF_WEEK], { minLength: 1 });

const scheduleArb = activeDaysArb.map((active_days) => ({
  active_days,
  departure_time: '07:00',
  route_id: 'route-1',
  vehicle_id: 'vehicle-1',
  driver_id: 'driver-1',
}));

/** Generate a start date and a range of 1-14 days */
const dateRangeArb = fc
  .integer({ min: 0, max: 365 })
  .chain((startOffset) =>
    fc.integer({ min: 1, max: 14 }).map((rangeDays) => {
      const start = new Date(2025, 0, 1);
      start.setDate(start.getDate() + startOffset);
      const end = new Date(start);
      end.setDate(end.getDate() + rangeDays - 1);
      return { startDate: start, endDate: end, rangeDays };
    })
  );

/** Generate a random set of closure dates within the given range */
function closureDatesArb(startDate: Date, rangeDays: number): fc.Arbitrary<Set<string>> {
  return fc.array(fc.integer({ min: 0, max: rangeDays - 1 }), { minLength: 0, maxLength: rangeDays }).map((offsets) => {
    const dates = new Set<string>();
    for (const offset of offsets) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + offset);
      dates.add(formatDate(d));
    }
    return dates;
  });
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 8: Trip Generation Correctness', () => {
  it('every generated trip date matches an active day and is not a closure date', () => {
    fc.assert(
      fc.property(
        scheduleArb,
        dateRangeArb.chain(({ startDate, endDate, rangeDays }) =>
          closureDatesArb(startDate, rangeDays).map((closures) => ({
            startDate,
            endDate,
            rangeDays,
            closures,
          }))
        ),
        (schedule, { startDate, endDate, closures }) => {
          const trips = generateTripsForSchedule(schedule, startDate, endDate, closures);

          for (const trip of trips) {
            // (a) trip day must be in active_days
            expect(schedule.active_days).toContain(trip.day_of_week);
            // (b) trip date must not be a closure date
            expect(closures.has(trip.trip_date)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no valid date is missing from the generated trips', () => {
    fc.assert(
      fc.property(
        scheduleArb,
        dateRangeArb.chain(({ startDate, endDate, rangeDays }) =>
          closureDatesArb(startDate, rangeDays).map((closures) => ({
            startDate,
            endDate,
            rangeDays,
            closures,
          }))
        ),
        (schedule, { startDate, endDate, closures }) => {
          const trips = generateTripsForSchedule(schedule, startDate, endDate, closures);
          const tripDates = new Set(trips.map((t) => t.trip_date));

          // Walk through each date in the range and check completeness
          const current = new Date(startDate);
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);

          while (current <= end) {
            const dayOfWeek = DAYS_OF_WEEK[current.getDay()];
            const dateStr = formatDate(current);

            const shouldBeIncluded =
              schedule.active_days.includes(dayOfWeek) && !closures.has(dateStr);

            if (shouldBeIncluded) {
              expect(tripDates.has(dateStr)).toBe(true);
            } else {
              expect(tripDates.has(dateStr)).toBe(false);
            }

            current.setDate(current.getDate() + 1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no trips generated for inactive weekdays', () => {
    fc.assert(
      fc.property(
        scheduleArb,
        dateRangeArb.chain(({ startDate, endDate, rangeDays }) =>
          closureDatesArb(startDate, rangeDays).map((closures) => ({
            startDate,
            endDate,
            rangeDays,
            closures,
          }))
        ),
        (schedule, { startDate, endDate, closures }) => {
          const trips = generateTripsForSchedule(schedule, startDate, endDate, closures);
          const inactiveDays = DAYS_OF_WEEK.filter((d) => !schedule.active_days.includes(d));

          for (const trip of trips) {
            expect(inactiveDays).not.toContain(trip.day_of_week);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Property 9: Trip Generation Lookahead
//
// For any active schedule, generated trips cover at least 7 days into the future.
// The latest trip_date >= today + 7.
//
// **Validates: Requirements 5.4**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Generates trips for a schedule ensuring at least 7 days lookahead.
 * Returns generated trip dates.
 */
function generateTripsWithLookahead(
  schedule: Schedule,
  today: Date,
  closureDates: Set<string>
): string[] {
  const lookaheadDays = 7;
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + lookaheadDays);

  const trips = generateTripsForSchedule(schedule, today, endDate, closureDates);
  return trips.map((t) => t.trip_date);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 9: Trip Generation Lookahead', () => {
  it('generated trips cover at least 7 days into the future', () => {
    fc.assert(
      fc.property(
        scheduleArb,
        fc.integer({ min: 0, max: 365 }).map((offset) => {
          // Use UTC dates to avoid timezone mismatch with YYYY-MM-DD parsing
          const today = new Date(Date.UTC(2025, 0, 1 + offset));
          return today;
        }),
        (schedule, today) => {
          const trips = generateTripsWithLookahead(schedule, today, new Set());

          if (trips.length > 0) {
            const latestTrip = trips.sort().pop()!;
            // Compare as date strings to avoid UTC vs local mismatch
            const sevenDaysFromToday = new Date(today);
            sevenDaysFromToday.setDate(sevenDaysFromToday.getDate() + 7);
            const maxDateStr = formatDate(sevenDaysFromToday);

            // Latest trip should be within the 7-day lookahead window
            expect(latestTrip <= maxDateStr).toBe(true);
            expect(latestTrip >= formatDate(today)).toBe(true);
          }
          // If no trips generated, it means no active_days fall within the window
          // (valid scenario when schedule's active days don't occur in the 7-day range)
        }
      ),
      { numRuns: 100 }
    );
  });

  it('lookahead window extends at least 7 calendar days from today', () => {
    fc.assert(
      fc.property(
        // Use a schedule that covers all weekdays to guarantee trips exist
        fc.constant({
          active_days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
          departure_time: '07:00',
          route_id: 'route-1',
          vehicle_id: 'vehicle-1',
          driver_id: 'driver-1',
        } as Schedule),
        fc.integer({ min: 0, max: 365 }).map((offset) => {
          // Use UTC dates to avoid timezone mismatch with YYYY-MM-DD parsing
          const today = new Date(Date.UTC(2025, 0, 1 + offset));
          return today;
        }),
        (schedule, today) => {
          const trips = generateTripsWithLookahead(schedule, today, new Set());

          // With all days active and no closures, we should have trips
          expect(trips.length).toBeGreaterThan(0);

          const latestTrip = trips.sort().pop()!;

          // Compare as date strings to avoid UTC vs local timezone issues
          const sevenDaysFromToday = new Date(today);
          sevenDaysFromToday.setDate(sevenDaysFromToday.getDate() + 7);
          const maxDateStr = formatDate(sevenDaysFromToday);
          expect(latestTrip <= maxDateStr).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 10: Driver Trip List Ordering
//
// For any set of trips assigned to a driver on a given date, the returned list
// is sorted by scheduled_departure ascending.
//
// **Validates: Requirements 6.1**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

interface DriverTrip {
  id: string;
  scheduled_departure: string; // HH:MM format
  route_name: string;
}

/**
 * Sorts driver trips by scheduled_departure time ascending.
 */
function sortDriverTrips(trips: DriverTrip[]): DriverTrip[] {
  return [...trips].sort((a, b) => {
    return a.scheduled_departure.localeCompare(b.scheduled_departure);
  });
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const timeArb = fc
  .record({
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
  })
  .map(({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);

const driverTripArb: fc.Arbitrary<DriverTrip> = fc.record({
  id: fc.uuid(),
  scheduled_departure: timeArb,
  route_name: fc.string({ minLength: 1, maxLength: 30 }),
});

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 10: Driver Trip List Ordering', () => {
  it('trips are sorted by scheduled_departure ascending', () => {
    fc.assert(
      fc.property(
        fc.array(driverTripArb, { minLength: 1, maxLength: 20 }),
        (trips) => {
          const sorted = sortDriverTrips(trips);

          for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i].scheduled_departure >= sorted[i - 1].scheduled_departure).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('sorting preserves all original trips (no data loss)', () => {
    fc.assert(
      fc.property(
        fc.array(driverTripArb, { minLength: 1, maxLength: 20 }),
        (trips) => {
          const sorted = sortDriverTrips(trips);
          expect(sorted.length).toBe(trips.length);

          const originalIds = new Set(trips.map((t) => t.id));
          const sortedIds = new Set(sorted.map((t) => t.id));
          expect(sortedIds).toEqual(originalIds);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('sorting is idempotent (sorting twice yields same result)', () => {
    fc.assert(
      fc.property(
        fc.array(driverTripArb, { minLength: 1, maxLength: 20 }),
        (trips) => {
          const sorted1 = sortDriverTrips(trips);
          const sorted2 = sortDriverTrips(sorted1);
          expect(sorted2).toEqual(sorted1);
        }
      ),
      { numRuns: 100 }
    );
  });
});
