import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, TextArea } from '@astryxdesign/core';
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
import { IconAlertTriangle, IconArrowRight, IconChat, IconMail, IconSend } from '../shell/icons';
import { Card, EmptyState, PageHeader } from '../shell/ui';

const CHANNEL_STYLE: Record<string, string> = {
  telegram: 'bg-sky-500/10 text-sky-600',
  whatsapp: 'bg-emerald-500/10 text-emerald-600',
  email: 'bg-amber-500/10 text-amber-600',
};

function ChannelBadge({ channelType }: { channelType: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold ${CHANNEL_STYLE[channelType] ?? 'bg-zinc-500/10 text-zinc-500'}`}>
      {channelLabel(channelType)}
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

  const unreadTotal = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
  const attentionCount = conversations.filter((c) => c.needsAttention).length;

  const query = searchQuery.trim().toLowerCase();
  const visibleConversations = query
    ? conversations.filter((c) =>
        [c.customerName, c.externalId, c.bookingTitle, c.preview?.content]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query)),
      )
    : conversations;

  // Header dipakai dua kali: mobile di atas daftar, desktop di kolom kanan.
  const pageHeader = (
    <PageHeader
      title={t('inbox.title')}
      description={t('inbox.description')}
    >
      {unreadTotal > 0 && (
        <Badge variant="success" label={t('inbox.unread', { count: unreadTotal })} />
      )}
      {attentionCount > 0 && (
        <Badge variant="warning" label={t('inbox.attention', { count: attentionCount })} />
      )}
    </PageHeader>
  );

  return (
    <div className="space-y-6 lg:space-y-0">
      {/* Header — mobile saja (desktop: judul pindah ke kolom kanan). */}
      <div className="lg:hidden">{pageHeader}</div>

      {/* ── Daftar percakapan — desktop: kolom FIXED penuh tinggi tepat di
          sebelah sidebar aplikasi (left-60 = lebar sidebar; inset-y-0 = tinggi
          penuh viewport), border hanya di kanan, background putih. Di bawah
          lg kembali menjadi kartu biasa dalam alur halaman. ── */}
      <aside
        aria-label={t('inbox.title')}
        className="flex max-h-[calc(100vh-220px)] min-h-[420px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white lg:fixed lg:inset-y-0 lg:left-60 lg:z-30 lg:w-[340px] lg:max-h-none lg:min-h-0 lg:rounded-none lg:border-y-0 lg:border-l-0 lg:border-r lg:border-zinc-200"
      >
          <div className="border-b border-zinc-100 px-4 py-3">
            <div className="relative">
              <input
                aria-label={t('inbox.searchLabel')}
                placeholder={t('inbox.searchPlaceholder')}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-amber-400 focus:bg-white focus:ring-2 focus:ring-amber-500/10"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!loaded && <p className="p-6 text-center text-sm text-zinc-400">{t('inbox.loading')}</p>}
            {loaded && conversations.length === 0 && (
              <div className="p-6 text-center">
                <p className="text-sm font-medium text-zinc-600">{t('inbox.emptyListTitle')}</p>
                <p className="mt-1 text-xs text-zinc-400">
                  {t('inbox.emptyListDesc')}
                </p>
              </div>
            )}
            {query && visibleConversations.length === 0 && (
              <p className="p-6 text-center text-xs text-zinc-400">{t('inbox.noSearchResults')}</p>
            )}
            {listError && <p className="p-6 text-center text-xs text-red-600">{listError}</p>}

            <ul className="divide-y divide-zinc-100">
              {visibleConversations.map((conversation) => {
                const selected = conversation.id === selectedId;
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      onClick={() => void openThread(conversation.id)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition ${
                        selected ? 'bg-amber-500/5' : 'hover:bg-zinc-50'
                      }`}
                    >
                      <span className="relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-amber-400">
                        {(conversation.customerName ?? conversation.externalId ?? '?').slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-zinc-800">
                            {conversation.customerName ?? conversation.externalId}
                          </span>
                          {conversation.lastMessageAt && (
                            <span className="shrink-0 text-xs text-zinc-400">
                              {formatMessageTime(conversation.lastMessageAt)}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5">
                          <ChannelBadge channelType={conversation.channelType} />
                          {conversation.bookingTitle && (
                            <span className="truncate text-xs text-zinc-400">
                              {conversation.bookingTitle}
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block truncate text-xs text-zinc-500">
                          {conversation.preview
                            ? `${conversation.preview.direction === 'outbound' ? t('inbox.youPrefix') : ''}${conversation.preview.content}`
                            : t('inbox.noMessages')}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {conversation.needsAttention && (
                          <span className="flex items-center gap-1 rounded-md bg-orange-50 px-1.5 py-0.5 text-xs font-semibold text-orange-600">
                            <IconAlertTriangle className="size-3" /> {t('inbox.attentionBadge')}
                          </span>
                        )}
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
              <div className="border-t border-zinc-100 p-3 text-center">
                <Button label={t('common.loadMore')} variant="ghost" size="sm" onClick={() => void loadMore()} />
              </div>
            )}
          </div>
      </aside>

      {/* ── Kolom kanan: judul (desktop) + thread. pl-[308px] memberi ruang
          untuk kolom fixed di kiri (left-60 240px + w-[340px] = 580px; dikurangi
          padding kiri main 32px → 308px): pas di viewport sempit, aman (tidak
          tertutup) di viewport lebar. ── */}
      <div className="min-w-0 space-y-6 lg:pl-[308px]">
        <div className="hidden lg:block">{pageHeader}</div>

        {/* ── Thread ── */}
        <Card className="flex max-h-[calc(100vh-220px)] min-h-[420px] flex-col overflow-hidden">
          {!selectedId ? (
            <div className="flex flex-1 items-center justify-center p-10">
              <div className="text-center">
                <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400">
                  <IconChat className="size-7" />
                </span>
                <h3 className="mt-5 text-base font-semibold text-zinc-900">{t('inbox.selectTitle')}</h3>
                <p className="mt-1.5 max-w-sm text-sm text-zinc-500">
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
              <div className="border-b border-zinc-100 px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-amber-400">
                    {(thread.conversation.customerName ?? thread.conversation.externalId ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900">
                      {thread.conversation.customerName ?? thread.conversation.externalId}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <ChannelBadge channelType={thread.conversation.channelType} />
                      <span className="text-xs text-zinc-400">{thread.conversation.externalId}</span>
                    </div>
                  </div>
                  {thread.conversation.needsAttention && (
                    <span className="flex items-center gap-1 rounded-md bg-orange-50 px-2 py-1 text-xs font-semibold text-orange-600">
                      <IconAlertTriangle className="size-3.5" /> {t('inbox.attentionBadge')}
                    </span>
                  )}
                </div>

                {thread.booking && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2">
                    <span className="text-xs font-medium text-zinc-700">
                      📅 {thread.booking.title}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {formatDateTimeFull(thread.booking.scheduledAt, thread.booking.timezone)}
                    </span>
                    <span
                      className={`ml-auto rounded-md px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${
                        thread.booking.status === 'confirmed'
                          ? 'bg-emerald-50 text-emerald-600'
                          : thread.booking.status === 'cancelled'
                            ? 'bg-red-50 text-red-600'
                            : thread.booking.status === 'completed'
                              ? 'bg-zinc-100 text-zinc-500'
                              : 'bg-amber-50 text-amber-600'
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
              <div className="flex-1 space-y-3 overflow-y-auto bg-zinc-50/60 p-5">
                {thread.messages.length === 0 && (
                  <p className="py-10 text-center text-sm text-zinc-400">{t('inbox.noMessagesInThread')}</p>
                )}
                {thread.messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
                <div ref={threadEndRef} />
              </div>

              {/* Komposer */}
              <div className="border-t border-zinc-100 bg-white p-4">
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

      {loaded && conversations.length === 0 && (
        <EmptyState
          icon={IconMail}
          title={t('inbox.emptyStateTitle')}
          description={t('inbox.emptyStateDesc')}
        />
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
            ? 'rounded-tl-sm bg-white text-zinc-800'
            : 'rounded-tr-sm bg-amber-500 text-zinc-950'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
        <p className={`mt-1 text-right text-xs ${inbound ? 'text-zinc-400' : 'text-zinc-900/60'}`}>
          {formatMessageTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}
