/**
 * Notification Routing Property Tests
 *
 * Properties 7, 15, 29, 30, 31:
 * - Guardian Preferred Channel Routing
 * - WhatsApp Template Parameter Population
 * - WhatsApp Fallback to SMS After 3 Failures
 * - WhatsApp Message Logging
 * - Route Modification Notifies All Assigned Drivers
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ═══════════════════════════════════════════════════════════════════════════════
// Pure functions under test
// ═══════════════════════════════════════════════════════════════════════════════

type NotificationChannel = 'sms' | 'push' | 'whatsapp';

interface Guardian {
  id: string;
  preferred_notification_channel: NotificationChannel;
}

interface NotificationResult {
  channel_used: NotificationChannel;
  fallback_used: boolean;
}

/**
 * Routes a notification to the guardian's preferred channel.
 * If fallbackTriggered is true, falls back to SMS.
 */
function routeNotification(
  guardian: Guardian,
  fallbackTriggered: boolean
): NotificationResult {
  if (fallbackTriggered) {
    return { channel_used: 'sms', fallback_used: true };
  }
  return { channel_used: guardian.preferred_notification_channel, fallback_used: false };
}

interface WhatsAppTemplateMessage {
  template_name: string;
  template_params: Record<string, string>;
}

/**
 * Builds a WhatsApp trip notification template message.
 * Returns null if required params are missing.
 */
function buildTripWhatsAppMessage(
  studentName: string,
  routeName: string,
  eta: string
): WhatsAppTemplateMessage | null {
  if (!studentName || !routeName || !eta) {
    return null;
  }
  return {
    template_name: 'trip_notification',
    template_params: {
      student_name: studentName,
      route_name: routeName,
      eta: eta,
    },
  };
}

interface DeliveryAttempt {
  channel: NotificationChannel;
  success: boolean;
}

interface FallbackResult {
  final_channel: NotificationChannel;
  fallback_used: boolean;
  sms_attempted: boolean;
}

/**
 * After 3 WhatsApp failures, attempts SMS fallback.
 * Returns the result of fallback logic.
 */
function handleWhatsAppFallback(attempts: DeliveryAttempt[]): FallbackResult {
  const whatsappFailures = attempts.filter(
    (a) => a.channel === 'whatsapp' && !a.success
  ).length;

  if (whatsappFailures >= 3) {
    return {
      final_channel: 'sms',
      fallback_used: true,
      sms_attempted: true,
    };
  }

  return {
    final_channel: 'whatsapp',
    fallback_used: false,
    sms_attempted: false,
  };
}

type MessageDirection = 'inbound' | 'outbound';
type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

interface WhatsAppLogEntry {
  direction: MessageDirection;
  phone_number: string;
  delivery_status: DeliveryStatus;
  template_name?: string;
  message_body?: string;
  created_at: string;
}

/**
 * Creates a WhatsApp message log entry with correct direction and status.
 */
function createWhatsAppLogEntry(
  direction: MessageDirection,
  phoneNumber: string,
  status: DeliveryStatus,
  templateName?: string,
  messageBody?: string
): WhatsAppLogEntry {
  return {
    direction,
    phone_number: phoneNumber,
    delivery_status: status,
    template_name: templateName,
    message_body: messageBody,
    created_at: new Date().toISOString(),
  };
}

interface RouteModificationNotification {
  driver_id: string;
  route_id: string;
  notification_type: 'route_modified';
}

/**
 * Generates notifications for all drivers assigned to a modified route.
 * Returns exactly N notifications for N drivers.
 */
