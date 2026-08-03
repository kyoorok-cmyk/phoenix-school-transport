/**
 * Edge Function: whatsapp-webhook
 *
 * Receives inbound WhatsApp messages from the Meta webhook.
 * Handles two request types:
 * - GET: Webhook verification (returns hub.challenge)
 * - POST: Receives inbound messages, logs to `transport_whatsapp_messages`,
 *         routes guardian replies to operators via audit log.
 *
 * Auth:
 * - GET: Validates META_WEBHOOK_VERIFY_TOKEN
 * - POST: Validates x-hub-signature-256 header using META_APP_SECRET
 *
 * No JWT auth required — this endpoint receives webhook calls from Meta's servers.
 *
 * Returns:
 * - GET: 200 with hub.challenge on successful verification, 403 otherwise
 * - POST: 200 OK always (Meta requires immediate acknowledgement)
 *
 * Requirements: 15.1, 15.3, 15.4, 15.5, 15.7
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhatsAppInbound {
  from: string;
  message_body: string;
  timestamp: string;
  message_id: string;
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: {
        display_phone_number: string;
        phone_number_id: string;
      };
      contacts?: Array<{
        profile: { name: string };
        wa_id: string;
      }>;
      messages?: Array<{
        from: string;
        id: string;
        timestamp: string;
        type: string;
        text?: { body: string };
      }>;
      statuses?: Array<{
        id: string;
        status: string;
        timestamp: string;
        recipient_id: string;
      }>;
    };
    field: string;
  }>;
}

interface WhatsAppWebhookPayload {
  object: string;
  entry: WhatsAppWebhookEntry[];
}

// ─── Helper: Create admin Supabase client ──────────────────────────────────────

function getAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── Helper: Verify webhook signature (POST requests) ──────────────────────────

async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  if (!signatureHeader) return false;

  // Meta sends signature as "sha256=<hex_signature>"
  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) return false;

  const providedSignature = signatureHeader.slice(expectedPrefix.length);

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(rawBody)
    );

    const computedSignature = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison to prevent timing attacks
    if (providedSignature.length !== computedSignature.length) return false;

    let mismatch = 0;
    for (let i = 0; i < providedSignature.length; i++) {
      mismatch |= providedSignature.charCodeAt(i) ^ computedSignature.charCodeAt(i);
    }

    return mismatch === 0;
  } catch {
    return false;
  }
}

// ─── Helper: Extract inbound messages from webhook payload ─────────────────────

function extractInboundMessages(payload: WhatsAppWebhookPayload): WhatsAppInbound[] {
  const messages: WhatsAppInbound[] = [];

  if (!payload.entry || !Array.isArray(payload.entry)) return messages;

  for (const entry of payload.entry) {
    if (!entry.changes || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (change.field !== "messages") continue;

      const value = change.value;
      if (!value.messages || !Array.isArray(value.messages)) continue;

      for (const msg of value.messages) {
        // Only handle text messages for now
        if (msg.type === "text" && msg.text?.body) {
          messages.push({
            from: msg.from,
            message_body: msg.text.body,
            timestamp: msg.timestamp,
            message_id: msg.id,
          });
        }
      }
    }
  }

  return messages;
}

// ─── Helper: Extract delivery status updates from webhook payload ───────────────

function extractStatusUpdates(
  payload: WhatsAppWebhookPayload
): Array<{ message_id: string; status: string; timestamp: string }> {
  const statuses: Array<{ message_id: string; status: string; timestamp: string }> = [];

  if (!payload.entry || !Array.isArray(payload.entry)) return statuses;

  for (const entry of payload.entry) {
    if (!entry.changes || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (change.field !== "messages") continue;

      const value = change.value;
      if (!value.statuses || !Array.isArray(value.statuses)) continue;

      for (const status of value.statuses) {
        statuses.push({
          message_id: status.id,
          status: status.status,
          timestamp: status.timestamp,
        });
      }
    }
  }

  return statuses;
}

// ─── Helper: Normalize phone number to E.164 ───────────────────────────────────

function normalizePhoneNumber(phone: string): string {
  // WhatsApp sends numbers without the + prefix
  if (!phone.startsWith("+")) {
    return `+${phone}`;
  }
  return phone;
}

// ─── Helper: Map WhatsApp status to our delivery_status enum ───────────────────

function mapDeliveryStatus(waStatus: string): string {
  switch (waStatus) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return "failed";
    default:
      return "sent";
  }
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const headers = { "Content-Type": "application/json" };

  try {
    // ─── GET: Webhook Verification ───────────────────────────────────────────
    if (req.method === "GET") {
      const url = new URL(req.url);
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      const verifyToken = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN");

      if (!verifyToken) {
        console.error("[whatsapp-webhook] META_WEBHOOK_VERIFY_TOKEN not configured");
        return new Response(
          JSON.stringify({ error: "Webhook verification not configured" }),
          { status: 500, headers }
        );
      }

      if (mode === "subscribe" && token === verifyToken) {
        console.log("[whatsapp-webhook] Webhook verified successfully");
        // Meta expects the challenge value returned as plain text
        return new Response(challenge || "", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      console.warn("[whatsapp-webhook] Webhook verification failed — invalid token");
      return new Response(
        JSON.stringify({ error: "Forbidden: invalid verify token" }),
        { status: 403, headers }
      );
    }

    // ─── POST: Receive Inbound Messages ──────────────────────────────────────
    if (req.method === "POST") {
      const appSecret = Deno.env.get("META_APP_SECRET");

      // Read raw body for signature verification
      const rawBody = await req.text();

      // Validate webhook signature if META_APP_SECRET is configured
      if (appSecret) {
        const signatureHeader = req.headers.get("x-hub-signature-256");
        const isValid = await verifyWebhookSignature(rawBody, signatureHeader, appSecret);

        if (!isValid) {
          console.warn("[whatsapp-webhook] Invalid webhook signature");
          return new Response(
            JSON.stringify({ error: "Invalid webhook signature" }),
            { status: 401, headers }
          );
        }
      } else {
        console.warn("[whatsapp-webhook] META_APP_SECRET not configured — skipping signature validation");
      }

      // Parse the webhook payload
      let payload: WhatsAppWebhookPayload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid JSON body" }),
          { status: 400, headers }
        );
      }

      // Verify this is a WhatsApp webhook
      if (payload.object !== "whatsapp_business_account") {
        // Not a WhatsApp event, acknowledge anyway
        return new Response(JSON.stringify({ status: "ignored" }), { status: 200, headers });
      }

      const adminClient = getAdminClient();

      // ─── Process inbound messages ────────────────────────────────────────
      const inboundMessages = extractInboundMessages(payload);

      for (const msg of inboundMessages) {
        const normalizedPhone = normalizePhoneNumber(msg.from);

        // Look up guardian by WhatsApp number or phone number
        const { data: guardian } = await adminClient
          .from("transport_guardians")
          .select("id, tenant_id, full_name")
          .or(`whatsapp_number.eq.${normalizedPhone},phone_number.eq.${normalizedPhone}`)
          .limit(1)
          .single();

        const tenantId = guardian?.tenant_id || null;
        const guardianId = guardian?.id || null;

        // Log inbound message to transport_whatsapp_messages
        // tenant_id is NOT NULL in the schema, so we can only log if we have a tenant
        if (tenantId) {
          const logPayload: Record<string, unknown> = {
            tenant_id: tenantId,
            direction: "inbound",
            phone_number: normalizedPhone,
            message_body: msg.message_body,
            delivery_status: "delivered",
            external_message_id: msg.message_id,
          };

          if (guardianId) logPayload.guardian_id = guardianId;

          const { error: logError } = await adminClient
            .from("transport_whatsapp_messages")
            .insert(logPayload);

          if (logError) {
            console.error("[whatsapp-webhook] Failed to log inbound message:", logError.message);
          }
        } else {
          console.warn(
            `[whatsapp-webhook] Cannot log message from ${normalizedPhone} — no matching guardian/tenant found`
          );
        }

        // Route reply to operator via audit log entry
        if (tenantId) {
          await adminClient.from("transport_audit_log").insert({
            tenant_id: tenantId,
            user_id: null,
            event_type: "whatsapp.inbound_reply",
            entity_type: "whatsapp_message",
            entity_id: guardianId,
            details: {
              from: normalizedPhone,
              guardian_name: guardian?.full_name || "Unknown",
              message_body: msg.message_body,
              message_id: msg.message_id,
              timestamp: msg.timestamp,
            },
          });
        }

        console.log(
          `[whatsapp-webhook] Inbound message from ${normalizedPhone}: "${msg.message_body.substring(0, 50)}..."`
        );
      }

      // ─── Process delivery status updates ─────────────────────────────────
      const statusUpdates = extractStatusUpdates(payload);

      for (const statusUpdate of statusUpdates) {
        const mappedStatus = mapDeliveryStatus(statusUpdate.status);

        // Update delivery status on existing outbound message record
        const { error: updateError } = await adminClient
          .from("transport_whatsapp_messages")
          .update({ delivery_status: mappedStatus })
          .eq("external_message_id", statusUpdate.message_id)
          .eq("direction", "outbound");

        if (updateError) {
          console.error(
            `[whatsapp-webhook] Failed to update delivery status for ${statusUpdate.message_id}:`,
            updateError.message
          );
        }
      }

      // Always return 200 to acknowledge webhook receipt (Meta requirement)
      return new Response(
        JSON.stringify({ status: "ok" }),
        { status: 200, headers }
      );
    }

    // ─── Other methods not allowed ───────────────────────────────────────────
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[whatsapp-webhook] Unhandled error:", message);

    // Always return 200 for POST to avoid Meta retrying
    if (req.method === "POST") {
      return new Response(
        JSON.stringify({ status: "error_acknowledged" }),
        { status: 200, headers }
      );
    }

    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers }
    );
  }
});
