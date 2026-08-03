/**
 * Property 19: Invoice Amount Matches Route Fee
 *
 * For any active student on a route with monthly_fee F, the generated
 * invoice amount equals F.
 *
 * **Validates: Requirements 10.1**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Route {
  id: string;
  monthly_fee: number; // NUMERIC(10,2)
}

interface Student {
  id: string;
  full_name: string;
  status: 'active' | 'suspended' | 'removed';
  assigned_route_id: string;
}

interface Invoice {
  student_id: string;
  amount: number;
  billing_month: string;
}

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Generates monthly invoices for active students assigned to a route.
 * Each invoice amount equals the route's monthly_fee.
 */
function generateMonthlyInvoices(
  students: Student[],
  route: Route,
  billingMonth: string // YYYY-MM-DD (first of month)
): Invoice[] {
  return students
    .filter(
      (s) => s.status === 'active' && s.assigned_route_id === route.id
    )
    .map((student) => ({
      student_id: student.id,
      amount: route.monthly_fee,
      billing_month: billingMonth,
    }));
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/**
 * Generate a fee between 0.01 and 99999.99 with exactly 2 decimal places.
 * Use integer math to avoid floating-point precision issues.
 */
const feeArb = fc
  .integer({ min: 1, max: 9999999 }) // cents: 0.01 to 99999.99
  .map((cents) => Number((cents / 100).toFixed(2)));

const routeArb = fc.record({
  id: fc.uuid(),
  monthly_fee: feeArb,
});

const studentStatusArb = fc.constantFrom(
  'active' as const,
  'suspended' as const,
  'removed' as const
);

function studentArb(routeId: string): fc.Arbitrary<Student> {
  return fc.record({
    id: fc.uuid(),
    full_name: fc.string({ minLength: 1, maxLength: 50 }),
    status: studentStatusArb,
    assigned_route_id: fc.constant(routeId),
  });
}

const billingMonthArb = fc
  .record({
    year: fc.integer({ min: 2024, max: 2030 }),
    month: fc.integer({ min: 1, max: 12 }),
  })
  .map(({ year, month }) => `${year}-${String(month).padStart(2, '0')}-01`);

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 19: Invoice Amount Matches Route Fee', () => {
  it('every generated invoice amount equals the route monthly_fee exactly', () => {
    fc.assert(
      fc.property(
        routeArb.chain((route) =>
          fc
            .array(studentArb(route.id), { minLength: 1, maxLength: 20 })
            .map((students) => ({ route, students }))
        ),
        billingMonthArb,
        ({ route, students }, billingMonth) => {
          const invoices = generateMonthlyInvoices(students, route, billingMonth);

          for (const invoice of invoices) {
            expect(invoice.amount).toBe(route.monthly_fee);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('only active students get invoices', () => {
    fc.assert(
      fc.property(
        routeArb.chain((route) =>
          fc
            .array(studentArb(route.id), { minLength: 1, maxLength: 20 })
            .map((students) => ({ route, students }))
        ),
        billingMonthArb,
        ({ route, students }, billingMonth) => {
          const invoices = generateMonthlyInvoices(students, route, billingMonth);
          const activeStudents = students.filter(
            (s) => s.status === 'active' && s.assigned_route_id === route.id
          );

          expect(invoices.length).toBe(activeStudents.length);

          const invoicedIds = new Set(invoices.map((i) => i.student_id));
          for (const student of activeStudents) {
            expect(invoicedIds.has(student.id)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('suspended or removed students do not receive invoices', () => {
    fc.assert(
      fc.property(
        routeArb.chain((route) =>
          fc
            .array(studentArb(route.id), { minLength: 1, maxLength: 20 })
            .map((students) => ({ route, students }))
        ),
        billingMonthArb,
        ({ route, students }, billingMonth) => {
          const invoices = generateMonthlyInvoices(students, route, billingMonth);
          const invoicedIds = new Set(invoices.map((i) => i.student_id));
          const inactiveStudents = students.filter((s) => s.status !== 'active');

          for (const student of inactiveStudents) {
            expect(invoicedIds.has(student.id)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Property 20: Payment Updates Invoice Status
//
// For any invoice with amount A that receives payments totalling >= A,
// status transitions to 'paid'.
//
// **Validates: Requirements 10.4**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Computes the invoice status based on the invoice amount and total paid.
 * Returns 'paid' when total payments meet or exceed the invoice amount,
 * otherwise returns 'pending'.
 */
function computeInvoiceStatus(invoiceAmount: number, totalPaid: number): 'pending' | 'paid' {
  return totalPaid >= invoiceAmount ? 'paid' : 'pending';
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Invoice amount between R10.00 and R99,999.99 (integer cents for precision) */
const invoiceAmountArb = fc
  .integer({ min: 1000, max: 9999999 }) // cents
  .map((cents) => Number((cents / 100).toFixed(2)));

/** Payment total - can be less, equal, or more than invoice amount */
const totalPaidArb = fc
  .integer({ min: 0, max: 12000000 }) // cents: 0 to R120,000
  .map((cents) => Number((cents / 100).toFixed(2)));

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 20: Payment Updates Invoice Status', () => {
  it('status is "paid" when totalPaid >= invoiceAmount', () => {
    fc.assert(
      fc.property(
        invoiceAmountArb.chain((amount) =>
          fc
            .integer({ min: Math.round(amount * 100), max: Math.round(amount * 100) + 5000000 })
            .map((paidCents) => ({
              amount,
              totalPaid: Number((paidCents / 100).toFixed(2)),
            }))
        ),
        ({ amount, totalPaid }) => {
          const status = computeInvoiceStatus(amount, totalPaid);
          expect(status).toBe('paid');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('status is "pending" when totalPaid < invoiceAmount', () => {
    fc.assert(
      fc.property(
        invoiceAmountArb.chain((amount) =>
          fc
            .integer({ min: 0, max: Math.max(0, Math.round(amount * 100) - 1) })
            .map((paidCents) => ({
              amount,
              totalPaid: Number((paidCents / 100).toFixed(2)),
            }))
        ),
        ({ amount, totalPaid }) => {
          const status = computeInvoiceStatus(amount, totalPaid);
          expect(status).toBe('pending');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('status is "paid" when exact payment matches invoice amount', () => {
    fc.assert(
      fc.property(invoiceAmountArb, (amount) => {
        const status = computeInvoiceStatus(amount, amount);
        expect(status).toBe('paid');
      }),
      { numRuns: 100 }
    );
  });

  it('computeInvoiceStatus matches the expected logic for all inputs', () => {
    fc.assert(
      fc.property(invoiceAmountArb, totalPaidArb, (amount, totalPaid) => {
        const status = computeInvoiceStatus(amount, totalPaid);
        const expected = totalPaid >= amount ? 'paid' : 'pending';
        expect(status).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Property 21: Overdue Invoice Reminder at 14 Days
//
// Reminder sent iff invoice is unpaid and > 14 days past due_date.
//
// **Validates: Requirements 10.5**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Determines whether a payment reminder should be sent.
 * Reminder fires iff the invoice is unpaid and today > due_date + 14 days.
 */
function shouldSendReminder(
  invoiceStatus: 'pending' | 'paid' | 'overdue' | 'cancelled',
  dueDate: string,
  today: Date
): boolean {
  if (invoiceStatus === 'paid' || invoiceStatus === 'cancelled') {
    return false;
  }
  const due = new Date(dueDate);
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  return today.getTime() > due.getTime() + fourteenDaysMs;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const invoiceStatusArb2 = fc.constantFrom(
  'pending' as const,
  'paid' as const,
  'overdue' as const,
  'cancelled' as const
);

const todayArb2 = fc
  .integer({ min: 1700000000000, max: 1800000000000 })
  .map((ms) => {
    const d = new Date(ms);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  });

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 21: Overdue Invoice Reminder at 14 Days', () => {
  it('reminder sent when unpaid and > 14 days past due', () => {
    fc.assert(
      fc.property(
        todayArb2.chain((today) =>
          fc.integer({ min: 15, max: 365 }).map((daysOverdue) => {
            const dueDate = new Date(today.getTime() - daysOverdue * 24 * 60 * 60 * 1000);
            return { today, dueDate: dueDate.toISOString().split('T')[0] };
          })
        ),
        fc.constantFrom('pending' as const, 'overdue' as const),
        ({ today, dueDate }, status) => {
          const result = shouldSendReminder(status, dueDate, today);
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no reminder when invoice is paid', () => {
    fc.assert(
      fc.property(
        todayArb2.chain((today) =>
          fc.integer({ min: 15, max: 365 }).map((daysOverdue) => {
            const dueDate = new Date(today.getTime() - daysOverdue * 24 * 60 * 60 * 1000);
            return { today, dueDate: dueDate.toISOString().split('T')[0] };
          })
        ),
        ({ today, dueDate }) => {
          const result = shouldSendReminder('paid', dueDate, today);
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no reminder when within 14 days of due date', () => {
    fc.assert(
      fc.property(
        todayArb2.chain((today) =>
          fc.integer({ min: 0, max: 14 }).map((daysOverdue) => {
            const dueDate = new Date(today.getTime() - daysOverdue * 24 * 60 * 60 * 1000);
            return { today, dueDate: dueDate.toISOString().split('T')[0] };
          })
        ),
        ({ today, dueDate }) => {
          const result = shouldSendReminder('pending', dueDate, today);
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 22: Overdue Invoice Flagging at 30 Days
//
// Student flagged iff invoice unpaid and > 30 days past due_date.
//
// **Validates: Requirements 10.6**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

interface FlaggingResult {
  studentFlagged: boolean;
  operatorNotified: boolean;
}

/**
 * Determines whether a student account should be flagged and operator notified.
 * Flagging occurs iff invoice is unpaid and > 30 days past due.
 */
function shouldFlagStudent(
  invoiceStatus: 'pending' | 'paid' | 'overdue' | 'cancelled',
  dueDate: string,
  today: Date
): FlaggingResult {
  if (invoiceStatus === 'paid' || invoiceStatus === 'cancelled') {
    return { studentFlagged: false, operatorNotified: false };
  }
  const due = new Date(dueDate);
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const shouldFlag = today.getTime() > due.getTime() + thirtyDaysMs;

  return { studentFlagged: shouldFlag, operatorNotified: shouldFlag };
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 22: Overdue Invoice Flagging at 30 Days', () => {
  it('student flagged when unpaid and > 30 days past due', () => {
    fc.assert(
      fc.property(
        todayArb2.chain((today) =>
          fc.integer({ min: 31, max: 365 }).map((daysOverdue) => {
            const dueDate = new Date(today.getTime() - daysOverdue * 24 * 60 * 60 * 1000);
            return { today, dueDate: dueDate.toISOString().split('T')[0] };
          })
        ),
        fc.constantFrom('pending' as const, 'overdue' as const),
        ({ today, dueDate }, status) => {
          const result = shouldFlagStudent(status, dueDate, today);
          expect(result.studentFlagged).toBe(true);
          expect(result.operatorNotified).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('student not flagged when paid', () => {
    fc.assert(
      fc.property(
        todayArb2.chain((today) =>
          fc.integer({ min: 31, max: 365 }).map((daysOverdue) => {
            const dueDate = new Date(today.getTime() - daysOverdue * 24 * 60 * 60 * 1000);
            return { today, dueDate: dueDate.toISOString().split('T')[0] };
          })
        ),
        ({ today, dueDate }) => {
          const result = shouldFlagStudent('paid', dueDate, today);
          expect(result.studentFlagged).toBe(false);
          expect(result.operatorNotified).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('student not flagged when within 30 days of due date', () => {
    fc.assert(
      fc.property(
        todayArb2.chain((today) =>
          fc.integer({ min: 0, max: 30 }).map((daysOverdue) => {
            const dueDate = new Date(today.getTime() - daysOverdue * 24 * 60 * 60 * 1000);
            return { today, dueDate: dueDate.toISOString().split('T')[0] };
          })
        ),
        ({ today, dueDate }) => {
          const result = shouldFlagStudent('pending', dueDate, today);
          expect(result.studentFlagged).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
