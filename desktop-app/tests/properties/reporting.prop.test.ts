/**
 * Property 23: Attendance Rate Calculation
 *
 * attendance_rate = count(boarded) / total_expected_trips for a student in a month.
 *
 * **Validates: Requirements 11.2**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Types ────────────────────────────────────────────────────────────────────

type AttendanceStatus = 'boarded' | 'absent' | 'dropped_off';

interface AttendanceRecord {
  student_id: string;
  status: AttendanceStatus;
  trip_date: string;
}

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Calculates the attendance rate for a student in a given month.
 * attendance_rate = count(boarded) / total_expected_trips
 */
function calculateAttendanceRate(
  records: AttendanceRecord[],
  totalExpectedTrips: number
): number {
  if (totalExpectedTrips <= 0) return 0;
  const boardedCount = records.filter((r) => r.status === 'boarded').length;
  return boardedCount / totalExpectedTrips;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const statusArb = fc.constantFrom(
  'boarded' as const,
  'absent' as const,
  'dropped_off' as const
);

const attendanceRecordArb = fc.record({
  student_id: fc.constant('student-1'),
  status: statusArb,
  trip_date: fc.constant('2025-06-01'),
});

const totalExpectedTripsArb = fc.integer({ min: 1, max: 100 });

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 23: Attendance Rate Calculation', () => {
  it('attendance rate equals boarded_count / total_expected_trips', () => {
    fc.assert(
      fc.property(
        fc.array(attendanceRecordArb, { minLength: 0, maxLength: 60 }),
        totalExpectedTripsArb,
        (records, totalExpected) => {
          const rate = calculateAttendanceRate(records, totalExpected);
          const boardedCount = records.filter(
            (r) => r.status === 'boarded'
          ).length;
          const expectedRate = boardedCount / totalExpected;

          expect(rate).toBeCloseTo(expectedRate, 10);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('attendance rate is between 0 and 1 when records <= expected', () => {
    fc.assert(
      fc.property(
        totalExpectedTripsArb.chain((total) =>
          fc
            .array(attendanceRecordArb, { minLength: 0, maxLength: total })
            .map((records) => ({ records, total }))
        ),
        ({ records, total }) => {
          const rate = calculateAttendanceRate(records, total);
          expect(rate).toBeGreaterThanOrEqual(0);
          expect(rate).toBeLessThanOrEqual(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rate is 0 when no records have boarded status', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            student_id: fc.constant('student-1'),
            status: fc.constantFrom('absent' as const, 'dropped_off' as const),
            trip_date: fc.constant('2025-06-01'),
          }),
          { minLength: 0, maxLength: 30 }
        ),
        totalExpectedTripsArb,
        (records, totalExpected) => {
          const rate = calculateAttendanceRate(records, totalExpected);
          expect(rate).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rate equals 1 when all expected trips are boarded', () => {
    fc.assert(
      fc.property(totalExpectedTripsArb, (totalExpected) => {
        const records: AttendanceRecord[] = Array.from(
          { length: totalExpected },
          (_, i) => ({
            student_id: 'student-1',
            status: 'boarded' as const,
            trip_date: `2025-06-${String(i + 1).padStart(2, '0')}`,
          })
        );
        const rate = calculateAttendanceRate(records, totalExpected);
        expect(rate).toBeCloseTo(1, 10);
      }),
      { numRuns: 100 }
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Property 24: Revenue Report Correctness
//
// invoiced_total = sum(invoice.amount), collected_total = sum(payment.amount),
// outstanding = invoiced_total - collected_total.
//
// **Validates: Requirements 11.3**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Types ────────────────────────────────────────────────────────────────────

interface InvoiceEntry {
  id: string;
  amount: number;
}

interface PaymentEntry {
  id: string;
  invoice_id: string;
  amount: number;
}

interface RevenueReport {
  invoiced_total: number;
  collected_total: number;
  outstanding: number;
}

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Computes revenue report totals from a set of invoices and payments.
 * The arithmetic invariant must hold:
 *   outstanding = invoiced_total - collected_total
 */
function computeRevenueReport(
  invoices: InvoiceEntry[],
  payments: PaymentEntry[]
): RevenueReport {
  const invoiced_total = invoices.reduce((sum, inv) => sum + inv.amount, 0);
  const collected_total = payments.reduce((sum, pay) => sum + pay.amount, 0);
  const outstanding = invoiced_total - collected_total;

  return {
    invoiced_total: Number(invoiced_total.toFixed(2)),
    collected_total: Number(collected_total.toFixed(2)),
    outstanding: Number(outstanding.toFixed(2)),
  };
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Invoice amounts: R50 to R10,000 (integer cents to avoid FP issues) */
const invoiceEntryArb = fc.record({
  id: fc.uuid(),
  amount: fc
    .integer({ min: 5000, max: 1000000 })
    .map((cents) => Number((cents / 100).toFixed(2))),
});

/** Payment amounts: R10 to R10,000 */
const paymentEntryArb = (invoiceIds: string[]) =>
  fc.record({
    id: fc.uuid(),
    invoice_id:
      invoiceIds.length > 0
        ? fc.constantFrom(...invoiceIds)
        : fc.constant('no-invoice'),
    amount: fc
      .integer({ min: 1000, max: 1000000 })
      .map((cents) => Number((cents / 100).toFixed(2))),
  });

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 24: Revenue Report Correctness', () => {
  it('outstanding = invoiced_total - collected_total (arithmetic invariant)', () => {
    fc.assert(
      fc.property(
        fc.array(invoiceEntryArb, { minLength: 1, maxLength: 30 }).chain(
          (invoices) => {
            const ids = invoices.map((i) => i.id);
            return fc
              .array(paymentEntryArb(ids), { minLength: 0, maxLength: 30 })
              .map((payments) => ({ invoices, payments }));
          }
        ),
        ({ invoices, payments }) => {
          const report = computeRevenueReport(invoices, payments);

          expect(report.outstanding).toBeCloseTo(
            report.invoiced_total - report.collected_total,
            2
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('invoiced_total equals sum of all invoice amounts', () => {
    fc.assert(
      fc.property(
        fc.array(invoiceEntryArb, { minLength: 1, maxLength: 30 }),
        (invoices) => {
          const report = computeRevenueReport(invoices, []);
          const expectedTotal = invoices.reduce((sum, inv) => sum + inv.amount, 0);

          expect(report.invoiced_total).toBeCloseTo(expectedTotal, 2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('collected_total equals sum of all payment amounts', () => {
    fc.assert(
      fc.property(
        fc.array(invoiceEntryArb, { minLength: 1, maxLength: 20 }).chain(
          (invoices) => {
            const ids = invoices.map((i) => i.id);
            return fc
              .array(paymentEntryArb(ids), { minLength: 1, maxLength: 20 })
              .map((payments) => ({ invoices, payments }));
          }
        ),
        ({ invoices, payments }) => {
          const report = computeRevenueReport(invoices, payments);
          const expectedCollected = payments.reduce(
            (sum, pay) => sum + pay.amount,
            0
          );

          expect(report.collected_total).toBeCloseTo(expectedCollected, 2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('outstanding equals invoiced_total when no payments exist', () => {
    fc.assert(
      fc.property(
        fc.array(invoiceEntryArb, { minLength: 1, maxLength: 30 }),
        (invoices) => {
          const report = computeRevenueReport(invoices, []);

          expect(report.outstanding).toBeCloseTo(report.invoiced_total, 2);
          expect(report.collected_total).toBeCloseTo(0, 2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
