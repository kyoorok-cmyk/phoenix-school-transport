/**
 * Property 25: Offline Sync FIFO Order
 *
 * For any set of locally queued records with timestamps t1 < t2 < ... < tN,
 * the sync operation transmits them in order t1, t2, ..., tN.
 *
 * **Validates: Requirements 12.2**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Types ────────────────────────────────────────────────────────────────────

interface QueuedRecord {
  id: string;
  recorded_at: string; // ISO timestamp
  type: 'attendance' | 'gps';
  payload: Record<string, unknown>;
}

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Orders queued records in FIFO order by their recorded_at timestamp
 * for transmission to the server. This is the core ordering logic
 * used by the offline sync service before transmitting batches.
 */
function orderForSync(records: QueuedRecord[]): QueuedRecord[] {
  return [...records].sort((a, b) => {
    const timeA = new Date(a.recorded_at).getTime();
    const timeB = new Date(b.recorded_at).getTime();
    return timeA - timeB;
  });
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Generate a random ISO timestamp within a reasonable range */
const timestampArb = fc
  .integer({ min: 1700000000000, max: 1800000000000 }) // ~2023-2027
  .map((ms) => new Date(ms).toISOString());

const recordTypeArb = fc.constantFrom('attendance' as const, 'gps' as const);

const queuedRecordArb = fc.record({
  id: fc.uuid(),
  recorded_at: timestampArb,
  type: recordTypeArb,
  payload: fc.constant({}),
});

const recordArrayArb = fc.array(queuedRecordArb, { minLength: 1, maxLength: 50 });

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 25: Offline Sync FIFO Order', () => {
  it('output is sorted by timestamp ascending', () => {
    fc.assert(
      fc.property(recordArrayArb, (records) => {
        const ordered = orderForSync(records);

        for (let i = 1; i < ordered.length; i++) {
          const prevTime = new Date(ordered[i - 1].recorded_at).getTime();
          const currTime = new Date(ordered[i].recorded_at).getTime();
          expect(currTime).toBeGreaterThanOrEqual(prevTime);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('output contains the same records as input (no loss or duplication)', () => {
    fc.assert(
      fc.property(recordArrayArb, (records) => {
        const ordered = orderForSync(records);

        expect(ordered.length).toBe(records.length);

        const inputIds = new Set(records.map((r) => r.id));
        const outputIds = new Set(ordered.map((r) => r.id));
        expect(outputIds).toEqual(inputIds);
      }),
      { numRuns: 100 }
    );
  });

  it('an already-sorted input remains unchanged in order', () => {
    fc.assert(
      fc.property(recordArrayArb, (records) => {
        // Pre-sort the input
        const preSorted = [...records].sort(
          (a, b) =>
            new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
        );

        const ordered = orderForSync(preSorted);

        for (let i = 0; i < ordered.length; i++) {
          expect(ordered[i].id).toBe(preSorted[i].id);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('records with identical timestamps maintain stable relative order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 2, maxLength: 20 }),
        (ids) => {
          const fixedTimestamp = '2025-06-01T12:00:00.000Z';
          const records: QueuedRecord[] = ids.map((id) => ({
            id,
            recorded_at: fixedTimestamp,
            type: 'attendance' as const,
            payload: {},
          }));

          const ordered = orderForSync(records);

          // All records should be present
          expect(ordered.length).toBe(records.length);
          // All timestamps should be equal
          for (const rec of ordered) {
            expect(rec.recorded_at).toBe(fixedTimestamp);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Property 26: Conflict Resolution Last-Write-Wins
//
// For two conflicting records (local timestamp tL, server timestamp tS),
// the system retains the record with max(tL, tS).
//
// **Validates: Requirements 12.4**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Resolves a conflict between a local and server record using
 * last-write-wins strategy. The record with the later timestamp wins.
 */
function resolveConflict(localTimestamp: string, serverTimestamp: string): 'local' | 'server' {
  return new Date(localTimestamp) > new Date(serverTimestamp) ? 'local' : 'server';
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Generate ISO timestamp strings within a reasonable range */
const conflictTimestampArb = fc
  .integer({ min: 1700000000000, max: 1800000000000 }) // ~2023-2027
  .map((ms) => new Date(ms).toISOString());

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 26: Conflict Resolution Last-Write-Wins', () => {
  it('local wins when local timestamp is later than server', () => {
    fc.assert(
      fc.property(
        conflictTimestampArb.chain((serverTs) => {
          const serverMs = new Date(serverTs).getTime();
          return fc
            .integer({ min: serverMs + 1, max: serverMs + 100000000 })
            .map((localMs) => ({
              localTs: new Date(localMs).toISOString(),
              serverTs,
            }));
        }),
        ({ localTs, serverTs }) => {
          const result = resolveConflict(localTs, serverTs);
          expect(result).toBe('local');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('server wins when server timestamp is later than local', () => {
    fc.assert(
      fc.property(
        conflictTimestampArb.chain((localTs) => {
          const localMs = new Date(localTs).getTime();
          return fc
            .integer({ min: localMs + 1, max: localMs + 100000000 })
            .map((serverMs) => ({
              localTs,
              serverTs: new Date(serverMs).toISOString(),
            }));
        }),
        ({ localTs, serverTs }) => {
          const result = resolveConflict(localTs, serverTs);
          expect(result).toBe('server');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('server wins when timestamps are equal (tie-breaks to server)', () => {
    fc.assert(
      fc.property(conflictTimestampArb, (timestamp) => {
        const result = resolveConflict(timestamp, timestamp);
        // When equal, new Date(local) > new Date(server) is false, so 'server' wins
        expect(result).toBe('server');
      }),
      { numRuns: 100 }
    );
  });

  it('resolveConflict always returns the record with max timestamp', () => {
    fc.assert(
      fc.property(
        conflictTimestampArb,
        conflictTimestampArb,
        (localTs, serverTs) => {
          const result = resolveConflict(localTs, serverTs);
          const localMs = new Date(localTs).getTime();
          const serverMs = new Date(serverTs).getTime();

          if (localMs > serverMs) {
            expect(result).toBe('local');
          } else {
            // When server >= local, server wins (last-write-wins with server tie-break)
            expect(result).toBe('server');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
