import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, DropdownMenu, DropdownMenuItem, TextArea } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import {
  channelLabel,
  formatMessageTime,
  type InboxConversation,
  type InboxListResponse,
  type InboxMessage,
  type InboxThreadResponse,
} from '../../lib/messaging';
import { bookingStatusKey } from '../../i18n/enums';
import { formatDateTimeFull } from '../../i18n/format';
import {
  IconArrowRight,
  IconChat,
  IconCheck,
  IconFilter,
  IconGmail,
  IconMail,
  IconSend,
  IconTelegram,
  IconWhatsApp,
} from '../shell/icons';
import { Card, EmptyState, PageHeader } from '../shell/ui';

/** Warna solid per channel — dipakai badge titik pada tombol filter channel. */
const CHANNEL_DOT: Record<string, string> = {
  telegram: '#0284c7',
  whatsapp: '#059669',
  email: '#d97706',
  line: '#06C755',
};

/** Urutan item menu filter channel (All tampil terpisah di atas). */
const CHANNEL_ORDER: InboxConversation['channelType'][] = ['telegram', 'whatsapp', 'email', 'line'];

/** Ikon merek per channel (dari svgl.app) — dipakai item menu filter. */
const CHANNEL_ICON: Record<InboxConversation['channelType'], ReactNode> = {
  telegram: <IconTelegram className="size-4" />,
  whatsapp: <IconWhatsApp className="size-4" />,
  email: <IconGmail className="size-4" />,
  line: <IconChat className="size-4 text-[#06C755]" />,
};

/** Logo channel dalam lingkaran kecil di pojok kanan bawah avatar — pengganti
 *  teks nama channel (ChannelBadge) di list & thread chat. */
function ChannelAvatarBadge({ channelType }: { channelType: string }) {
  return (
    <span
      className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-white dark:bg-zinc-900 shadow-sm ring-1 ring-zinc-200"
      aria-hidden="true"
    >
      {CHANNEL_ICON[channelType] ?? null}
    </span>
  );
}

