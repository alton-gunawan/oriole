import { activeLocale } from '../i18n/format';

/** Tipe respons dari /api/channels (tanpa kredensial privat). */
export interface WorkspaceChannel {
  id: string;
  channelType: 'telegram' | 'whatsapp' | string;
  identifier: string | null;
  isActive: boolean;
  webhookUrl: string;
  createdAt: string;
  updatedAt: string;
  /** true = bot bersama dari server (env TELEGRAM_BOT_TOKEN), belum terhubung ke project. */
  isEnvShared?: boolean;
}

export interface ChannelListResponse {
  channels: WorkspaceChannel[];
}

/** Satu percakapan di unified inbox (daftar). */
export interface InboxConversation {
  id: string;
  channelType: 'telegram' | 'whatsapp' | 'email' | string;
  externalId: string;
  customerName: string | null;
  status: 'active' | 'waiting_input' | 'closed';
  unreadCount: number;
  needsAttention: boolean;
  bookingId: string | null;
  bookingTitle: string | null;
  lastMessageAt: string | null;
  preview: { content: string; direction: 'inbound' | 'outbound'; createdAt: string } | null;
}

export interface InboxListResponse {
  conversations: InboxConversation[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Ringkasan unread per project — untuk badge di project switcher sidebar. */
export interface UnreadSummaryResponse {
  unreadByWorkspace: Record<string, number>;
}

export interface InboxMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  createdAt: string;
}

export interface InboxThreadResponse {
  conversation: {
    id: string;
    channelType: string;
    externalId: string;
    customerName: string | null;
    status: string;
    unreadCount: number;
    needsAttention: boolean;
    createdAt: string;
  };
  booking: {
    id: string;
    title: string;
    status: string;
    scheduledAt: string;
    timezone: string;
    customerName: string | null;
    phone: string | null;
  } | null;
  messages: InboxMessage[];
}

export function channelLabel(channelType: string): string {
  switch (channelType) {
    case 'telegram':
      return 'Telegram';
    case 'whatsapp':
      return 'WhatsApp';
    case 'email':
      return 'Email';
    default:
      return channelType;
  }
}

export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const locale = activeLocale();
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' }) + ` ${time}`;
}
