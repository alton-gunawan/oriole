/**
 * Renderer pesan WhatsApp.
 *
 * Copy balasan (confirm/cancel/reschedule/opt-out), format waktu, dan
 * template reminder bersifat channel-agnostic — direuse dari lapisan
 * Telegram (packages/messaging/src/telegram/render.ts).
 *
 * Perbedaan channel (dikelola oleh adapter di apps/api):
 * - Outbound DI LUAR 24h customer service window WAJIB memakai Message
 *   Template Meta (kategori utility), dikirim via 360dialog sendTemplate.
 * - Di DALAM window, balasan bebas + interactive reply buttons (maks 3,
 *   label ≤ 20 karakter, id ≤ 256).
 */
export {
  formatSlotTime,
  parseSlotTime,
  renderAiDisabledReply,
  renderAiHandoffReply,
  renderAlreadyHandledReply,
  renderAskPhoneReply,
  renderBookingNotFoundReply,
  renderBookingReminder,
  renderBusinessInfoReply,
  renderCancelReply,
  renderConfirmReply,
  renderFormInvitation,
  renderGenericReply,
  renderLinkedReply,
  renderNoBookingReply,
  renderNoFormReply,
  renderOptOutReply,
  renderPhoneMismatchReply,
  renderRescheduleCancelled,
  renderRescheduleInvalid,
  renderReschedulePrompt,
  renderRescheduleSuccess,
} from '../telegram/render.ts';
export type { BookingReminderInput, BusinessInfoReplyInput, FormInvitationInput } from '../telegram/render.ts';
