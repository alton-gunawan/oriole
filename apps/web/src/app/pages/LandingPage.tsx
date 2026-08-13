import { type ComponentType, Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core';
import { motion } from 'framer-motion';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { AppLogo } from '../components/AppLogo';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBattery,
  IconCalendar,
  IconCheck,
  IconClock,
  IconCreditCard,
  IconChevronDown,
  IconChevronLeft,
  IconExternalLink,
  IconEyeOff,
  IconHelp,
  IconHourglass,
  IconHouseLine,
  IconMail,
  IconMicOff,
  IconPhone,
  IconPlug,
  IconRefreshCw,
  IconRepeat,
  IconSearchX,
  IconSignal,
  IconUsers,
  IconVideo,
  IconWebhook,
  IconWifi,
  type IconProps,
} from '../shell/icons';
import type { TranslationKey } from '../../i18n';
import { LocaleSwitcher } from '../shell/LocaleSwitcher';
import { apiFetch } from '../../lib/api';
import { getAccessToken } from '../../lib/token';
import { type ChannelListResponse } from '../../lib/messaging';
import { type IntegrationListResponse } from '../../lib/integrations';
import { loadObsidianConfig } from '../../lib/obsidian';
import { useSessionStore } from '../../stores/session';

type FooterLink = {
  labelKey: TranslationKey;
  href: string;
};

const footerColumns: { titleKey: TranslationKey; links: FooterLink[] }[] = [
  {
    titleKey: 'landing.footerProduct',
    links: [
      { labelKey: 'landing.footerHowItWorks', href: '#how-it-works' },
      { labelKey: 'landing.footerIntegrations', href: '#integrations' },
      { labelKey: 'landing.footerFaq', href: '#faq' },
    ],
  },
  {
    titleKey: 'landing.footerAccount',
    links: [
      { labelKey: 'landing.footerGetStarted', href: '/auth/sign-up' },
      { labelKey: 'landing.footerSignIn', href: '/auth/sign-in' },
    ],
  },
];