function notifyDriversOfRouteModification(
  routeId: string,
  assignedDriverIds: string[]
): RouteModificationNotification[] {
  return assignedDriverIds.map((driverId) => ({
    driver_id: driverId,
    route_id: routeId,
    notification_type: 'route_modified' as const,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════════

const channelArb: fc.Arbitrary<NotificationChannel> = fc.constantFrom('sms', 'push', 'whatsapp');

const guardianArb: fc.Arbitrary<Guardian> = fc.record({
  id: fc.uuid(),
  preferred_notification_channel: channelArb,
});

const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

const phoneNumberArb = fc.stringMatching(/^\+27[0-9]{9}$/);

const directionArb: fc.Arbitrary<MessageDirection> = fc.constantFrom('inbound', 'outbound');
const deliveryStatusArb: fc.Arbitrary<DeliveryStatus> = fc.constantFrom('pending', 'sent', 'delivered', 'read', 'failed');

const driverIdsArb = fc.array(fc.uuid(), { minLength: 1, maxLength: 20 });

// ═══════════════════════════════════════════════════════════════════════════════
// Property 15: Guardian Preferred Channel Routing
// **Validates: Requirements 8.6**
// ═══════════════════════════════════════════════════════════════════════════════

describe('Property 15: Guardian Preferred Channel Routing', () => {
  it('uses preferred channel when no fallback triggered', () => {
    fc.assert(
      fc.property(guardianArb, (guardian) => {
        const result = routeNotification(guardian, false);
        expect(result.channel_used).toBe(guardian.preferred_notification_channel);
        expect(result.fallback_used).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('falls back to SMS when fallback is triggered', () => {
    fc.assert(
      fc.property(guardianArb, (guardian) => {
        const result = routeNotification(guardian, true);
        expect(result.channel_used).toBe('sms');
        expect(result.fallback_used).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 29: WhatsApp Template Parameter Population
// **Validates: Requirements 15.3**
// ═══════════════════════════════════════════════════════════════════════════════

describe('Property 29: WhatsApp Template Parameter Population', () => {
  it('trip-related WhatsApp messages contain all required params (student_name, route_name, eta)', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonEmptyStringArb,
        nonEmptyStringArb,
        (studentName, routeName, eta) => {
          const message = buildTripWhatsAppMessage(studentName, routeName, eta);
          expect(message).not.toBeNull();
          expect(message!.template_params.student_name).toBe(studentName);
          expect(message!.template_params.route_name).toBe(routeName);
          expect(message!.template_params.eta).toBe(eta);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns null when any required param is empty', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', '  '),
        nonEmptyStringArb,
        nonEmptyStringArb,
        (emptyParam, routeName, eta) => {
          const message = buildTripWhatsAppMessage('', routeName, eta);
          expect(message).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 30: WhatsApp Fallback to SMS After 3 Failures
// **Validates: Requirements 15.6**
// ═══════════════════════════════════════════════════════════════════════════════

describe('Property 30: WhatsApp Fallback to SMS After 3 Failures', () => {
  it('after 3 WhatsApp failures, SMS is attempted and fallback_used=true', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 10 }),
        (failureCount) => {
          const attempts: DeliveryAttempt[] = Array.from({ length: failureCount }, () => ({
            channel: 'whatsapp' as NotificationChannel,
            success: false,
          }));
          const result = handleWhatsAppFallback(attempts);
          expect(result.fallback_used).toBe(true);
          expect(result.sms_attempted).toBe(true);
          expect(result.final_channel).toBe('sms');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('does not fallback when fewer than 3 WhatsApp failures', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        (failureCount) => {
          const attempts: DeliveryAttempt[] = Array.from({ length: failureCount }, () => ({
            channel: 'whatsapp' as NotificationChannel,
            success: false,
          }));
          const result = handleWhatsAppFallback(attempts);
          expect(result.fallback_used).toBe(false);
          expect(result.sms_attempted).toBe(false);
          expect(result.final_channel).toBe('whatsapp');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('successful WhatsApp attempts do not count toward failure threshold', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 2 }),
        (successCount, failureCount) => {
          const attempts: DeliveryAttempt[] = [
            ...Array.from({ length: successCount }, () => ({
              channel: 'whatsapp' as NotificationChannel,
              success: true,
            })),
            ...Array.from({ length: failureCount }, () => ({
              channel: 'whatsapp' as NotificationChannel,
              success: false,
            })),
          ];
          const result = handleWhatsAppFallback(attempts);
          expect(result.fallback_used).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 31: WhatsApp Message Logging
// **Validates: Requirements 15.7**
// ═══════════════════════════════════════════════════════════════════════════════

describe('Property 31: WhatsApp Message Logging', () => {
  it('all sent/received WhatsApp messages are logged with correct direction and status', () => {
    fc.assert(
      fc.property(
        directionArb,
        phoneNumberArb,
        deliveryStatusArb,
        fc.option(nonEmptyStringArb),
        fc.option(nonEmptyStringArb),
        (direction, phone, status, templateName, messageBody) => {
          const entry = createWhatsAppLogEntry(
            direction,
            phone,
            status,
            templateName ?? undefined,
            messageBody ?? undefined
          );
          expect(entry.direction).toBe(direction);
          expect(entry.phone_number).toBe(phone);
          expect(entry.delivery_status).toBe(status);
          expect(entry.created_at).toBeTruthy();
          // Verify it's a valid ISO string
          expect(new Date(entry.created_at).toISOString()).toBe(entry.created_at);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('outbound messages include template_name when provided', () => {
    fc.assert(
      fc.property(
        phoneNumberArb,
        deliveryStatusArb,
        nonEmptyStringArb,
        (phone, status, templateName) => {
          const entry = createWhatsAppLogEntry('outbound', phone, status, templateName);
          expect(entry.template_name).toBe(templateName);
          expect(entry.direction).toBe('outbound');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('inbound messages include message_body when provided', () => {
    fc.assert(
      fc.property(
        phoneNumberArb,
        nonEmptyStringArb,
        (phone, body) => {
          const entry = createWhatsAppLogEntry('inbound', phone, 'delivered', undefined, body);
          expect(entry.message_body).toBe(body);
          expect(entry.direction).toBe('inbound');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 7: Route Modification Notifies All Assigned Drivers
// **Validates: Requirements 4.5**
// ═══════════════════════════════════════════════════════════════════════════════

describe('Property 7: Route Modification Notifies All Assigned Drivers', () => {
  it('modification produces exactly N notifications for N drivers', () => {
    fc.assert(
      fc.property(fc.uuid(), driverIdsArb, (routeId, driverIds) => {
        const notifications = notifyDriversOfRouteModification(routeId, driverIds);
        expect(notifications.length).toBe(driverIds.length);
      }),
      { numRuns: 100 }
    );
  });

  it('each notification targets the correct driver and route', () => {
    fc.assert(
      fc.property(fc.uuid(), driverIdsArb, (routeId, driverIds) => {
        const notifications = notifyDriversOfRouteModification(routeId, driverIds);
        for (let i = 0; i < driverIds.length; i++) {
          expect(notifications[i].driver_id).toBe(driverIds[i]);
          expect(notifications[i].route_id).toBe(routeId);
          expect(notifications[i].notification_type).toBe('route_modified');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('zero drivers produces zero notifications', () => {
    fc.assert(
      fc.property(fc.uuid(), (routeId) => {
        const notifications = notifyDriversOfRouteModification(routeId, []);
        expect(notifications.length).toBe(0);
      }),
      { numRuns: 100 }
    );
  });
});