export function InboxPage() {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<InboxThreadResponse | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Filter channel: null = semua channel. Tombol funnel di sebelah input
  // pencarian membuka menu pilihan channel; badge titik pada tombol
  // mengikuti warna channel aktif.
  const [channelFilter, setChannelFilter] = useState<InboxConversation['channelType'] | null>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const response = await apiFetch<InboxListResponse>('/inbox');
      setConversations(response.conversations);
      setNextCursor(response.nextCursor);
    } catch (err) {
      setListError(errorMessage(err, t, 'inbox.loadFailed'));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      const response = await apiFetch<InboxListResponse>(`/inbox?cursor=${encodeURIComponent(nextCursor)}`);
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...response.conversations.filter((c) => !seen.has(c.id))];
      });
      setNextCursor(response.nextCursor);
    } catch {
      setListError(t('inbox.loadMoreFailed'));
    }
  };

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openThread = async (conversationId: string) => {
    setSelectedId(conversationId);
    setThread(null);
    setThreadError(null);
    setThreadLoading(true);
    try {
      const data = await apiFetch<InboxThreadResponse>(`/inbox/${conversationId}`);
      setThread(data);
      // Tandai dibaca — jangan blok render bila gagal.
      apiFetch(`/inbox/${conversationId}/read`, { method: 'POST' }).catch(() => undefined);
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)),
      );
    } catch (err) {
      setThreadError(errorMessage(err, t, 'inbox.loadFailed'));
    } finally {
      setThreadLoading(false);
    }
  };

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread?.messages.length]);

  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedId || !reply.trim()) return;
    setSending(true);
    setThreadError(null);
    try {
      await apiFetch(`/inbox/${selectedId}/reply`, {
        method: 'POST',
        body: JSON.stringify({ text: reply.trim() }),
      });
      setReply('');
      const data = await apiFetch<InboxThreadResponse>(`/inbox/${selectedId}`);
      setThread(data);
    } catch (err) {
      setThreadError(errorMessage(err, t, 'inbox.replyFailed'));
    } finally {
      setSending(false);
    }
  };

  const sendReminder = async () => {
    if (!thread?.booking || !selectedId) return;
    setSendingReminder(true);
    setThreadError(null);
    try {
      const channel = thread.conversation.channelType;
      const endpoint =
        channel === 'whatsapp'
          ? `/bookings/${thread.booking.id}/trigger-whatsapp`
          : `/bookings/${thread.booking.id}/trigger-telegram`;
      await apiFetch(endpoint, { method: 'POST' });
      const data = await apiFetch<InboxThreadResponse>(`/inbox/${selectedId}`);
      setThread(data);
    } catch (err) {
      setThreadError(errorMessage(err, t, 'inbox.reminderFailed'));
    } finally {
      setSendingReminder(false);
    }
  };

  const query = searchQuery.trim().toLowerCase();
  // Filter channel + pencarian berlaku bersamaan (keduanya AND).
  const visibleConversations = conversations.filter((conversation) => {
    if (channelFilter && conversation.channelType !== channelFilter) return false;
    if (!query) return true;
    return [conversation.customerName, conversation.externalId, conversation.bookingTitle, conversation.preview?.content]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  // Label & tooltip tombol funnel — menampilkan channel aktif bila difilter.
  const filterLabel = channelFilter
    ? t('inbox.filterActive', { channel: channelLabel(channelFilter) })
    : t('inbox.filterByChannel');

  // Header halaman — kini tampil di atas inputan search di kolom daftar
  // percakapan (mobile & desktop), bukan lagi di kolom kanan.
  const pageHeader = (
    <PageHeader
      title={t('inbox.title')}
      description={t('inbox.description')}
      icon={IconChat}
    />
  );

  return (
    <div className="space-y-6 lg:space-y-0">
      {/* ── Daftar percakapan + header halaman — kolom FIXED penuh tinggi tepat
          di sebelah sidebar aplikasi (left-60 = lebar sidebar; inset-y-0 =
          tinggi penuh viewport). Header halaman diletakkan DI ATAS inputan
          search name/number (mobile & desktop). Di bawah lg kembali menjadi
          kartu biasa dalam alur halaman. ── */}
      <aside
        aria-label={t('inbox.title')}
        className="flex max-h-[calc(100vh-220px)] min-h-[420px] flex-col overflow-hidden !rounded-none border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 lg:fixed lg:inset-y-0 lg:left-60 lg:z-30 lg:w-[calc(38vw-9rem)] lg:max-h-none lg:min-h-0 lg:border-y-0 lg:border-l-0 lg:border-r lg:border-zinc-200 dark:lg:border-zinc-700"
      >
          {/* Header halaman — di atas inputan search name/number. */}
          <div className="border-b border-zinc-100 dark:border-zinc-800 px-4 py-4">
            {pageHeader}
          </div>

          <div className="border-b border-zinc-100 dark:border-zinc-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  aria-label={t('inbox.searchLabel')}
                  placeholder={t('inbox.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 outline-none transition placeholder:text-zinc-400 focus:border-amber-400 focus:bg-white dark:focus:bg-zinc-900 focus:ring-2 focus:ring-amber-500/10"
                />
              </div>
              {/* Tombol filter channel — membuka menu pilihan channel (ikon
                  merek per item). Badge titik berwarna channel aktif tampil
                  di pojok tombol. */}
              <DropdownMenu
                placement="below"
                menuWidth={200}
                isMenuOpen={filterMenuOpen}
                onOpenChange={setFilterMenuOpen}
                button={{
                  label: filterLabel,
                  isIconOnly: true,
                  variant: 'ghost',
                  size: 'sm',
                  icon: (
                    <span className="relative inline-flex">
                      <IconFilter className="size-4" />
                      {channelFilter && (
                        <span
                          className="absolute -right-1.5 -top-1.5 size-2.5 rounded-full ring-2 ring-white dark:ring-zinc-900"
                          style={{ backgroundColor: CHANNEL_DOT[channelFilter] }}
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  ),
                  // Selaras dengan input pencarian (border + bg zinc-50).
                  style: {
                    padding: 0,
                    width: 36,
                    height: 36,
                    borderRadius: '0.5rem',
                    border: '1px solid var(--color-border-emphasized)',
                    backgroundColor: 'var(--color-background-muted)',
                  },
                }}
              >
                <DropdownMenuItem
                  icon={<IconFilter className="size-4" />}
                  label={
                    <span className={channelFilter === null ? 'font-medium text-zinc-900 dark:text-zinc-100' : ''}>
                      {t('inbox.allChannels')}
                    </span>
                  }
                  endContent={
                    channelFilter === null ? (
                      <IconCheck className="size-4 text-emerald-600" />
                    ) : undefined
                  }
                  onClick={() => setChannelFilter(null)}
                />
                {CHANNEL_ORDER.map((channel) => (
                  <DropdownMenuItem
                    key={channel}
                    icon={CHANNEL_ICON[channel]}
                    label={
                      <span className={channelFilter === channel ? 'font-medium text-zinc-900 dark:text-zinc-100' : ''}>
                        {channelLabel(channel)}
                      </span>
                    }
                    endContent={
                      channelFilter === channel ? (
                        <IconCheck className="size-4 text-emerald-600" />
                      ) : undefined
                    }
                    onClick={() => setChannelFilter(channel)}
                  />
                ))}
              </DropdownMenu>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!loaded && <p className="p-6 text-center text-sm text-zinc-400">{t('inbox.loading')}</p>}
            {loaded && conversations.length === 0 && (
              <div className="p-6 text-center">
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{t('inbox.emptyListTitle')}</p>
                <p className="mt-1 text-xs text-zinc-400">
                  {t('inbox.emptyListDesc')}
                </p>
              </div>
            )}
            {(query || channelFilter) && visibleConversations.length === 0 && (
              <p className="p-6 text-center text-xs text-zinc-400">
                {channelFilter && !query ? t('inbox.noChannelResults') : t('inbox.noSearchResults')}
              </p>
            )}
            {listError && <p className="p-6 text-center text-xs text-red-600">{listError}</p>}

            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {visibleConversations.map((conversation) => {
                const selected = conversation.id === selectedId;
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      onClick={() => void openThread(conversation.id)}
                      className={`flex w-full items-start gap-3 border-l-2 px-4 py-3 text-left transition ${
                        selected ? 'border-amber-500' : 'border-transparent'
                      } ${
                        conversation.needsAttention
                          ? 'bg-orange-50 hover:bg-orange-100 dark:bg-orange-950/40 dark:hover:bg-orange-950/60'
                          : selected
                            ? 'bg-amber-500/5'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-900'
                      }`}
                    >
                      <span className="relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-amber-400">
                        {(conversation.customerName ?? conversation.externalId ?? '?').slice(0, 1).toUpperCase()}
                        <ChannelAvatarBadge channelType={conversation.channelType} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                            {conversation.customerName ?? conversation.externalId}
                          </span>
                          {conversation.lastMessageAt && (
                            <span className="shrink-0 text-xs text-zinc-400">
                              {formatMessageTime(conversation.lastMessageAt)}
                            </span>
                          )}
                        </span>
                        {conversation.bookingTitle && (
                          <span className="mt-0.5 block truncate text-xs text-zinc-400">
                            {conversation.bookingTitle}
                          </span>
                        )}
                        <span className="mt-1 block truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {conversation.preview
                            ? `${conversation.preview.direction === 'outbound' ? t('inbox.youPrefix') : ''}${conversation.preview.content}`
                            : t('inbox.noMessages')}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {conversation.unreadCount > 0 && (
                          <span className="flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-bold text-zinc-950">
                            {conversation.unreadCount}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {nextCursor && (
              <div className="border-t border-zinc-100 dark:border-zinc-800 p-3 text-center">
                <Button label={t('common.loadMore')} variant="ghost" size="sm" onClick={() => void loadMore()} />
              </div>
            )}
          </div>
      </aside>

      {/* ── Kolom kanan: thread FULLSCREEN. Pada desktop area setelah sidebar
          (15rem) dibagi ~38% untuk daftar dan sisanya untuk thread. Padding
          kiri menjaga alur halaman tetap sejajar dengan panel daftar fixed.
          Mobile: kartu tetap berada dalam alur halaman biasa. ── */}
      <div className="min-w-0 lg:pl-[calc(38vw-11rem)]">
        {/* ── Thread ── */}
        <Card className="flex max-h-[calc(100vh-220px)] min-h-[420px] flex-col overflow-hidden !rounded-none border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 lg:fixed lg:inset-y-0 lg:left-[calc(38vw+6rem)] lg:right-0 lg:z-20 lg:max-h-none lg:min-h-0 lg:border-0">
          {!selectedId ? (
            <div className="flex flex-1 items-center justify-center p-10">
              <div className="text-center">
                <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-400">
                  <IconChat className="size-7" />
                </span>
                <h3 className="mt-5 text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('inbox.selectTitle')}</h3>
                <p className="mt-1.5 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                  {t('inbox.selectDesc')}
                </p>
              </div>
            </div>
          ) : threadLoading ? (
            <div className="flex flex-1 items-center justify-center p-10">
              <p className="text-sm text-zinc-400">{t('inbox.loadingThread')}</p>
            </div>
          ) : threadError && !thread ? (
            <div className="flex flex-1 items-center justify-center p-10">
              <p className="text-sm text-red-600">{threadError}</p>
            </div>
          ) : thread ? (
            <>
              {/* Header thread */}
              <div className="border-b border-zinc-100 dark:border-zinc-800 px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-amber-400">
                    {(thread.conversation.customerName ?? thread.conversation.externalId ?? '?').slice(0, 1).toUpperCase()}
                    <ChannelAvatarBadge channelType={thread.conversation.channelType} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {thread.conversation.customerName ?? thread.conversation.externalId}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="text-xs text-zinc-400">{thread.conversation.externalId}</span>
                    </div>
                  </div>
                </div>

                {thread.booking && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2">
                    <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      📅 {thread.booking.title}
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {formatDateTimeFull(thread.booking.scheduledAt, thread.booking.timezone)}
                    </span>
                    <span
                      className={`ml-auto rounded-md px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${
                        thread.booking.status === 'confirmed'
                          ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400'
                          : thread.booking.status === 'cancelled'
                            ? 'bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400'
                            : thread.booking.status === 'completed'
                              ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
                              : 'bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400'
                      }`}
                    >
                      {(() => {
                        const key = bookingStatusKey(thread.booking.status);
                        return key ? t(key) : thread.booking.status;
                      })()}
                    </span>
                  </div>
                )}
              </div>

              {/* Pesan */}
              <div className="flex-1 space-y-3 overflow-y-auto bg-zinc-50/60 dark:bg-zinc-900/60 p-5">
                {thread.messages.length === 0 && (
                  <p className="py-10 text-center text-sm text-zinc-400">{t('inbox.noMessagesInThread')}</p>
                )}
                {thread.messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
                <div ref={threadEndRef} />
              </div>

              {/* Komposer */}
              <div className="border-t border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
                {threadError && <p className="mb-2 text-xs text-red-600">{threadError}</p>}
                <form onSubmit={sendReply} className="flex items-end gap-2">
                  <div className="flex-1">
                    <TextArea
                      label={t('inbox.replyLabel')}
                      isLabelHidden
                      value={reply}
                      onChange={setReply}
                      placeholder={t('inbox.replyPlaceholder')}
                      rows={2}
                      isDisabled={sending}
                      width="100%"
                    />
                  </div>
                  <Button
                    label={t('inbox.send')}
                    variant="primary"
                    icon={<IconSend className="size-4" />}
                    type="submit"
                    isDisabled={!reply.trim() || sending}
                    isLoading={sending}
                  />
                </form>
                {thread.booking && (thread.conversation.channelType === 'telegram' || thread.conversation.channelType === 'whatsapp') && (
                  <button
                    type="button"
                    onClick={() => void sendReminder()}
                    disabled={sendingReminder}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-600 transition hover:text-amber-500 disabled:opacity-50"
                  >
                    <IconArrowRight className="size-3.5" />
                    {sendingReminder ? t('inbox.sending') : t('inbox.sendReminder')}
                  </button>
                )}
              </div>
            </>
          ) : null}
        </Card>
      </div>

      {/* Empty state halaman hanya untuk mobile — di desktop daftar kosong
          sudah terwakili panel kiri ("No conversations") + placeholder chat
          kanan; kartu besar ini akan tertutup panel fixed chat. */}
      {loaded && conversations.length === 0 && (
        <div className="lg:hidden">
          <EmptyState
            icon={IconMail}
            title={t('inbox.emptyStateTitle')}
            description={t('inbox.emptyStateDesc')}
          />
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: InboxMessage }) {
  const inbound = message.direction === 'inbound';
  return (
    <div className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
          inbound
            ? 'rounded-tl-sm bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200'
            : 'rounded-tr-sm bg-amber-500 text-zinc-950'
        }`}
      >
        {/* `ph-no-capture`: isi pesan inbox = PII customer — jangan pernah
            ter-capture autocapture/session replay PostHog. */}
        <p className="whitespace-pre-wrap break-words ph-no-capture">{message.content}</p>
        <p className={`mt-1 text-right text-xs ${inbound ? 'text-zinc-400' : 'text-zinc-900/60 dark:text-zinc-100/60'}`}>
          {formatMessageTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}