function FooterColumn({ column }: { column: (typeof footerColumns)[number] }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t(column.titleKey)}>
      <h2 className="text-[15px] font-medium text-[#101010]">{t(column.titleKey)}</h2>
      <ul className="mt-5 space-y-4">
        {column.links.map((link) => (
          <li key={link.labelKey}>
            <a
              href={link.href}
              className="text-[15px] leading-6 text-[#858585] transition-colors hover:text-[#1017e8]"
            >
              {t(link.labelKey)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Ilustrasi hero — alur conversation → booking: pesan customer, balasan AI,
 * lalu kartu booking terkonfirmasi. Statis (tanpa animasi) agar konsisten
 * dengan gaya kartu landing lain dan aman untuk prefers-reduced-motion. */
function HeroFlowIllustration() {
  const { t } = useTranslation();
  return (
    <div className="mt-16 w-full">
      <div className="flex flex-col items-stretch gap-10 rounded-3xl border border-[#e6ebef] bg-white px-6 py-8 shadow-[0_24px_60px_-40px_rgba(10,19,23,0.35)] sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-10 sm:py-10">
        {/* Langkah 1 — percakapan customer ↔ AI */}
        <div className="flex flex-1 flex-col gap-2.5">
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-[#e6ebef] bg-white px-3.5 py-2.5 text-xs leading-relaxed text-[#0a1317] shadow-sm sm:text-sm">
              {t('landing.heroFlowCustomerMsg')}
            </div>
          </div>
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-amber-500 px-3.5 py-2.5 text-xs leading-relaxed text-zinc-950 shadow-sm sm:text-sm">
              {t('landing.heroFlowAiMsg')}
            </div>
          </div>
        </div>

        {/* Panah alur — mengarah ke booking */}
        <div className="flex shrink-0 items-center justify-center text-[#1017e8]">
          <IconArrowRight className="size-5 rotate-90 sm:rotate-0" />
        </div>

        {/* Langkah 2 — booking terkonfirmasi */}
        <div className="flex flex-1 items-center gap-4 rounded-2xl border border-[#e6ebef] bg-[#f8fafb] px-5 py-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-[#1017e8] shadow-sm">
            <IconCalendar className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-[#0a1317]">
              <IconCheck className="size-4 shrink-0 text-emerald-500" />
              {t('landing.heroFlowBookingTitle')}
            </p>
            <p className="mt-0.5 text-xs text-[#4e606f]">{t('landing.heroFlowBookingMeta')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Integrasi yang benar-benar tersedia di Oriole. Brand mark memakai aset lokal
 * yang sama dengan halaman Integrations; fitur tanpa logo brand memakai Lucide.
 * Ini menjaga landing page tetap jujur: tidak menampilkan konektor yang belum ada.
 */
const integrationTiles = [
  { key: 'whatsapp', labelKey: 'landing.integrationWhatsapp', logo: '/brands/whatsapp.svg', icon: null, tone: 'bg-[#eafaf0]' },
  { key: 'telegram', labelKey: 'landing.integrationTelegram', logo: '/brands/telegram.svg', icon: null, tone: 'bg-[#eaf6ff]' },
  { key: 'slack', labelKey: 'landing.integrationSlack', logo: '/brands/slack.svg', icon: null, tone: 'bg-[#eef4f5]' },
  { key: 'instagram', labelKey: 'landing.integrationInstagram', logo: '/brands/instagram.svg', icon: null, tone: 'bg-[#fceef4]' },
  { key: 'facebook', labelKey: 'landing.integrationFacebook', logo: '/brands/facebook.svg', icon: null, tone: 'bg-[#eef3fc]' },
  { key: 'video', labelKey: 'landing.integrationVideo', logo: null, icon: IconVideo, tone: 'bg-[#eefaf6]' },
  { key: 'google-calendar', labelKey: 'landing.integrationGoogleCalendar', logo: '/brands/google-calendar.svg', icon: null, tone: 'bg-[#eef5ff]' },
  { key: 'google-forms', labelKey: 'landing.integrationGoogleForms', logo: '/brands/google-forms.svg', icon: null, tone: 'bg-[#fff3f0]' },
  { key: 'tally', labelKey: 'landing.integrationTally', logo: '/brands/tally.svg', icon: null, tone: 'bg-[#f5f5f5]' },
  { key: 'notion', labelKey: 'landing.integrationNotion', logo: '/brands/notion.svg', icon: null, tone: 'bg-[#f5f5f5]' },
  { key: 'obsidian', labelKey: 'landing.integrationObsidian', logo: '/brands/obsidian.svg', icon: null, tone: 'bg-[#f1edff]' },
  { key: 'email', labelKey: 'landing.integrationEmail', logo: null, icon: IconMail, tone: 'bg-[#fff8e8]' },
  { key: 'payments', labelKey: 'landing.integrationPayments', logo: null, icon: IconCreditCard, tone: 'bg-[#f1f0ff]' },
  { key: 'webhook', labelKey: 'landing.integrationWebhook', logo: null, icon: IconWebhook, tone: 'bg-[#eef4f5]' },
] as const;

function IntegrationTile({ tile, connected = false }: { tile: (typeof integrationTiles)[number]; connected?: boolean }) {
  const { t } = useTranslation();
  const TileIcon = tile.icon;
  const label = t(tile.labelKey);
  return (
    <div
      title={label}
      aria-label={label}
      className="group flex min-w-0 flex-col items-center gap-2"
    >
      <span
        className={`relative flex size-[4.25rem] items-center justify-center rounded-[1.35rem] border border-white/90 shadow-[0_10px_24px_-16px_rgba(10,19,23,0.55)] transition duration-300 group-hover:-translate-y-1 group-hover:shadow-[0_16px_30px_-16px_rgba(10,19,23,0.45)] sm:size-[5rem] ${tile.tone} ${connected ? 'ring-2 ring-emerald-400/80' : ''}`}
      >
        {tile.logo ? (
          <img src={tile.logo} alt="" className="size-10 object-contain sm:size-12" />
        ) : TileIcon ? (
          <TileIcon className="size-9 text-[#0a1317] sm:size-10" strokeWidth={1.7} aria-hidden="true" />
        ) : null}
        {connected && (
          <span
            title={t('landing.integrationConnected')}
            className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm"
          >
            <IconCheck className="size-3" strokeWidth={3} aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="max-w-[5.5rem] truncate text-center text-[10px] font-medium text-[#71808b] sm:text-[11px]">
        {label}
      </span>
    </div>
  );
}

/** Langkah "How it works" — step 1 & 2 berisi daftar item, step 3 alur pendek
 * (Customer asks ↓ AI understands ↓ Booking completed). */
const howItWorksSteps = [
  {
    step: 1,
    image: '/images/setup-business-info.png',
    titleKey: 'landing.howStep1Title',
    descKey: 'landing.howStep1Desc',
    itemKeys: [
      'landing.howStep1Item1',
      'landing.howStep1Item2',
      'landing.howStep1Item3',
      'landing.howStep1Item4',
    ],
  },
  {
    step: 2,
    image: '/images/setup-channels.png',
    titleKey: 'landing.howStep2Title',
    descKey: 'landing.howStep2Desc',
    itemKeys: ['landing.howStep2Item1', 'landing.howStep2Item2', 'landing.howStep2Item3'],
  },
  {
    step: 3,
    image: '/images/setup-ai-booking.png',
    titleKey: 'landing.howStep3Title',
    descKey: 'landing.howStep3Desc',
    flowKeys: ['landing.howStep3Flow1', 'landing.howStep3Flow2', 'landing.howStep3Flow3'],
  },
] as const;

/** Pesan demo chat — customer (kiri, bubble putih) vs AI (kanan, bubble amber),
 * jam statis agar terasa seperti percakapan sungguhan. */
const demoMessages = [
  { sender: 'customer', time: '09:41', textKey: 'landing.demoMsg1Customer' },
  { sender: 'ai', time: '09:41', textKey: 'landing.demoMsg1Ai' },
  { sender: 'customer', time: '09:42', textKey: 'landing.demoMsg2Customer' },
  { sender: 'ai', time: '09:43', textKey: 'landing.demoMsg2Ai' },
] as const;

/** Tautan form demo — Tally (salah satu integrasi form app; kontrak URL
 * tally.so/r/… dipakai backend saat mengirim tautan ke customer).
 * UID ilustratif untuk mock landing. */
const demoFormUrl = 'https://tally.so/r/oriole-booking';

/** Langkah formulir Tally — satu pertanyaan per layar. Nama diketik (input),
 * sisanya pilihan chip; nilai terpilih memakai kunci demoForm*Value lama,
 * opsi kedua memakai kunci demoForm*Opt2. */
const formSteps = [
  { labelKey: 'landing.demoFormName', valueKey: 'landing.demoFormNameValue', kind: 'text' },
  {
    labelKey: 'landing.demoFormService',
    valueKey: 'landing.demoFormServiceValue',
    option2Key: 'landing.demoFormServiceOpt2',
    kind: 'chips',
  },
  {
    labelKey: 'landing.demoFormDate',
    valueKey: 'landing.demoFormDateValue',
    option2Key: 'landing.demoFormDateOpt2',
    kind: 'chips',
  },
  {
    labelKey: 'landing.demoFormTime',
    valueKey: 'landing.demoFormTimeValue',
    option2Key: 'landing.demoFormTimeOpt2',
    kind: 'chips',
  },
] as const;

/** Percakapan chat di kartu form — ala CONVERSATIONAL BOOKING: AI menjawab
 * pertanyaan, mengirim tautan Tally, lalu (setelah form diisi) customer
 * konfirmasi dan AI membalas otomatis. Indeks 0–3 = sebelum form, 4–5 = setelah. */
const formChatMessages = [
  { sender: 'customer', time: '09:41', textKey: 'landing.demoFormChat1Customer', link: false },
  { sender: 'ai', time: '09:41', textKey: 'landing.demoFormChat1Ai', link: false },
  { sender: 'customer', time: '09:42', textKey: 'landing.demoFormChat2Customer', link: false },
  { sender: 'ai', time: '09:43', textKey: 'landing.demoFormChat2Ai', link: true },
  { sender: 'customer', time: '09:44', textKey: 'landing.demoFormChat3Customer', link: false },
  { sender: 'ai', time: '09:44', textKey: 'landing.demoFormChat3Ai', link: false },
] as const;

/** Transkrip panggilan konfirmasi — meniru panggilan AI: agen berbicara,
 * pelanggan menjawab, lalu booking dikonfirmasi. */
const callTranscript = [
  { speaker: 'ai', time: '09:41', textKey: 'landing.demoCallAi1' },
  { speaker: 'customer', time: '09:42', textKey: 'landing.demoCallCustomer1' },
  { speaker: 'ai', time: '09:42', textKey: 'landing.demoCallAi2' },
] as const;

/** Kartu "Who it's for" — emoji statis, judul/deskripsi dari katalog i18n. */
const whoForCards = [
  { emoji: '💅', titleKey: 'landing.whoBeautyTitle', descKey: 'landing.whoBeautyDesc' },
  { emoji: '🩺', titleKey: 'landing.whoHealthTitle', descKey: 'landing.whoHealthDesc' },
  { emoji: '💼', titleKey: 'landing.whoProTitle', descKey: 'landing.whoProDesc' },
  { emoji: '🏪', titleKey: 'landing.whoLocalTitle', descKey: 'landing.whoLocalDesc' },
] as const;

const landingFaqs = [
  { questionKey: 'help.faq1q', answerKey: 'help.faq1a' },
  { questionKey: 'help.faq2q', answerKey: 'help.faq2a' },
  { questionKey: 'help.faq3q', answerKey: 'help.faq3a' },
  { questionKey: 'help.faq4q', answerKey: 'help.faq4a' },
  { questionKey: 'help.faq5q', answerKey: 'help.faq5a' },
] as const;

const painPoints = [
  {
    icon: IconClock,
    titleKey: 'landing.painSupportTitle',
    descKey: 'landing.painSupportDesc',
  },
  {
    icon: IconSearchX,
    titleKey: 'landing.painAnswersTitle',
    descKey: 'landing.painAnswersDesc',
  },
  {
    icon: IconHourglass,
    titleKey: 'landing.painResponseTitle',
    descKey: 'landing.painResponseDesc',
  },
  {
    icon: IconEyeOff,
    titleKey: 'landing.painVisibilityTitle',
    descKey: 'landing.painVisibilityDesc',
  },
] as const;

/** Kartu fitur solusi — judul/deskripsi/label/daftar item dari katalog i18n. */
const solutionCards = [
  {
    titleKey: 'landing.solutionConvoTitle',
    descKey: 'landing.solutionConvoDesc',
    labelKey: 'landing.solutionConvoLabel',
    itemKeys: [
      'landing.solutionConvoItem1',
      'landing.solutionConvoItem2',
      'landing.solutionConvoItem3',
      'landing.solutionConvoItem4',
      'landing.solutionConvoItem5',
    ],
  },
  {
    titleKey: 'landing.solutionBookingTitle',
    descKey: 'landing.solutionBookingDesc',
    labelKey: 'landing.solutionBookingLabel',
    itemKeys: [
      'landing.solutionBookingItem1',
      'landing.solutionBookingItem2',
      'landing.solutionBookingItem3',
      'landing.solutionBookingItem4',
    ],
  },
  {
    titleKey: 'landing.solutionAwareTitle',
    descKey: 'landing.solutionAwareDesc',
    labelKey: 'landing.solutionAwareLabel',
    itemKeys: [
      'landing.solutionAwareItem1',
      'landing.solutionAwareItem2',
      'landing.solutionAwareItem3',
      'landing.solutionAwareItem4',
    ],
  },
  {
    titleKey: 'landing.solutionToolsTitle',
    descKey: 'landing.solutionToolsDesc',
    labelKey: 'landing.solutionToolsLabel',
    itemKeys: [
      'landing.solutionToolsItem1',
      'landing.solutionToolsItem2',
      'landing.solutionToolsItem3',
      'landing.solutionToolsItem4',
      'landing.solutionToolsItem5',
    ],
  },
] as const;

/** Indikator suara (equalizer kecil) — muncul saat pembicara sedang berbicara,
 * seperti indikator voice-activity di panggilan sungguhan. */
function VoiceWave({ tone }: { tone: 'amber' | 'white' }) {
  const bar = tone === 'amber' ? 'bg-amber-300' : 'bg-white/80';
  return (
    <span className="inline-flex h-3 items-end gap-[2px]" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className={`w-[2px] rounded-full ${bar}`}
          animate={{ height: [3, 9, 4, 10, 3] }}
          transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.12, ease: 'easeInOut' }}
        />
      ))}
    </span>
  );
}

/** Reveal kata per kata untuk baris transkrip live (gaya caption realtime) —
 * kata muncul bertahap dengan kursor berkedip; saat reduced-motion tampil penuh. */
function LiveCaption({
  text,
  words,
  animate,
  cursorKey,
}: {
  text: string;
  words: number;
  animate: boolean;
  cursorKey: string;
}) {
  const visible = text.split(/\s+/).slice(0, words).join(' ');
  return (
    <span>
      {visible}
      {animate && words < text.split(/\s+/).length && (
        <span
          key={cursorKey}
          className="ml-0.5 inline-block h-3 w-px animate-pulse bg-amber-300 align-middle"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

/** Efek ketik untuk input nama — karakter muncul satu per satu dengan kursor
 * berkedip; saat reduced-motion langsung tampil penuh (tanpa animasi). */
function Typewriter({ text, filled, animate }: { text: string; filled: boolean; animate: boolean }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!filled) {
      setCount(0);
      return;
    }
    if (!animate) {
      setCount(text.length);
      return;
    }
    if (count >= text.length) return;
    const timer = setTimeout(() => setCount((current) => current + 1), 45);
    return () => clearTimeout(timer);
  }, [filled, animate, count, text.length]);

  return (
    <span>
      {text.slice(0, count)}
      {animate && count < text.length && (
        <span
          className="ml-0.5 inline-block h-3.5 w-px translate-y-0.5 animate-pulse bg-[#1017e8]"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

/** Tombol "Open app" untuk user yang sudah login — bordered satu warna
 * (indigo brand), tanpa shadow. */
function OpenAppButton({ size }: { size: 'sm' | 'lg' }) {
  const { t } = useTranslation();
  return (
    <a
      href="/app/dashboard"
      className={`inline-flex items-center gap-1.5 rounded-[10px] border border-[#1017e8] bg-white text-[#1017e8] transition hover:bg-[#f0f1ff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1017e8] ${
        size === 'lg' ? 'h-9 px-4' : 'h-7 px-3'
      }`}
    >
      <IconHouseLine className="size-4" aria-hidden="true" />
      <span className="text-base font-medium">{t('landing.goToDashboard')}</span>
    </a>
  );
}

/** Topik kecil tiap seksi — ikon di kiri + satu kata (eyebrow polos, tanpa
 * pill/padding/shadow), tampil di atas judul seksi. tone="dark" untuk latar
 * gelap (seksi pain). */
function SectionTopic({
  icon: TopicIcon,
  word,
  tone = 'light',
}: {
  icon: ComponentType<IconProps>;
  word: string;
  tone?: 'light' | 'dark';
}) {
  const isDark = tone === 'dark';
  return (
    <div
      className={`mb-4 inline-flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.2em] ${
        isDark ? 'text-white' : 'text-[#1017e8]'
      }`}
    >
      <TopicIcon
        className={`size-4 ${isDark ? 'text-amber-300' : 'text-[#1017e8]'}`}
        strokeWidth={2}
        aria-hidden="true"
      />
      {word}
    </div>
  );
}

export function LandingPage() {
  const { t } = useTranslation();
  // User yang sudah login tidak melihat CTA "Sign in / Get started" —
  // diganti tombol tunggal menuju dashboard app.
  const isAuthenticated = useSessionStore((s) => s.status === 'authenticated');

  // ── Status integrasi live (user login saja) ───────────────
  // Saat integrasi/channel diubah di halaman Integrations, seksi "Everything
  // your business needs, connected." ikut ter-update otomatis: tile yang
  // terhubung ditandai centang + deskripsi menampilkan jumlah terhubung.
  // null = visitor anonim / API gagal → tampilan statis marketing.
  const [connectedTiles, setConnectedTiles] = useState<Set<string> | null>(null);

  const loadIntegrationState = useCallback(async () => {
    try {
      const [channelsRes, integrationsRes] = await Promise.all([
        apiFetch<ChannelListResponse>('/channels'),
        apiFetch<IntegrationListResponse>('/integrations'),
      ]);
      const connected = new Set<string>();
      for (const ch of channelsRes.channels) {
        if (!ch.isActive) continue;
        if (ch.channelType === 'whatsapp') connected.add('whatsapp');
        if (ch.channelType === 'telegram') connected.add('telegram');
        if (ch.channelType === 'email') connected.add('email');
        if (ch.channelType === 'instagram') connected.add('instagram');
        if (ch.channelType === 'facebook') connected.add('facebook');
      }
      for (const item of integrationsRes.integrations) {
        if (!item.isActive) continue;
        // Key tile ≡ integrationType (lihat integrationTiles) — bukan
        // whitelist terpisah yang bisa melenceng saat integrasi baru ditambah.
        if (item.integrationType === 'google-calendar') connected.add('google-calendar');
        if (item.integrationType === 'google-forms') connected.add('google-forms');
        if (item.integrationType === 'tally') connected.add('tally');
        if (item.integrationType === 'notion') connected.add('notion');
        if (item.integrationType === 'webhook') connected.add('webhook');
        if (item.integrationType === 'payments') connected.add('payments');
        if (item.integrationType === 'slack') connected.add('slack');
        if (item.integrationType === 'video') connected.add('video');
      }
      // Obsidian tersimpan lokal per perangkat (browser) — bukan API.
      if (loadObsidianConfig()) connected.add('obsidian');
      setConnectedTiles(connected);
    } catch {
      // 401 / API down → tampilan statis; jangan ganggu halaman publik.
      setConnectedTiles(null);
    }
  }, []);

  useEffect(() => {
    // Hanya user login yang punya state integrasi nyata — visitor anonim
    // tidak perlu memanggil API sama sekali.
    if (!getAccessToken()) return;
    void loadIntegrationState();
    // "Otomatis": refresh saat tab difokuskan kembali (mis. integrasi diubah
    // di tab lain, lalu kembali ke landing page).
    const onFocus = () => void loadIntegrationState();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadIntegrationState]);

  // ── Animasi demo chat: pesan muncul satu per satu + indikator mengetik,
  // lalu loop dari awal. Hormati prefers-reduced-motion (tampil statis). ──
  const [reducedMotion, setReducedMotion] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(media.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    if (visibleCount >= demoMessages.length) {
      // Semua pesan tampil → jeda, lalu ulang dari awal.
      setTyping(false);
      const timer = setTimeout(() => setVisibleCount(0), 3000);
      return () => clearTimeout(timer);
    }
    const message = demoMessages[visibleCount];
    if (message.sender === 'ai') {
      // Sebelum balasan AI: tampilkan indikator mengetik dulu.
      setTyping(true);
      const timer = setTimeout(() => {
        setTyping(false);
        setVisibleCount((count) => count + 1);
      }, 1400);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setVisibleCount((count) => count + 1), 1100);
    return () => clearTimeout(timer);
  }, [visibleCount, reducedMotion]);

  // ── Animasi kartu form: chat (ala CONVERSATIONAL BOOKING) mengirim tautan
  // Tally → form terisi → kembali ke chat untuk konfirmasi AI — loop. ──
  const [formStage, setFormStage] = useState<'chat' | 'form'>('chat');
  const [chatCount, setChatCount] = useState(0);
  const [chatTyping, setChatTyping] = useState(false);
  const [formVisited, setFormVisited] = useState(false);
  const [formPhase, setFormPhase] = useState(0);
  const [formFilled, setFormFilled] = useState(false);
  const [callVisibleCount, setCallVisibleCount] = useState(0);
  const [callWordCount, setCallWordCount] = useState(0);
  const [callConnected, setCallConnected] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  useEffect(() => {
    if (reducedMotion) return;
    if (formStage === 'chat') {
      const next = chatCount < formChatMessages.length ? formChatMessages[chatCount] : null;
      if (next && (chatCount < 4 || formVisited)) {
        // Pesan berikutnya — indikator mengetik dulu sebelum balasan AI.
        if (next.sender === 'ai' && !chatTyping) {
          setChatTyping(true);
          const timer = setTimeout(() => {
            setChatTyping(false);
            setChatCount((count) => count + 1);
          }, 950);
          return () => clearTimeout(timer);
        }
        const timer = setTimeout(() => setChatCount((count) => count + 1), 1250);
        return () => clearTimeout(timer);
      }
      if (chatCount >= 4 && !formVisited) {
        // Percakapan sebelum form selesai (tautan terkirim) → pindah ke form.
        const timer = setTimeout(() => {
          setFormStage('form');
          setFormPhase(0);
          setFormFilled(false);
          setFormVisited(true);
        }, 1800);
        return () => clearTimeout(timer);
      }
      if (chatCount >= formChatMessages.length) {
        // Seluruh alur selesai → jeda, lalu ulang dari awal.
        const timer = setTimeout(() => {
          setChatCount(0);
          setChatTyping(false);
          setFormVisited(false);
        }, 3600);
        return () => clearTimeout(timer);
      }
      return;
    }
    // form stage
    if (formPhase >= formSteps.length) {
      // Form terisi (tombol confirm) → kembali ke chat, lanjut percakapan.
      setFormFilled(false);
      const timer = setTimeout(() => {
        setFormStage('chat');
        setChatCount(4);
      }, 1500);
      return () => clearTimeout(timer);
    }
    if (!formFilled) {
      // Pertanyaan tampil dulu, lalu jawaban terisi.
      const timer = setTimeout(() => setFormFilled(true), 1000);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      setFormPhase((current) => current + 1);
      setFormFilled(false);
    }, 1600);
    return () => clearTimeout(timer);
  }, [formStage, chatCount, chatTyping, formVisited, formPhase, formFilled, reducedMotion]);

  // ── Mesin panggilan: ringing (avatar berdenyut) → tersambung
  // (timer berjalan + transkrip realtime kata per kata) → selesai → loop. ──
  useEffect(() => {
    if (reducedMotion) return;
    if (callVisibleCount >= callTranscript.length) {
      // Panggilan selesai — jeda, lalu mulai ringing lagi dari awal.
      const timer = setTimeout(() => {
        setCallConnected(false);
        setCallSeconds(0);
        setCallVisibleCount(0);
        setCallWordCount(0);
      }, 2800);
      return () => clearTimeout(timer);
    }

    if (!callConnected) {
      // Fase ringing — visual saja, tanpa audio.
      const timer = setTimeout(() => setCallConnected(true), 3200);
      return () => clearTimeout(timer);
    }

    const current = callTranscript[callVisibleCount];
    const wordTotal = t(current.textKey).split(/\s+/).length;

    if (callWordCount < wordTotal) {
      // Baris aktif sedang dibicarakan — tambah kata berikutnya.
      const timer = setTimeout(() => setCallWordCount((count) => count + 1), 340);
      return () => clearTimeout(timer);
    }

    // Baris selesai — jeda singkat, lalu pembicara berikutnya mulai.
    const timer = setTimeout(() => {
      setCallVisibleCount((count) => count + 1);
      setCallWordCount(0);
    }, 500);
    return () => clearTimeout(timer);
  }, [callVisibleCount, callWordCount, callConnected, reducedMotion, t]);

  // Timer panggilan — berjalan (dan reset) hanya saat panggilan tersambung.
  useEffect(() => {
    if (reducedMotion || !callConnected) return;
    const timer = setTimeout(() => setCallSeconds((s) => s + 1), 1000);
    return () => clearTimeout(timer);
  }, [callConnected, callSeconds, reducedMotion]);

  // Pembicara aktif: saat agen AI berbicara → avatar tengah berganti ke ikon
  // app (bulat penuh); saat pelanggan/awal panggilan → avatar "S" tetap tampil.
  const activeSpeaker =
    reducedMotion || callVisibleCount >= callTranscript.length
      ? 'ai'
      : callVisibleCount > 0
        ? callTranscript[callVisibleCount - 1].speaker
        : null;
  const callDurationText = `${String(Math.floor(callSeconds / 60)).padStart(2, '0')}:${String(
    callSeconds % 60,
  ).padStart(2, '0')}`;
  return (
    <main className="flex min-h-screen flex-col bg-[#f8fafb] text-[#0a1317]">
      <header>
        <div className="mx-auto flex h-[72px] w-full max-w-5xl items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5" aria-label={t('landing.ariaHome')}>
            <span className="flex size-8 items-center justify-center overflow-hidden rounded-md bg-[#0a1317] shadow-sm">
              <AppLogo />
            </span>
            <span className="text-[15px] font-semibold tracking-[-0.03em] text-[#0a1317]">oriole</span>
          </Link>
          <div className="flex items-center gap-2.5">
            <LocaleSwitcher />
            {isAuthenticated ? (
              <OpenAppButton size="sm" />
            ) : (
              <>
                <Button label={t('landing.signIn')} variant="ghost" size="sm" href="/auth/sign-in" />
                <Button label={t('landing.getStarted')} variant="primary" size="sm" href="/auth/sign-up" />
              </>
            )}
          </div>
        </div>
      </header>

      <section className="flex flex-1 items-center justify-center px-5 py-24 sm:px-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-start text-left">
          <h1 className="text-3xl font-semibold leading-[1.1] tracking-[-0.05em] text-[#0a1317] sm:text-5xl">
            {t('landing.heroHeadline')}
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-[#4e606f] sm:text-lg sm:leading-8">
            {t('landing.heroSubheadline')}
          </p>

          {/* Ilustrasi alur conversation → booking (tetap dalam hero) */}
          <HeroFlowIllustration />
        </div>
      </section>

      {/* Pain points — empat kolom masalah utama seperti template referensi */}
      <section className="relative overflow-hidden border-y border-[#232850] bg-[#0d1130] px-5 py-20 text-white sm:px-8 sm:py-24">
        {/* Glow indigo halus — pola sama dengan seksi Integrasi, memperkuat warna brand */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 size-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1017e8]/15 blur-3xl" aria-hidden="true" />
        <div className="relative mx-auto w-full max-w-5xl">
          <SectionTopic icon={IconAlertTriangle} word={t('landing.topicPain')} tone="dark" />
          <h2 className="max-w-3xl whitespace-pre-line text-2xl font-semibold leading-[1.15] tracking-[-0.04em] text-white sm:text-4xl">
            <Trans
              i18nKey="landing.painTitle"
              components={{ strong: <strong className="text-amber-300" /> }}
            />
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-7 text-[#adb3c7] sm:text-lg sm:leading-8">
            <Trans
              i18nKey="landing.painDesc"
              components={{ strong: <strong className="font-semibold text-amber-300" /> }}
            />
          </p>

          <div className="mt-14 grid grid-cols-1 gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-4 lg:gap-x-10 lg:gap-y-0">
            {painPoints.map((point) => {
              const PointIcon = point.icon;
              return (
                <article key={point.titleKey}>
                  <PointIcon className="size-8 text-[#969caf]" strokeWidth={1.8} aria-hidden="true" />
                  <h3 className="mt-9 text-base font-semibold leading-tight tracking-[-0.02em] text-white sm:text-lg lg:min-h-[3rem]">
                    {t(point.titleKey)}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#adb3c7]">
                    {t(point.descKey)}
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* Integrasi — mengikuti pola visual referensi, tetapi memakai konektor nyata */}
      <section id="integrations" className="relative scroll-mt-6 overflow-hidden border-y border-[#e6ebef] bg-white px-5 py-24 sm:px-8 sm:py-28">
        <div className="pointer-events-none absolute left-1/2 top-24 size-[28rem] -translate-x-1/2 rounded-full bg-[#eef0ff] opacity-60 blur-3xl" aria-hidden="true" />
        <div className="relative mx-auto w-full max-w-5xl text-center">
          <SectionTopic icon={IconPlug} word={t('landing.topicIntegrations')} />
          <h2 className="mx-auto max-w-4xl text-2xl font-semibold leading-[1.1] tracking-[-0.05em] text-[#0a1317] sm:text-4xl lg:text-5xl">
            {t('landing.integrationTitle')}
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-[#4e606f] sm:text-lg sm:leading-8">
            {connectedTiles !== null
              ? t('landing.integrationConnectedDesc', {
                  count: connectedTiles.size,
                  total: integrationTiles.length,
                })
              : t('landing.integrationDesc')}
          </p>

          <div className="mx-auto mt-14 grid max-w-4xl grid-cols-3 gap-x-4 gap-y-7 sm:grid-cols-5 sm:gap-x-8 sm:gap-y-9 lg:gap-x-10">
            {integrationTiles.map((tile) => (
              <IntegrationTile
                key={tile.key}
                tile={tile}
                connected={connectedTiles !== null && connectedTiles.has(tile.key)}
              />
            ))}
          </div>

          <p className="mx-auto mt-14 max-w-3xl text-base leading-7 text-[#0a1317] sm:text-lg sm:leading-8">
            {t('landing.integrationFootnote')}
          </p>
        </div>
      </section>

      {/* Solusi — satu asisten AI yang menangani seluruh alur booking */}
      <section className="px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          <SectionTopic icon={IconCalendar} word={t('landing.topicSolution')} />
          <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] tracking-[-0.04em] text-[#0a1317] sm:text-4xl">
            {t('landing.solutionTitle')}
          </h2>

          <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {solutionCards.map((card) => (
              <div
                key={card.titleKey}
                className="flex flex-col rounded-2xl border border-[#e6ebef] bg-white p-6"
              >
                <h3 className="text-base font-semibold tracking-[-0.02em] text-[#0a1317] sm:text-lg">
                  {t(card.titleKey)}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#4e606f]">
                  {t(card.descKey)}
                </p>
                <div className="mt-5 border-t border-[#e6ebef] pt-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#1017e8]">
                    {t(card.labelKey)}
                  </p>
                  <ul className="mt-3 space-y-2">
                    {card.itemKeys.map((itemKey) => (
                      <li key={itemKey} className="flex items-start gap-2 text-sm leading-6 text-[#4e606f]">
                        <IconCheck className="mt-1 size-3.5 shrink-0 text-[#1017e8]" />
                        {t(itemKey)}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Cara kerja — tiga langkah menuju asisten AI */}
      <section id="how-it-works" className="scroll-mt-6 border-y border-[#e6ebef] bg-white px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          <SectionTopic icon={IconRepeat} word={t('landing.topicHow')} />
          <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] tracking-[-0.04em] text-[#0a1317] sm:text-4xl">
            {t('landing.howTitle')}
          </h2>

          <div className="mt-12 grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-3 lg:gap-x-10">
            {howItWorksSteps.map((step) => {
              return (
                <article key={step.titleKey}>
                  <div className="aspect-[1.08] overflow-hidden rounded-2xl border border-[#e6ebef] bg-[#f8fafb]">
                    <img
                      src={step.image}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  </div>
                  <div className="mt-5 text-sm leading-6 sm:text-base sm:leading-7">
                    <h3 className="inline font-semibold tracking-[-0.02em] text-[#0a1317]">
                      {t(step.titleKey)}
                    </h3>{' '}
                    <p className="inline text-[#858585]">{t(step.descKey)}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* Demo percakapan — mock chat customer ↔ AI */}
      <section className="px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          <SectionTopic icon={IconVideo} word={t('landing.topicDemo')} />
          <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] tracking-[-0.04em] text-[#0a1317] sm:text-4xl">
            {t('landing.demoTitle')}
          </h2>
          <p className="mt-5 text-base leading-7 text-[#4e606f] sm:text-lg sm:leading-8">
            {t('landing.demoDesc')}
          </p>

          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
            {/* Chat — booking lewat percakapan */}
            <div className="flex flex-col">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[#1017e8]">
                {t('landing.demoChatCaption')}
              </p>
              {/* Tinggi FIXED (h-[36.5rem]) agar frame phone tidak pernah berubah
                  saat animasi loop berjalan — konten penuh (±577px) selalu muat;
                  overflow-y-auto di area pesan jadi jaring pengaman bila kolom
                  sangat sempit (pesan baru tetap menempel di bawah). */}
              <div className="flex h-[36.5rem] flex-col overflow-hidden rounded-2xl border border-[#e6ebef] bg-white shadow-sm">
              {/* Header chat */}
              <div className="flex items-center gap-3 border-b border-[#e6ebef] px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#0a1317]">
                  <AppLogo />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[#0a1317]">{t('landing.demoAssistant')}</p>
                  <p className="flex items-center gap-1.5 text-xs text-[#4e606f]">
                    <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                    {t('landing.demoOnline')}
                  </p>
                </div>
              </div>

              {/* Pesan — muncul satu per satu (loop) + indikator mengetik.
                  Overflow DIHILANGKAN (bukan scroll): pesan terbaru menempel
                  di bawah, yang lebih lama terpotong di atas; header tetap. */}
              <div className="flex min-h-0 flex-1 flex-col justify-end space-y-4 overflow-hidden px-4 py-5">
                {(reducedMotion ? demoMessages : demoMessages.slice(0, visibleCount)).map((message) => {
                  const isCustomer = message.sender === 'customer';
                  return (
                    <motion.div
                      key={message.textKey}
                      initial={{ opacity: 0, y: 10, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ duration: 0.35, ease: 'easeOut' }}
                      className={isCustomer ? 'flex justify-start' : 'flex justify-end'}
                    >
                      <div className="max-w-[85%]">
                        <p
                          className={`mb-1 text-[11px] font-semibold ${isCustomer ? 'text-[#4e606f]' : 'text-amber-700'}`}
                        >
                          {isCustomer ? t('landing.demoCustomerLabel') : t('landing.demoAiLabel')}
                        </p>
                        <div
                          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
                            isCustomer
                              ? 'rounded-tl-sm border border-[#e6ebef] bg-white text-[#0a1317]'
                              : 'rounded-tr-sm bg-amber-500 text-zinc-950'
                          }`}
                        >
                          <p className="whitespace-pre-line">{t(message.textKey)}</p>
                          <p className={`mt-1 text-right text-[10px] ${isCustomer ? 'text-[#8a9aa8]' : 'text-zinc-900/60'}`}>
                            {message.time}
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}

                {!reducedMotion && typing && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex justify-end"
                  >
                    <div className="flex items-center gap-1.5 rounded-2xl rounded-tr-sm bg-amber-500 px-4 py-3.5">
                      {[0, 1, 2].map((dot) => (
                        <motion.span
                          key={dot}
                          className="size-1.5 rounded-full bg-zinc-950/70"
                          animate={{ y: [0, -3, 0], opacity: [0.35, 1, 0.35] }}
                          transition={{ duration: 0.8, repeat: Infinity, delay: dot * 0.18, ease: 'easeInOut' }}
                        />
                      ))}
                    </div>
                  </motion.div>
                )}
              </div>
              </div>
            </div>

            {/* AI Call — panggilan konfirmasi otomatis */}
            <div className="flex flex-col">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[#1017e8]">
                {t('landing.demoCallCaption')}
              </p>
              {/* Layar panggilan — avatar tengah TETAP tampil; saat agen AI
                  menjawab avatar berganti ikon app (bulat penuh). Live transcript
                  di posisi FIXED antara teks ringing dan tombol aksi bawah. */}
              <div className="flex flex-1 flex-col overflow-hidden rounded-2xl bg-[#0a1317] shadow-sm">
                {/* Status bar */}
                <div className="flex items-center justify-between px-5 pt-3 text-[10px] font-medium tabular-nums text-white/70">
                  <span>9:41</span>
                  <div className="flex items-center gap-1.5">
                    <IconSignal className="size-3" />
                    <IconWifi className="size-3.5" />
                    <IconBattery className="size-4" />
                  </div>
                </div>

                {/* Header panggilan — tombol kembali + nama + status panggilan */}
                <div className="relative flex items-center justify-center px-4 pt-2">
                  <IconChevronLeft className="absolute left-4 size-5 text-white/90" />
                  <div className="text-center">
                    <p className="text-[15px] font-semibold tracking-[-0.02em] text-white">
                      {t('landing.demoCallContact')}
                    </p>
                    <p className="mt-0.5 text-xs text-white/60">
                      {reducedMotion || callVisibleCount >= callTranscript.length
                        ? t('landing.demoCallStatus')
                        : callConnected
                          ? `${t('landing.demoCallConnected')} · ${callDurationText}`
                          : t('landing.demoCallConnecting')}
                    </p>
                  </div>
                </div>

                {/* Tengah — avatar bulat penuh + status panggilan; avatar berganti
                    ke ikon app saat agen AI berbicara. Saat ringing:
                    cincin denyut menyebar + teks "Ringing…" ala panggilan sungguhan. */}
                <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-6">
                  <div className="relative flex size-24 items-center justify-center">
                    {!reducedMotion && !callConnected && callVisibleCount < callTranscript.length && (
                      <>
                        <motion.span
                          className="absolute inset-0 rounded-full bg-amber-500/25"
                          animate={{ scale: [1, 1.55], opacity: [0.5, 0] }}
                          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                          aria-hidden="true"
                        />
                        <motion.span
                          className="absolute inset-0 rounded-full bg-amber-500/15"
                          animate={{ scale: [1, 1.3], opacity: [0.45, 0] }}
                          transition={{ duration: 1.6, repeat: Infinity, delay: 0.45, ease: 'easeOut' }}
                          aria-hidden="true"
                        />
                      </>
                    )}
                    <motion.span
                      key={activeSpeaker}
                      initial={{ scale: 0.85, opacity: 0.6 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.25, ease: 'easeOut' }}
                      className={`relative flex size-24 items-center justify-center overflow-hidden rounded-full transition-colors duration-300 ${
                        activeSpeaker === 'ai' ? 'bg-amber-500/20' : 'bg-amber-500/15'
                      }`}
                    >
                      {activeSpeaker === 'ai' ? (
                        <AppLogo className="size-14" />
                      ) : (
                        <span className="text-4xl font-bold text-amber-400">S</span>
                      )}
                    </motion.span>
                  </div>
                  <p className="text-sm font-medium text-white/80">
                    {activeSpeaker === 'ai'
                      ? t('landing.demoCallAgent')
                      : activeSpeaker === 'customer'
                        ? t('landing.demoCallCustomer')
                        : !callConnected && callVisibleCount < callTranscript.length
                          ? t('landing.demoCallRinging')
                          : t('landing.demoCallContact')}
                  </p>
                </div>

                {/* Live transcript — gaya YouTube: daftar baris polos (waktu +
                    pembicara + teks), baris yang sedang dibicarakan disorot;
                    posisi FIXED antara teks ringing dan tombol aksi. */}
                <div className="border-t border-white/10 px-4 pb-4 pt-3">
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">
                      {t('landing.demoCallTranscript')}
                    </p>
                    <span className="flex items-center gap-1.5 text-[10px] text-emerald-300">
                      <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden="true" />
                      {t('landing.demoCallAgent')}
                    </span>
                  </div>

                  <div className="flex min-h-0 flex-col">
                    {(reducedMotion ? callTranscript : callTranscript.slice(0, callVisibleCount)).map(
                      (message, index) => {
                        const isAi = message.speaker === 'ai';
                        const isCurrent =
                          !reducedMotion &&
                          callVisibleCount < callTranscript.length &&
                          index === callVisibleCount - 1;
                        const wordTotal = t(message.textKey).split(/\s+/).length;
                        const words = isCurrent ? callWordCount : wordTotal;
                        return (
                          <motion.div
                            key={message.textKey}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.25, ease: 'easeOut' }}
                            className={`-mx-4 border-l-2 px-4 py-1.5 transition-colors duration-300 ${
                              isCurrent
                                ? isAi
                                  ? 'border-amber-400 bg-amber-500/10'
                                  : 'border-white/60 bg-white/5'
                                : 'border-transparent'
                            }`}
                          >
                            <div className="flex items-baseline gap-2">
                              <span className="w-9 shrink-0 text-[10px] tabular-nums text-white/40">
                                {message.time}
                              </span>
                              <span
                                className={`flex w-20 shrink-0 items-center gap-1 truncate text-[10px] font-semibold ${
                                  isAi ? 'text-amber-300' : 'text-white/60'
                                }`}
                              >
                                {isAi ? t('landing.demoCallAgent') : t('landing.demoCallCustomer')}
                                {callConnected && isCurrent && (
                                  <VoiceWave tone={isAi ? 'amber' : 'white'} />
                                )}
                              </span>
                              <p
                                className={`min-w-0 flex-1 text-xs leading-5 ${
                                  isCurrent ? 'text-white' : 'text-white/75'
                                }`}
                              >
                                <LiveCaption
                                  text={t(message.textKey)}
                                  words={words}
                                  animate={!reducedMotion && isCurrent}
                                  cursorKey={`${message.textKey}-${callVisibleCount}`}
                                />
                              </p>
                            </div>
                          </motion.div>
                        );
                      },
                    )}


                    {(reducedMotion || callVisibleCount >= callTranscript.length) && (
                      <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3 }}
                        className="-mx-4 flex items-center gap-1.5 px-4 pt-1.5 text-[10px] font-medium text-emerald-300"
                      >
                        <IconCheck className="size-3.5" />
                        {t('landing.demoCallStatus')}
                      </motion.div>
                    )}
                  </div>
                </div>

                {/* Kontrol panggilan */}
                <div className="flex items-center justify-center gap-5 px-6 pb-7 pt-2 sm:gap-6">
                  <span className="flex size-12 items-center justify-center rounded-full bg-white/10 text-white">
                    <IconRefreshCw className="size-5" />
                  </span>
                  <span className="flex size-12 items-center justify-center rounded-full bg-white text-[#0a1317]">
                    <IconVideo className="size-5" />
                  </span>
                  <span className="flex size-12 items-center justify-center rounded-full bg-white/10 text-white">
                    <IconMicOff className="size-5" />
                  </span>
                  <span className="flex size-12 items-center justify-center rounded-full bg-red-500 text-white">
                    <IconPhone className="size-5 rotate-[135deg]" />
                  </span>
                </div>

                {/* Home indicator */}
                <div className="flex justify-center pb-2">
                  <span className="h-1 w-32 rounded-full bg-white/70" aria-hidden="true" />
                </div>
              </div>
            </div>

            {/* Form — satu kartu: chat (ala CONVERSATIONAL BOOKING) → form
                Tally terisi → kembali ke chat untuk konfirmasi AI. */}
            <div className="flex flex-col">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[#1017e8]">
                {t('landing.demoFormCaption')}
              </p>
              {/* Tinggi FIXED (h-[36.5rem]) — sama seperti kartu chat, agar
                  frame form tidak berubah saat animasi chat → form → chat
                  berjalan; konten berlebih terpotong, header tetap tampil. */}
              <div className="flex h-[36.5rem] flex-col overflow-hidden rounded-2xl border border-[#e6ebef] bg-white shadow-sm">
                {formStage === 'form' && !reducedMotion ? (
                  /* ── Tampilan form Tally ── */
                  <Fragment>
                    <div className="border-b border-[#e6ebef] px-4 py-3">
                      <p className="text-sm font-semibold text-[#0a1317]">{t('landing.demoFormTitle')}</p>
                      <p className="text-xs text-[#4e606f]">{t('landing.demoFormPoweredBy')}</p>
                    </div>

                    {/* Progress bar gaya Tally */}
                    <div className="h-1 w-full bg-[#e6ebef]" aria-hidden="true">
                      <div
                        className="h-full bg-amber-500 transition-all duration-700 ease-out"
                        style={{
                          width: `${
                            formPhase >= formSteps.length
                              ? 100
                              : ((formPhase + (formFilled ? 1 : 0)) / (formSteps.length + 1)) * 100
                          }%`,
                        }}
                      />
                    </div>

                    <div className="flex flex-1 flex-col px-5 py-6">
                      {formPhase >= formSteps.length ? (
                        /* Semua terisi → tombol confirm menyala */
                        <div className="flex flex-1 flex-col items-center justify-center">
                          <motion.div
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3, ease: 'easeOut' }}
                            className="flex w-full max-w-[220px] items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm"
                          >
                            {t('landing.demoFormSubmit')}
                          </motion.div>
                        </div>
                      ) : (
                        /* Satu pertanyaan per layar — terisi dari awal hingga akhir */
                        (() => {
                          const step = formSteps[formPhase];
                          return (
                            <motion.div
                              key={formPhase}
                              initial={{ opacity: 0, y: 12 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.3, ease: 'easeOut' }}
                              className="flex flex-1 flex-col justify-center"
                            >
                              <p className="text-sm font-semibold text-[#0a1317]">{t(step.labelKey)}</p>
                              <div className="mt-3">
                                {step.kind === 'text' ? (
                                  <div className="flex items-center rounded-lg border border-[#e6ebef] bg-[#f8fafb] px-3 py-2.5 text-sm text-[#0a1317]">
                                    <Typewriter
                                      text={t(step.valueKey)}
                                      filled={formFilled}
                                      animate={!reducedMotion && formFilled}
                                    />
                                  </div>
                                ) : (
                                  <div className="flex flex-wrap gap-2">
                                    <span
                                      className={`rounded-lg border px-3 py-2 text-sm transition-colors duration-300 ${
                                        formFilled
                                          ? 'border-amber-500 bg-amber-500 font-semibold text-zinc-950 shadow-sm'
                                          : 'border-[#e6ebef] bg-white text-[#4e606f]'
                                      }`}
                                    >
                                      {t(step.valueKey)}
                                    </span>
                                    {step.option2Key && (
                                      <span className="rounded-lg border border-[#e6ebef] bg-white px-3 py-2 text-sm text-[#4e606f]">
                                        {t(step.option2Key)}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          );
                        })()
                      )}
                    </div>
                  </Fragment>
                ) : (
                  /* ── Tampilan chat — layout ala CONVERSATIONAL BOOKING ── */
                  <Fragment>
                    <div className="flex items-center gap-3 border-b border-[#e6ebef] px-4 py-3">
                      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#0a1317]">
                        <AppLogo />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#0a1317]">{t('landing.demoAssistant')}</p>
                        <p className="flex items-center gap-1.5 text-xs text-[#4e606f]">
                          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                          {t('landing.demoOnline')}
                        </p>
                      </div>
                    </div>

                    {/* Pesan — muncul berurutan; reduced motion → semua tampil.
                        Overflow dihilangkan: pesan terbaru menempel di bawah,
                        yang lama terpotong di atas; header tetap tampil. */}
                    <div className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-4 py-5">
                      {(reducedMotion ? formChatMessages : formChatMessages.slice(0, chatCount)).map((message) => {
                        const isCustomer = message.sender === 'customer';
                        return (
                          <motion.div
                            key={message.textKey}
                            initial={{ opacity: 0, y: 10, scale: 0.97 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={{ duration: 0.35, ease: 'easeOut' }}
                            className={isCustomer ? 'flex justify-start' : 'flex justify-end'}
                          >
                            <div className="max-w-[85%]">
                              <p
                                className={`mb-1 text-[11px] font-semibold ${isCustomer ? 'text-[#4e606f]' : 'text-amber-700'}`}
                              >
                                {isCustomer ? t('landing.demoCustomerLabel') : t('landing.demoAiLabel')}
                              </p>
                              <div
                                className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
                                  isCustomer
                                    ? 'rounded-tl-sm border border-[#e6ebef] bg-white text-[#0a1317]'
                                    : 'rounded-tr-sm bg-amber-500 text-zinc-950'
                                }`}
                              >
                                <p className="whitespace-pre-line">{t(message.textKey)}</p>
                                {message.link && (
                                  <a
                                    href={demoFormUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#1017e8] shadow-sm transition hover:bg-[#f8fafb]"
                                  >
                                    <IconExternalLink className="size-3.5" />
                                    {t('landing.demoFormLink')}
                                  </a>
                                )}
                                <p
                                  className={`mt-1 text-right text-[10px] ${isCustomer ? 'text-[#8a9aa8]' : 'text-zinc-900/60'}`}
                                >
                                  {message.time}
                                </p>
                              </div>
                            </div>
                          </motion.div>
                        );
                      })}

                      {!reducedMotion && chatTyping && (
                        <motion.div
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2 }}
                          className="flex justify-end"
                        >
                          <div className="flex items-center gap-1.5 rounded-2xl rounded-tr-sm bg-amber-500 px-4 py-3.5">
                            {[0, 1, 2].map((dot) => (
                              <motion.span
                                key={dot}
                                className="size-1.5 rounded-full bg-zinc-950/70"
                                animate={{ y: [0, -3, 0], opacity: [0.35, 1, 0.35] }}
                                transition={{ duration: 0.8, repeat: Infinity, delay: dot * 0.18, ease: 'easeInOut' }}
                              />
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </div>
                  </Fragment>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Untuk siapa — built for service businesses */}
      <section className="border-y border-[#e6ebef] bg-white px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          <SectionTopic icon={IconUsers} word={t('landing.topicWho')} />
          <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] tracking-[-0.04em] text-[#0a1317] sm:text-4xl">
            {t('landing.whoTitle')}
          </h2>

          <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {whoForCards.map((card) => (
              <div key={card.titleKey} className="rounded-2xl border border-[#e6ebef] bg-[#f8fafb] p-6">
                <span className="text-2xl" aria-hidden="true">{card.emoji}</span>
                <h3 className="mt-3 text-base font-semibold tracking-[-0.02em] text-[#0a1317]">
                  {t(card.titleKey)}
                </h3>
                <p className="mt-1.5 text-sm leading-6 text-[#4e606f]">
                  {t(card.descKey)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ — jawaban cepat dalam gaya percakapan Inbox */}
      <section id="faq" className="scroll-mt-6 border-y border-[#e6ebef] bg-[#f8fafb] px-5 py-20 sm:px-8">
        <div className="mx-auto grid w-full max-w-5xl gap-y-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-x-16 lg:gap-y-0">
          <div>
            <SectionTopic icon={IconHelp} word={t('landing.topicFaq')} />
            <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] tracking-[-0.04em] text-[#0a1317] sm:text-4xl">
              {t('landing.faqTitle')}
            </h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#4e606f] sm:text-lg sm:leading-8">
              {t('landing.faqDesc')}
            </p>
          </div>

          <div className="max-w-3xl space-y-4 lg:mt-0">
            {landingFaqs.map((faq, index) => {
              const isOpen = openFaq === index;
              return (
                <div key={faq.questionKey} className="space-y-2">
                  <div className="flex justify-start">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setOpenFaq((current) => (current === index ? null : index))}
                      className="flex max-w-[94%] items-center gap-4 rounded-2xl rounded-tl-sm border border-[#e6ebef] bg-white px-3.5 py-3 text-left text-sm leading-relaxed text-zinc-800 shadow-sm transition hover:border-[#cfd7de] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1017e8] sm:text-base"
                    >
                      <span className="flex-1 font-semibold">{t(faq.questionKey)}</span>
                      <IconChevronDown
                        className={`size-4 shrink-0 text-zinc-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  {isOpen && (
                    <div className="flex justify-end">
                      <div className="max-w-[94%] rounded-2xl rounded-tr-sm bg-amber-500 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-950 shadow-sm sm:text-base">
                        <p>{t(faq.answerKey)}</p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <footer className="border-t border-[#e6ebef] bg-white px-5 py-16 sm:px-8 lg:py-20">
        <div className="mx-auto w-full max-w-5xl">
          <div className="grid grid-cols-1 gap-x-12 gap-y-12 sm:grid-cols-2 lg:grid-cols-[1.35fr_1fr_1fr]">
            <div className="space-y-4 lg:pr-12">
              <Link to="/" className="inline-flex items-center gap-2.5" aria-label={t('landing.ariaHome')}>
                <span className="flex size-8 items-center justify-center overflow-hidden rounded-md bg-[#0a1317] shadow-sm">
                  <AppLogo />
                </span>
                <span className="text-[15px] font-semibold tracking-[-0.03em] text-[#0a1317]">oriole</span>
              </Link>
              <p className="max-w-sm text-[15px] leading-6 text-[#858585]">{t('landing.footerDescription')}</p>
              <p className="text-sm font-medium text-[#1017e8]">{t('landing.footerTagline')}</p>
            </div>

            <FooterColumn column={footerColumns[0]} />
            <FooterColumn column={footerColumns[1]} />
          </div>

          <div className="mt-14 flex flex-col gap-4 border-t border-[#e6ebef] pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-6 text-[#858585]">
              {t('landing.footerCopyright', { year: new Date().getFullYear() })}
            </p>
            <div
              className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700"
              role="status"
            >
              <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" aria-hidden="true" />
              <span>{t('landing.footerStatus')}</span>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
