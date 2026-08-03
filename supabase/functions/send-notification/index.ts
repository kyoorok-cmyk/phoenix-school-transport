/**
 * Edge Function: send-notification
 *
 * Routes notifications to guardians via their preferred channel (SMS, Push, WhatsApp).
 * Implements retry logic with exponential backoff (up to 3 attempts: 2s, 4s, 8s)
 * and a fallback chain: WhatsApp → SMS → Push.
 *
 * Auth: System function (service role) - called by other Edge Functions internally.
 * No user-facing auth required; validates service role key in Authorization header.
 *
 * Body (single):
 * {
 *   tenant_id: string,
 *   recipient_guardian_id: string,
 *   notification_type: string,
 *   template_params: Record<string, string>,
 *   preferred_channel?: 'sms' | 'push' | 'whatsapp'
 * }
 *
 * Body (batch):
 * {
 *   notifications: NotificationPayload[]
 * }
 *
 * Returns NotificationResult:
 * { success, channel_used, message_id, fallback_used, error? }
 *
 * Requirements: 8.5, 8.6, 8.7
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

type NotificationChannel = "sms" | "push" | "whatsapp";

interface NotificationPayload {
  tenant_id: string;
  recipient_guardian_id: string;
  notification_type: string;
  template_params: Record<string, string>;
  preferred_channel?: NotificationChannel;
}

interface NotificationResult {
  success: boolean;
  channel_used: NotificationChannel;
  message_id: string;
  fallback_used: boolean;
  error?: string;
}

interface BatchRequest {
  notifications: NotificationPayload[];
}

interface ErrorResponse {
  error: string;
  code: string;
  details?: unknown;
}

interface ChannelDeliveryResult {
  success: boolean;
  message_id: string;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s
const FALLBACK_CHAIN: NotificationChannel[] = ["whatsapp", "sms", "push"];
const VALID_CHANNELS: NotificationChannel[] = ["sms", "push", "whatsapp"];

// ─── Helper: Create admin Supabase client ──────────────────────────────────────

function getAdminClient(): ReturnType<typeof createClient> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── Helper: Verify service role authorization ─────────────────────────────────

function verifyServiceRole(req: Request): void {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Response(
      JSON.stringify({
        error: "Missing or invalid authorization header",
        code: "AUTH_MISSING",
      } as ErrorResponse),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const token = authHeader.replace("Bearer ", "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!serviceRoleKey || token !== serviceRoleKey) {
    throw new Response(
      JSON.stringify({
        error: "Forbidden: service role key required",
        code: "AUTH_FORBIDDEN",
      } as ErrorResponse),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ─── Helper: Sleep for exponential backoff ─────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Channel Delivery: WhatsApp (placeholder - simulated) ──────────────────────

async function deliverWhatsApp(
  guardianPhone: string,
  notificationType: string,
  templateParams: Record<string, string>
): Promise<ChannelDeliveryResult> {
  const whatsappApiUrl = Deno.env.get("WHATSAPP_API_URL");
  const whatsappApiKey = Deno.env.get("WHATSAPP_API_KEY");

  if (!whatsappApiUrl || !whatsappApiKey) {
    console.log(
      `[send-notification][whatsapp] Simulating delivery to ${guardianPhone} | type: ${notificationType} | params: ${JSON.stringify(templateParams)}`
    );
    // Simulate success for development; in production this would call the WhatsApp Business API
    return {
      success: true,
      message_id: `wa_${crypto.randomUUID()}`,
    };
  }

  try {
    const response = await fetch(whatsappApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${whatsappApiKey}`,
      },
      body: JSON.stringify({
        to: guardianPhone,
        template_name: notificationType,
        template_params: Object.values(templateParams),
        language_code: "en",
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message_id: data.message_id || `wa_${crypto.randomUUID()}`,
      };
    }

    const errorText = await response.text();
    return {
      success: false,
      message_id: "",
      error: `WhatsApp API error ${response.status}: ${errorText}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown WhatsApp error";
    return { success: false, message_id: "", error: reason };
  }
}

// ─── Channel Delivery: SMS ─────────────────────────────────────────────────────

async function deliverSMS(
  guardianPhone: string,
  notificationType: string,
  templateParams: Record<string, string>
): Promise<ChannelDeliveryResult> {
  const smsApiUrl = Deno.env.get("SMS_API_URL");
  const smsApiKey = Deno.env.get("SMS_API_KEY");

  // Build message from template params
  const message = buildSMSMessage(notificationType, templateParams);

  if (!smsApiUrl || !smsApiKey) {
    console.log(
      `[send-notification][sms] Simulating delivery to ${guardianPhone} | message: ${message}`
    );
    return {
      success: true,
      message_id: `sms_${crypto.randomUUID()}`,
    };
  }

  try {
    const response = await fetch(smsApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${smsApiKey}`,
      },
      body: JSON.stringify({
        to: guardianPhone,
        body: message,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message_id: data.id || `sms_${crypto.randomUUID()}`,
      };
    }

    const errorText = await response.text();
    return {
      success: false,
      message_id: "",
      error: `SMS gateway error ${response.status}: ${errorText}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown SMS error";
    return { success: false, message_id: "", error: reason };
  }
}

// ─── Channel Delivery: Push Notification (FCM) ─────────────────────────────────

async function deliverPush(
  pushToken: string | null,
  notificationType: string,
  templateParams: Record<string, string>
): Promise<ChannelDeliveryResult> {
  if (!pushToken) {
    return {
      success: false,
      message_id: "",
      error: "No push token available for guardian",
    };
  }

  const fcmApiKey = Deno.env.get("FCM_SERVER_KEY");

  if (!fcmApiKey) {
    console.log(
      `[send-notification][push] Simulating push to token ${pushToken.substring(0, 10)}... | type: ${notificationType} | params: ${JSON.stringify(templateParams)}`
    );
    return {
      success: true,
      message_id: `push_${crypto.randomUUID()}`,
    };
  }

  try {
    const response = await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `key=${fcmApiKey}`,
      },
      body: JSON.stringify({
        to: pushToken,
        notification: {
          title: buildPushTitle(notificationType),
          body: buildPushBody(notificationType, templateParams),
        },
        data: {
          notification_type: notificationType,
          ...templateParams,
        },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      if (data.success === 1) {
        return {
          success: true,
          message_id: data.results?.[0]?.message_id || `push_${crypto.randomUUID()}`,
        };
      }
      return {
        success: false,
        message_id: "",
        error: `FCM delivery failed: ${JSON.stringify(data.results)}`,
      };
    }

    const errorText = await response.text();
    return {
      success: false,
      message_id: "",
      error: `FCM error ${response.status}: ${errorText}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown push error";
    return { success: false, message_id: "", error: reason };
  }
}

// ─── Helper: Build SMS message from template params ────────────────────────────

function buildSMSMessage(
  notificationType: string,
  params: Record<string, string>
): string {
  switch (notificationType) {
    case "approaching":
      return `Transport Alert: The bus is approaching ${params.stop_name || "your stop"}. ETA: ${params.eta || "5 min"}. Student: ${params.student_name || "your child"}.`;
    case "boarded":
      return `Transport Alert: ${params.student_name || "Your child"} has boarded the bus at ${params.stop_name || "the stop"}.`;
    case "dropped_off":
      return `Transport Alert: ${params.student_name || "Your child"} has been dropped off at ${params.stop_name || "the stop"}.`;
    case "delay":
      return `Transport Alert: The bus on route ${params.route_name || ""} is delayed. New ETA: ${params.eta || "TBD"}.`;
    case "trip_cancelled":
      return `Transport Alert: The trip on route ${params.route_name || ""} for ${params.trip_date || "today"} has been cancelled. Reason: ${params.reason || "N/A"}.`;
    case "absent":
      return `Transport Alert: ${params.student_name || "Your child"} was marked absent from the bus at ${params.stop_name || "the stop"}.`;
    case "invoice":
      return `Payment: Invoice ${params.invoice_number || ""} for R${params.amount || "0.00"} is due on ${params.due_date || ""}. ${params.payment_link || ""}`;
    case "payment_reminder":
      return `Reminder: Invoice ${params.invoice_number || ""} for R${params.amount || "0.00"} is overdue. Please pay immediately.`;
    default:
      return `Transport Notification: ${Object.values(params).join(" | ")}`;
  }
}

// ─── Helper: Build push notification title ─────────────────────────────────────

function buildPushTitle(notificationType: string): string {
  switch (notificationType) {
    case "approaching":
      return "Bus Approaching";
    case "boarded":
      return "Student Boarded";
    case "dropped_off":
      return "Student Dropped Off";
    case "delay":
      return "Trip Delayed";
    case "trip_cancelled":
      return "Trip Cancelled";
    case "absent":
      return "Student Absent";
    case "invoice":
      return "New Invoice";
    case "payment_reminder":
      return "Payment Reminder";
    default:
      return "Transport Update";
  }
}

// ─── Helper: Build push notification body ──────────────────────────────────────

function buildPushBody(
  notificationType: string,
  params: Record<string, string>
): string {
  return buildSMSMessage(notificationType, params);
}

// ─── Helper: Deliver on a specific channel ─────────────────────────────────────

async function deliverOnChannel(
  channel: NotificationChannel,
  guardian: { phone_number: string; whatsapp_number: string | null; push_token: string | null },
  notificationType: string,
  templateParams: Record<string, string>
): Promise<ChannelDeliveryResult> {
  switch (channel) {
    case "whatsapp": {
      const whatsappNumber = guardian.whatsapp_number || guardian.phone_number;
      return await deliverWhatsApp(whatsappNumber, notificationType, templateParams);
    }
    case "sms":
      return await deliverSMS(guardian.phone_number, notificationType, templateParams);
    case "push":
      return await deliverPush(guardian.push_token, notificationType, templateParams);
    default:
      return { success: false, message_id: "", error: `Unknown channel: ${channel}` };
  }
}

// ─── Helper: Get fallback channels after the primary ───────────────────────────

function getFallbackChannels(primaryChannel: NotificationChannel): NotificationChannel[] {
  const idx = FALLBACK_CHAIN.indexOf(primaryChannel);
  if (idx === -1) {
    // If primary not in chain, return the full fallback chain minus primary
    return FALLBACK_CHAIN.filter((c) => c !== primaryChannel);
  }
  // Return remaining channels after the primary in the chain
  return FALLBACK_CHAIN.slice(idx + 1);
}

// ─── Core: Send a single notification with retry + fallback ────────────────────

async function sendSingleNotification(
  adminClient: ReturnType<typeof createClient>,
  payload: NotificationPayload
): Promise<NotificationResult> {
  const { tenant_id, recipient_guardian_id, notification_type, template_params } = payload;

  // 1. Look up guardian's preferred_notification_channel if not provided
  const { data: guardian, error: guardianError } = await adminClient
    .from("transport_guardians")
    .select("id, full_name, phone_number, whatsapp_number, preferred_notification_channel, push_token")
    .eq("id", recipient_guardian_id)
    .eq("tenant_id", tenant_id)
    .single();

  if (guardianError || !guardian) {
    console.error(
      `[send-notification] Guardian not found: ${recipient_guardian_id}`,
      guardianError?.message
    );
    return {
      success: false,
      channel_used: "sms",
      message_id: "",
      fallback_used: false,
      error: `Guardian not found: ${recipient_guardian_id}`,
    };
  }

  const preferredChannel: NotificationChannel =
    payload.preferred_channel ||
    (guardian.preferred_notification_channel as NotificationChannel) ||
    "sms";

  // 2. Create initial notification record in transport_notifications
  const { data: notificationRecord, error: insertError } = await adminClient
    .from("transport_notifications")
    .insert({
      tenant_id,
      guardian_id: recipient_guardian_id,
      notification_type,
      channel: preferredChannel,
      template_name: notification_type,
      template_params: template_params,
      delivery_status: "pending",
      retry_count: 0,
      fallback_used: false,
    })
    .select()
    .single();

  if (insertError) {
    console.error("[send-notification] Failed to create notification record:", insertError.message);
  }

  const notificationId = notificationRecord?.id;

  // 3. Attempt delivery on preferred channel with retries
  let result = await attemptDeliveryWithRetries(
    preferredChannel,
    guardian,
    notification_type,
    template_params
  );

  let channelUsed = preferredChannel;
  let fallbackUsed = false;
  let totalRetries = result.retryCount;

  // 4. If all retries fail on primary channel, fall back to next channels
  if (!result.success) {
    const fallbackChannels = getFallbackChannels(preferredChannel);

    for (const fallbackChannel of fallbackChannels) {
      console.log(
        `[send-notification] Primary channel ${preferredChannel} failed. Falling back to ${fallbackChannel}`
      );

      result = await attemptDeliveryWithRetries(
        fallbackChannel,
        guardian,
        notification_type,
        template_params
      );
      totalRetries += result.retryCount;

      if (result.success) {
        channelUsed = fallbackChannel;
        fallbackUsed = true;
        break;
      }
    }
  }

  // 5. Update notification record with final result
  if (notificationId) {
    await adminClient
      .from("transport_notifications")
      .update({
        channel: channelUsed,
        delivery_status: result.success ? "sent" : "failed",
        retry_count: totalRetries,
        fallback_used: fallbackUsed,
        external_message_id: result.messageId || null,
        sent_at: result.success ? new Date().toISOString() : null,
      })
      .eq("id", notificationId);
  }

  return {
    success: result.success,
    channel_used: channelUsed,
    message_id: result.messageId,
    fallback_used: fallbackUsed,
    error: result.success ? undefined : result.lastError,
  };
}

// ─── Helper: Attempt delivery with retry logic ─────────────────────────────────
// Tries delivery once, then retries up to MAX_RETRIES times with exponential
// backoff (2s, 4s, 8s). Total attempts = 1 initial + up to 3 retries = 4.

async function attemptDeliveryWithRetries(
  channel: NotificationChannel,
  guardian: { phone_number: string; whatsapp_number: string | null; push_token: string | null },
  notificationType: string,
  templateParams: Record<string, string>
): Promise<{ success: boolean; messageId: string; retryCount: number; lastError?: string }> {
  let lastError: string | undefined;
  const totalAttempts = 1 + MAX_RETRIES; // 1 initial + 3 retries

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    // Exponential backoff: skip delay on first attempt (attempt 0)
    // Retry 1 → 2s, Retry 2 → 4s, Retry 3 → 8s
    if (attempt > 0) {
      const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1); // 2s, 4s, 8s
      console.log(
        `[send-notification] Retry ${attempt}/${MAX_RETRIES} on ${channel} after ${delayMs}ms`
      );
      await sleep(delayMs);
    }

    const deliveryResult = await deliverOnChannel(
      channel,
      guardian,
      notificationType,
      templateParams
    );

    if (deliveryResult.success) {
      return {
        success: true,
        messageId: deliveryResult.message_id,
        retryCount: attempt, // 0 = first try worked, 1-3 = retries needed
      };
    }

    lastError = deliveryResult.error;
    console.warn(
      `[send-notification] Attempt ${attempt + 1}/${totalAttempts} failed on ${channel}: ${lastError}`
    );
  }

  return {
    success: false,
    messageId: "",
    retryCount: MAX_RETRIES,
    lastError,
  };
}

// ─── Helper: Validate a single notification payload ────────────────────────────

function validatePayload(payload: unknown): { valid: boolean; error?: string } {
  if (!payload || typeof payload !== "object") {
    return { valid: false, error: "Payload must be a non-null object" };
  }

  const p = payload as Record<string, unknown>;

  if (!p.tenant_id || typeof p.tenant_id !== "string") {
    return { valid: false, error: "tenant_id is required and must be a string" };
  }

  if (!p.recipient_guardian_id || typeof p.recipient_guardian_id !== "string") {
    return { valid: false, error: "recipient_guardian_id is required and must be a string" };
  }

  if (!p.notification_type || typeof p.notification_type !== "string") {
    return { valid: false, error: "notification_type is required and must be a string" };
  }

  if (!p.template_params || typeof p.template_params !== "object") {
    return { valid: false, error: "template_params is required and must be an object" };
  }

  if (p.preferred_channel !== undefined) {
    if (!VALID_CHANNELS.includes(p.preferred_channel as NotificationChannel)) {
      return {
        valid: false,
        error: `preferred_channel must be one of: ${VALID_CHANNELS.join(", ")}`,
      };
    }
  }

  return { valid: true };
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };

  try {
    // Only POST is supported
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: "Method not allowed. Use POST.",
          code: "METHOD_NOT_ALLOWED",
        } as ErrorResponse),
        { status: 405, headers }
      );
    }

    // Verify service role authorization
    verifyServiceRole(req);

    // Parse request body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: "Invalid JSON body",
          code: "INVALID_REQUEST",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    const adminClient = getAdminClient();

    // Determine if this is a batch or single request
    if (Array.isArray(body.notifications)) {
      // Batch mode
      const notifications = body.notifications as unknown[];

      if (notifications.length === 0) {
        return new Response(
          JSON.stringify({
            error: "notifications array must not be empty",
            code: "VALIDATION_ERROR",
          } as ErrorResponse),
          { status: 400, headers }
        );
      }

      // Validate all payloads
      for (let i = 0; i < notifications.length; i++) {
        const validation = validatePayload(notifications[i]);
        if (!validation.valid) {
          return new Response(
            JSON.stringify({
              error: `Validation failed at index ${i}: ${validation.error}`,
              code: "VALIDATION_ERROR",
              details: { index: i },
            } as ErrorResponse),
            { status: 400, headers }
          );
        }
      }

      // Process all notifications concurrently
      const results = await Promise.all(
        notifications.map((n) =>
          sendSingleNotification(adminClient, n as NotificationPayload)
        )
      );

      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.length - successCount;

      return new Response(
        JSON.stringify({
          message: `Batch complete: ${successCount} sent, ${failureCount} failed`,
          total: results.length,
          success_count: successCount,
          failure_count: failureCount,
          results,
        }),
        { status: 200, headers }
      );
    } else {
      // Single notification mode
      const validation = validatePayload(body);
      if (!validation.valid) {
        return new Response(
          JSON.stringify({
            error: validation.error,
            code: "VALIDATION_ERROR",
          } as ErrorResponse),
          { status: 400, headers }
        );
      }

      const result = await sendSingleNotification(
        adminClient,
        body as unknown as NotificationPayload
      );

      return new Response(
        JSON.stringify(result),
        { status: result.success ? 200 : 502, headers }
      );
    }
  } catch (err) {
    // If the error is already a Response (thrown by verifyServiceRole), return it
    if (err instanceof Response) {
      const responseBody = await err.text();
      return new Response(responseBody, {
        status: err.status,
        headers,
      });
    }

    console.error("[send-notification] Unhandled error:", err);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
      } as ErrorResponse),
      { status: 500, headers }
    );
  }
});
