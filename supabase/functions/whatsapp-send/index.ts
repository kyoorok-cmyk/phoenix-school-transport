/**
 * Edge Function: whatsapp-send
 *
 * Sends outbound WhatsApp template messages via the WhatsApp Business API.
 * Logs all outbound messages to `transport_whatsapp_messages` with direction 'outbound'.
 *
 * Auth: Service role — called internally by other Edge Functions (e.g. send-notification).
 * Validates service role key in Authorization header.
 *
 * Body (WhatsAppMessage):
 * {
 *   to: string,              // E.164 phone number (e.g. "+27821234567")
 *   template_name: string,   // Pre-approved WhatsApp template name
 *   template_params: string[], // Dynamic parameter values for the template
 *   language_code: string    // e.g. "en" or "af"
 * }
 *
 * Optional fields:
 * {
 *   tenant_id?: string,      // For logging context
 *   guardian_id?: string     // Link message to guardian record
 * }
 *
 * Returns:
 * { success: boolean, message_id: string, delivery_status: string }
 *
 * Requirements: 15.1, 15.3, 15.4, 15.5, 15.7
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhatsAppMessage {
  to: string;
  template_name: string;
  template_params: string[];
  language_code: string;
  tenant_id?: string;
  guardian_id?: string;
}

interface WhatsAppSendResponse {
  success: boolean;
  message_id: string;
  delivery_status: string;
  error?: string;
}

// ─── Helper: Create admin Supabase client ──────────────────────────────────────

function getAdminClient() {
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
      JSON.stringify({ error: "Missing or invalid authorization header", code: "AUTH_MISSING" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const token = authHeader.replace("Bearer ", "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!serviceRoleKey || token !== serviceRoleKey) {
    throw new Response(
      JSON.stringify({ error: "Forbidden: service role key required", code: "AUTH_FORBIDDEN" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ─── Helper: Validate E.164 phone number ───────────────────────────────────────

function isValidE164(phone: string): boolean {
  // E.164: starts with +, followed by 1-15 digits
  return /^\+[1-9]\d{1,14}$/.test(phone);
}

// ─── Helper: Validate request payload ──────────────────────────────────────────

function validatePayload(body: unknown): { valid: true; message: WhatsAppMessage } | { valid: false; error: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  if (!obj.to || typeof obj.to !== "string") {
    return { valid: false, error: "Missing or invalid 'to' field — must be an E.164 phone number" };
  }

  if (!isValidE164(obj.to as string)) {
    return { valid: false, error: "Invalid 'to' phone number — must be E.164 format (e.g. +27821234567)" };
  }

  if (!obj.template_name || typeof obj.template_name !== "string") {
    return { valid: false, error: "Missing or invalid 'template_name' — must be a non-empty string" };
  }

  if (!Array.isArray(obj.template_params)) {
    return { valid: false, error: "Missing or invalid 'template_params' — must be an array of strings" };
  }

  for (let i = 0; i < obj.template_params.length; i++) {
    if (typeof obj.template_params[i] !== "string") {
      return { valid: false, error: `template_params[${i}] must be a string` };
    }
  }

  if (!obj.language_code || typeof obj.language_code !== "string") {
    return { valid: false, error: "Missing or invalid 'language_code' — must be a non-empty string (e.g. 'en', 'af')" };
  }

  return {
    valid: true,
    message: {
      to: obj.to as string,
      template_name: obj.template_name as string,
      template_params: obj.template_params as string[],
      language_code: obj.language_code as string,
      tenant_id: typeof obj.tenant_id === "string" ? obj.tenant_id : undefined,
      guardian_id: typeof obj.guardian_id === "string" ? obj.guardian_id : undefined,
    },
  };
}

// ─── Core: Send WhatsApp message via Business API ──────────────────────────────

async function sendWhatsAppMessage(
  message: WhatsAppMessage
): Promise<{ success: boolean; messageId: string; deliveryStatus: string; error?: string }> {
  const apiUrl = Deno.env.get("WHATSAPP_API_URL");
  const apiKey = Deno.env.get("WHATSAPP_API_KEY");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

  // If env vars are not configured, simulate success for development
  if (!apiUrl || !apiKey || !phoneNumberId) {
    console.log(
      `[whatsapp-send] Simulating send to ${message.to} | template: ${message.template_name} | params: ${JSON.stringify(message.template_params)} | lang: ${message.language_code}`
    );
    return {
      success: true,
      messageId: `wamid_${crypto.randomUUID()}`,
      deliveryStatus: "sent",
    };
  }

  // Call WhatsApp Business API (Cloud API format)
  const url = `${apiUrl}/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: message.to.replace("+", ""), // WhatsApp Cloud API expects number without +
        type: "template",
        template: {
          name: message.template_name,
          language: {
            code: message.language_code,
          },
          components: [
            {
              type: "body",
              parameters: message.template_params.map((param) => ({
                type: "text",
                text: param,
              })),
            },
          ],
        },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const externalMessageId = data.messages?.[0]?.id || `wamid_${crypto.randomUUID()}`;
      return {
        success: true,
        messageId: externalMessageId,
        deliveryStatus: "sent",
      };
    }

    const errorBody = await response.text();
    console.error(`[whatsapp-send] API error ${response.status}: ${errorBody}`);
    return {
      success: false,
      messageId: "",
      deliveryStatus: "failed",
      error: `WhatsApp API error ${response.status}: ${errorBody}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown error";
    console.error(`[whatsapp-send] Request failed: ${reason}`);
    return {
      success: false,
      messageId: "",
      deliveryStatus: "failed",
      error: reason,
    };
  }
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };

  try {
    // Only POST is supported
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed. Use POST.", code: "METHOD_NOT_ALLOWED" }),
        { status: 405, headers }
      );
    }

    // Verify service role authorization
    verifyServiceRole(req);

    // Parse request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body", code: "INVALID_REQUEST" }),
        { status: 400, headers }
      );
    }

    // Validate payload
    const validation = validatePayload(body);
    if (!validation.valid) {
      return new Response(
        JSON.stringify({ error: validation.error, code: "VALIDATION_ERROR" }),
        { status: 400, headers }
      );
    }

    const message = validation.message;

    // Send via WhatsApp Business API
    const result = await sendWhatsAppMessage(message);

    // Log to transport_whatsapp_messages (tenant_id is NOT NULL in schema)
    const adminClient = getAdminClient();

    if (message.tenant_id) {
      const logPayload: Record<string, unknown> = {
        tenant_id: message.tenant_id,
        direction: "outbound",
        phone_number: message.to,
        template_name: message.template_name,
        message_body: `Template: ${message.template_name} | Params: ${message.template_params.join(", ")}`,
        delivery_status: result.deliveryStatus,
        external_message_id: result.messageId || null,
      };

      if (message.guardian_id) {
        logPayload.guardian_id = message.guardian_id;
      }

      const { error: logError } = await adminClient
        .from("transport_whatsapp_messages")
        .insert(logPayload);

      if (logError) {
        console.error("[whatsapp-send] Failed to log message:", logError.message);
      }
    } else {
      console.warn("[whatsapp-send] No tenant_id provided — message sent but not logged to transport_whatsapp_messages");
    }

    // Return result
    const response: WhatsAppSendResponse = {
      success: result.success,
      message_id: result.messageId,
      delivery_status: result.deliveryStatus,
    };

    if (!result.success && result.error) {
      response.error = result.error;
    }

    return new Response(
      JSON.stringify(response),
      { status: result.success ? 200 : 502, headers }
    );
  } catch (err) {
    // If the error is already a Response (thrown by verifyServiceRole), return it
    if (err instanceof Response) {
      const responseBody = await err.text();
      return new Response(responseBody, { status: err.status, headers });
    }

    console.error("[whatsapp-send] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", code: "INTERNAL_ERROR" }),
      { status: 500, headers }
    );
  }
});
