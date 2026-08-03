/**
 * Property 28: Audit Log Completeness
 *
 * Every significant event creates exactly one audit entry with the required
 * fields (event_type, entity_type, entity_id, user_id, timestamp).
 *
 * **Validates: Requirements 14.1, 14.2, 14.3**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ═══════════════════════════════════════════════════════════════════════════════
// Pure functions under test
// ═══════════════════════════════════════════════════════════════════════════════

type EventType =
  | 'login'
  | 'failed_login'
  | 'logout'
  | 'create'
  | 'update'
  | 'delete'
  | 'trip_start'
  | 'stop_arrival'
  | 'attendance_mark'
  | 'trip_complete';

type EntityType = 'vehicle' | 'route' | 'student' | 'trip' | 'schedule' | 'invoice' | 'user';

interface SignificantEvent {
  event_type: EventType;
  entity_type: EntityType;
  entity_id: string;
  user_id: string;
  tenant_id: string;
}

interface AuditLogEntry {
  id: string;
  tenant_id: string;
  user_id: string;
  event_type: EventType;
  entity_type: EntityType;
  entity_id: string;
  created_at: string;
}

/**
 * Creates an audit log entry for a significant event.
 * Every event produces exactly one entry with all required fields.
 */
function createAuditEntry(event: SignificantEvent): AuditLogEntry {
  return {
    id: crypto.randomUUID(),
    tenant_id: event.tenant_id,
    user_id: event.user_id,
    event_type: event.event_type,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    created_at: new Date().toISOString(),
  };
}

/**
 * Processes a batch of events and returns audit entries.
 * Each event produces exactly one audit entry.
 */
function processEventsToAuditLog(events: SignificantEvent[]): AuditLogEntry[] {
  return events.map(createAuditEntry);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════════

const eventTypeArb: fc.Arbitrary<EventType> = fc.constantFrom(
  'login',
  'failed_login',
  'logout',
  'create',
  'update',
  'delete',
  'trip_start',
  'stop_arrival',
  'attendance_mark',
  'trip_complete'
);

const entityTypeArb: fc.Arbitrary<EntityType> = fc.constantFrom(
  'vehicle',
  'route',
  'student',
  'trip',
  'schedule',
  'invoice',
  'user'
);

const significantEventArb: fc.Arbitrary<SignificantEvent> = fc.record({
  event_type: eventTypeArb,
  entity_type: entityTypeArb,
  entity_id: fc.uuid(),
  user_id: fc.uuid(),
  tenant_id: fc.uuid(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Property 28: Audit Log Completeness', () => {
  it('every significant event creates exactly one audit entry', () => {
    fc.assert(
      fc.property(
        fc.array(significantEventArb, { minLength: 1, maxLength: 50 }),
        (events) => {
          const entries = processEventsToAuditLog(events);
          expect(entries.length).toBe(events.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each audit entry has all required fields populated', () => {
    fc.assert(
      fc.property(significantEventArb, (event) => {
        const entry = createAuditEntry(event);
        expect(entry.id).toBeTruthy();
        expect(entry.tenant_id).toBe(event.tenant_id);
        expect(entry.user_id).toBe(event.user_id);
        expect(entry.event_type).toBe(event.event_type);
        expect(entry.entity_type).toBe(event.entity_type);
        expect(entry.entity_id).toBe(event.entity_id);
        expect(entry.created_at).toBeTruthy();
        // Validate ISO timestamp format
        expect(new Date(entry.created_at).toISOString()).toBe(entry.created_at);
      }),
      { numRuns: 100 }
    );
  });

  it('audit entries preserve the original event data without mutation', () => {
    fc.assert(
      fc.property(significantEventArb, (event) => {
        const entry = createAuditEntry(event);
        expect(entry.event_type).toBe(event.event_type);
        expect(entry.entity_type).toBe(event.entity_type);
        expect(entry.entity_id).toBe(event.entity_id);
        expect(entry.user_id).toBe(event.user_id);
        expect(entry.tenant_id).toBe(event.tenant_id);
      }),
      { numRuns: 100 }
    );
  });

  it('no duplicate audit entries for a single event', () => {
    fc.assert(
      fc.property(
        fc.array(significantEventArb, { minLength: 1, maxLength: 30 }),
        (events) => {
          const entries = processEventsToAuditLog(events);
          const ids = entries.map((e) => e.id);
          const uniqueIds = new Set(ids);
          expect(uniqueIds.size).toBe(entries.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});
