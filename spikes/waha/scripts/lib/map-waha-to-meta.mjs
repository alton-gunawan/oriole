/**
 * Reference inbound adapter — WAHA webhook → the app's existing types.
 *
 * Target types (from @oriole/messaging — packages/messaging/src/whatsapp/parse.ts
 * and packages/messaging/src/types.ts):
 *   WhatsAppWebhookPayload  — Meta Cloud API shape consumed by
 *                             parseWhatsAppWebhook() and by the existing
 *                             POST /api/webhooks/whatsapp/:workspaceId route
 *                             (apps/api/src/routes/webhooks/whatsapp.ts).
 *   CanonicalInboundEvent   — the channel-agnostic event fed to
 *                             handleWhatsAppUpdate() (apps/api/src/lib/whatsapp-handler.ts).
 *
 * RECOMMENDED DESIGN: produce the Meta shape (mapWahaEventToMeta) and reuse
 * the existing parseWhatsAppWebhook + webhook pipeline unchanged — intent
 * detection (STOP → opt-out), idempotency and Inngest dispatch are then all
 * shared. mapWahaEventToCanonical is provided for reference / the direct
 * route alternative.
 *
 * Known gaps to capture in the real spike run:
 *   - WAHA message events carry NO contact name → senderName is null unless
 *     you call GET /api/{session}/contacts/{id} (or denormalize later).
 *   - Interactive button replies arrive as a normal message whose body is the
 *     button LABEL (no callback-data like Meta's button_reply.id) — MVP treats
 *     them as plain text; verify button flows in a dedicated capture step.
 *   - Media messages are skipped here (the app parser ignores non-text too).
 */

/** chatId ("6281234567890@c.us") → wa_id ("6281234567890"). */
export function chatIdToWaId(chatId) {
  if (typeof chatId !== 'string') return null;
  return chatId
    .replace(/@c\.us$/, '')
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@lid$/, '');
}

/**
 * WAHA 'message' event → Meta-shaped WhatsAppWebhookPayload, or null when the
 * event should be skipped (non-message events, outbound echoes, media).
 *
 * @param {object} event  the WAHA webhook body ({ event, session, me, payload, ... })
 * @returns {object|null}
 */
export function mapWahaEventToMeta(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.event !== 'message' && event.event !== 'message.any') return null;

  const p = event.payload;
  if (!p || typeof p !== 'object') return null;
  if (p.fromMe) return null; // outbound echo — skip
  if (p.hasMedia) return null; // non-text — the app parser ignores these

  const waId = chatIdToWaId(p.from);
  if (!waId || !p.id) return null;

  const meId = chatIdToWaId(event.me?.id);
  const timestamp = Number.isFinite(Number(p.timestamp))
    ? String(p.timestamp)
    : String(Math.floor(Date.now() / 1000));

  // NOTE: WAHA's `me.id` is the account's wa_id — used as a stand-in for
  // Meta's phone_number_id. The app's parser reads it but never matches on
  // it, so the semantic mismatch is harmless. The `metadata` key is only
  // added when the session is authenticated (never `undefined`).
  const value = {
    messaging_product: 'whatsapp',
    messages: [
      {
        from: waId,
        id: p.id,
        timestamp,
        type: 'text',
        text: { body: p.body ?? '' },
      },
    ],
  };
  if (meId) {
    value.metadata = { display_phone_number: meId, phone_number_id: meId };
  }

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: event.session ?? 'default',
        changes: [{ field: 'messages', value }],
      },
    ],
  };
}

/**
 * WAHA 'message' event → CanonicalInboundEvent (direct adapter alternative).
 * NOTE: intent resolution is duplicated here only for reference — the
 * recommended path is mapWahaEventToMeta → existing parseWhatsAppWebhook,
 * which owns opt-out / booking-button intent detection.
 *
 * @returns {object|null}
 */
export function mapWahaEventToCanonical(event) {
  const meta = mapWahaEventToMeta(event);
  if (!meta) return null;
  const message = meta.entry[0].changes[0].value.messages[0];
  const p = event.payload;

  return {
    channel: 'whatsapp',
    providerEventId: message.id,
    senderIdentifier: message.from,
    senderName: null, // WAHA message events have no contact name (see header comment)
    intent: 'text',
    bookingId: null,
    content: message.text.body,
    raw: {
      wahaEventId: event.id ?? null,
      session: event.session ?? null,
      engine: event.engine ?? null,
      fromChatId: p.from ?? null,
      ack: p.ack ?? null,
      messageId: message.id,
    },
    receivedAt: new Date(Number(p.timestamp ?? 0) * 1000).toISOString(),
  };
}
