/**
 * Property 18: Vehicle Capacity Enforcement
 *
 * For any route with vehicle capacity C, student count must not exceed C.
 * The system rejects assignments that would breach capacity.
 *
 * **Validates: Requirements 9.4**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Determines whether a new student can be added to a route based on
 * the current student count and the vehicle's seating capacity.
 * Returns true only if adding one more student would not exceed capacity.
 */
function canAddStudent(currentStudentCount: number, vehicleCapacity: number): boolean {
  return currentStudentCount < vehicleCapacity;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Vehicle capacity between 1 and 100 (matching DB constraint) */
const capacityArb = fc.integer({ min: 1, max: 100 });

/** Student count between 0 and 150 (can exceed capacity to test rejection) */
const studentCountArb = fc.integer({ min: 0, max: 150 });

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 18: Vehicle Capacity Enforcement', () => {
  it('canAddStudent returns true iff currentStudentCount < vehicleCapacity', () => {
    fc.assert(
      fc.property(studentCountArb, capacityArb, (currentCount, capacity) => {
        const result = canAddStudent(currentCount, capacity);
        const expected = currentCount < capacity;
        expect(result).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects addition when student count equals capacity (at full capacity)', () => {
    fc.assert(
      fc.property(capacityArb, (capacity) => {
        const result = canAddStudent(capacity, capacity);
        expect(result).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects addition when student count exceeds capacity', () => {
    fc.assert(
      fc.property(
        capacityArb.chain((capacity) =>
          fc
            .integer({ min: capacity, max: 150 })
            .map((count) => ({ count, capacity }))
        ),
        ({ count, capacity }) => {
          const result = canAddStudent(count, capacity);
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('allows addition when student count is below capacity', () => {
    fc.assert(
      fc.property(
        capacityArb.chain((capacity) =>
          fc
            .integer({ min: 0, max: capacity - 1 })
            .map((count) => ({ count, capacity }))
        ),
        ({ count, capacity }) => {
          const result = canAddStudent(count, capacity);
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Property 16: Student Registration Requires Guardian
//
// Registration rejected if no guardians are provided.
//
// **Validates: Requirements 9.1**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

interface GuardianContact {
  full_name: string;
  phone_number: string;
}

interface StudentRegistration {
  full_name: string;
  grade: string;
  school_name: string;
  guardians: GuardianContact[];
}

interface RegistrationResult {
  accepted: boolean;
  error?: string;
}

/**
 * Validates student registration. Rejects if no guardians are provided.
 */
function validateStudentRegistration(registration: StudentRegistration): RegistrationResult {
  if (registration.guardians.length === 0) {
    return { accepted: false, error: 'At least one guardian is required' };
  }
  return { accepted: true };
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const guardianContactArb: fc.Arbitrary<GuardianContact> = fc.record({
  full_name: fc.string({ minLength: 1, maxLength: 50 }),
  phone_number: fc.stringMatching(/^\+27[0-9]{9}$/),
});

const studentRegWithGuardiansArb: fc.Arbitrary<StudentRegistration> = fc.record({
  full_name: fc.string({ minLength: 1, maxLength: 50 }),
  grade: fc.constantFrom('1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'),
  school_name: fc.string({ minLength: 1, maxLength: 100 }),
  guardians: fc.array(guardianContactArb, { minLength: 1, maxLength: 5 }),
});

const studentRegWithoutGuardiansArb: fc.Arbitrary<StudentRegistration> = fc.record({
  full_name: fc.string({ minLength: 1, maxLength: 50 }),
  grade: fc.constantFrom('1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'),
  school_name: fc.string({ minLength: 1, maxLength: 100 }),
  guardians: fc.constant([]),
});

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 16: Student Registration Requires Guardian', () => {
  it('registration rejected if no guardians provided', () => {
    fc.assert(
      fc.property(studentRegWithoutGuardiansArb, (registration) => {
        const result = validateStudentRegistration(registration);
        expect(result.accepted).toBe(false);
        expect(result.error).toBeDefined();
      }),
      { numRuns: 100 }
    );
  });

  it('registration accepted when at least one guardian provided', () => {
    fc.assert(
      fc.property(studentRegWithGuardiansArb, (registration) => {
        const result = validateStudentRegistration(registration);
        expect(result.accepted).toBe(true);
        expect(result.error).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 17: Student-Stop Route Consistency
//
// Stop's route_id must equal student's assigned_route_id.
// The system rejects any assignment violating this constraint.
//
// **Validates: Requirements 9.3**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Validates that a stop belongs to the student's assigned route.
 * Returns false (rejected) if stop_route_id !== student_route_id.
 */
function validateStopRouteConsistency(
  stopRouteId: string,
  studentAssignedRouteId: string
): boolean {
  return stopRouteId === studentAssignedRouteId;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 17: Student-Stop Route Consistency', () => {
  it('rejects assignment when stop route_id differs from student assigned_route_id', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (stopRouteId, studentRouteId) => {
        fc.pre(stopRouteId !== studentRouteId);
        const result = validateStopRouteConsistency(stopRouteId, studentRouteId);
        expect(result).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('accepts assignment when stop route_id equals student assigned_route_id', () => {
    fc.assert(
      fc.property(fc.uuid(), (routeId) => {
        const result = validateStopRouteConsistency(routeId, routeId);
        expect(result).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('consistency check is deterministic', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (stopRouteId, studentRouteId) => {
        const result1 = validateStopRouteConsistency(stopRouteId, studentRouteId);
        const result2 = validateStopRouteConsistency(stopRouteId, studentRouteId);
        expect(result1).toBe(result2);
      }),
      { numRuns: 100 }
    );
  });
});
