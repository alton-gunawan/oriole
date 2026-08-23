import { type ComponentType, Fragment, useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { AppLogo } from '../components/AppLogo';
import {
  IconBattery,
  IconCalendarCheck,
  IconCheck,
  IconClock,
  IconCreditCard,
  IconChevronDown,
  IconChevronLeft,
  IconExternalLink,
  IconHelp,
  IconMail,
  IconMenu,
  IconMicOff,
  IconPhone,
  IconPhonePhosphor,
  IconPlug,
  IconRefreshCw,
  IconRepeat,
  IconShield,
  IconSignal,
  IconSquaresFour,
  IconUsers,
  IconVideo,
  IconWebhook,
  IconWifi,
  IconX,
  type IconProps,
} from '../shell/icons';
import type { TranslationKey } from '../../i18n';
import { apiFetch } from '../../lib/api';
import { getAccessToken } from '../../lib/token';
import { applyTheme } from '../../lib/theme';
import { type ChannelListResponse } from '../../lib/messaging';
import { type IntegrationListResponse } from '../../lib/integrations';
import { loadObsidianConfig } from '../../lib/obsidian';
import { getCachedSessionStatus, useSessionStore } from '../../stores/session';

type FooterLink = {
  labelKey: TranslationKey;
  href: string;
};

const footerColumns: { titleKey: TranslationKey; links: FooterLink[] }[] = [
  {
    titleKey: 'landing.footerProduct',
    links: [
      { labelKey: 'landing.footerHowItWorks', href: '#how-it-works' },
      { labelKey: 'landing.footerSolutions', href: '#solutions' },
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

/**
 * Industri dari Edit Business dialog (EDITABLE_INDUSTRIES):
 * Barbershop, Nail salon, Massage/spa, Pet grooming, Car detailing,
 * Yoga/Pilates, Personal trainer, Photography Studio.
 */
const industrySolutions = [
  { key: 'barbershop', emoji: '💈', labelKey: 'industry.barbershop', descKey: 'landing.solBarbershopDesc' },
  { key: 'nail-salon', emoji: '💅', labelKey: 'industry.nailSalon', descKey: 'landing.solNailSalonDesc' },
  { key: 'massage-spa', emoji: '💆', labelKey: 'industry.massageSpa', descKey: 'landing.solMassageSpaDesc' },
  { key: 'pet-grooming', emoji: '🐕', labelKey: 'industry.petGrooming', descKey: 'landing.solPetGroomingDesc' },
  { key: 'car-detailing', emoji: '🚗', labelKey: 'industry.carDetailing', descKey: 'landing.solCarDetailingDesc' },
  { key: 'yoga-pilates', emoji: '🧘', labelKey: 'industry.yogaPilates', descKey: 'landing.solYogaPilatesDesc' },
  { key: 'personal-trainer', emoji: '🏋️', labelKey: 'industry.personalTrainer', descKey: 'landing.solPersonalTrainerDesc' },
  { key: 'photography-studio', emoji: '📸', labelKey: 'industry.photographyStudio', descKey: 'landing.solPhotographyStudioDesc' },
] as const;

function FooterColumn({ column }: { column: (typeof footerColumns)[number] }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t(column.titleKey)}>
      <h2 className="text-[15px] font-medium text-white">{t(column.titleKey)}</h2>
      <ul className="mt-5 space-y-4">
        {column.links.map((link) => (
          <li key={link.labelKey}>
            <a
              href={link.href}
              className="text-[15px] leading-6 text-zinc-400 transition-colors hover:text-white"
            >
              {t(link.labelKey)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Integrasi yang benar-benar tersedia di Oriole. Brand mark memakai aset lokal
 * yang sama dengan halaman Integrations; fitur tanpa logo brand memakai Lucide.
 * Ini menjaga landing page tetap jujur: tidak menampilkan konektor yang belum ada.
 */
const integrationTiles = [
  { key: 'whatsapp', labelKey: 'landing.integrationWhatsapp', logo: '/brands/whatsapp.svg', icon: null },
  { key: 'telegram', labelKey: 'landing.integrationTelegram', logo: '/brands/telegram.svg', icon: null },
  { key: 'slack', labelKey: 'landing.integrationSlack', logo: '/brands/slack.svg', icon: null },
  { key: 'instagram', labelKey: 'landing.integrationInstagram', logo: '/brands/instagram.svg', icon: null },
  { key: 'facebook', labelKey: 'landing.integrationFacebook', logo: '/brands/facebook.svg', icon: null },
  { key: 'video', labelKey: 'landing.integrationVideo', logo: null, icon: IconVideo },
  { key: 'google-calendar', labelKey: 'landing.integrationGoogleCalendar', logo: '/brands/google-calendar.svg', icon: null },
  { key: 'google-forms', labelKey: 'landing.integrationGoogleForms', logo: '/brands/google-forms.svg', icon: null },
  { key: 'tally', labelKey: 'landing.integrationTally', logo: '/brands/tally.svg', icon: null },
  { key: 'notion', labelKey: 'landing.integrationNotion', logo: '/brands/notion.svg', icon: null },
  { key: 'obsidian', labelKey: 'landing.integrationObsidian', logo: '/brands/obsidian.svg', icon: null },
  { key: 'email', labelKey: 'landing.integrationEmail', logo: null, icon: IconMail },
  { key: 'payments', labelKey: 'landing.integrationPayments', logo: null, icon: IconCreditCard },
  { key: 'webhook', labelKey: 'landing.integrationWebhook', logo: null, icon: IconWebhook },
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
        className={`relative flex size-[4.25rem] items-center justify-center rounded-[1.35rem] border border-white/10 bg-zinc-900 shadow-[0_10px_24px_-16px_rgba(0,0,0,0.8)] transition duration-300 group-hover:-translate-y-1 group-hover:shadow-[0_16px_30px_-16px_rgba(0,0,0,0.9)] sm:size-[5rem] ${connected ? 'ring-2 ring-emerald-400/80' : ''}`}
      >
        {tile.logo ? (
          <img src={tile.logo} alt="" className="size-10 object-contain sm:size-12" />
        ) : TileIcon ? (
          <TileIcon className="size-9 text-zinc-100 sm:size-10" strokeWidth={1.7} aria-hidden="true" />
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
      <span className="max-w-[5.5rem] truncate text-center text-[10px] font-medium text-zinc-400 sm:text-[11px]">
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

const trustCards = [
  {
    icon: IconClock,
    titleKey: 'landing.trustStat1Title',
    descKey: 'landing.trustStat1Desc',
  },
  {
    icon: IconPhone,
    titleKey: 'landing.trustStat2Title',
    descKey: 'landing.trustStat2Desc',
  },
  {
    icon: IconCalendarCheck,
    titleKey: 'landing.trustStat3Title',
    descKey: 'landing.trustStat3Desc',
  },
  {
    icon: IconShield,
    titleKey: 'landing.trustStat4Title',
    descKey: 'landing.trustStat4Desc',
  },
] as const;

const landingFaqs = [
  { questionKey: 'landing.faq1Q', answerKey: 'landing.faq1A' },
  { questionKey: 'landing.faq2Q', answerKey: 'landing.faq2A' },
  { questionKey: 'landing.faq3Q', answerKey: 'landing.faq3A' },
  { questionKey: 'landing.faq4Q', answerKey: 'landing.faq4A' },
  { questionKey: 'landing.faq5Q', answerKey: 'landing.faq5A' },
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

/** Tombol "Book a demo" — di sebelah kiri "Go to dashboard", background transparan dengan ikon phone Phosphor. */
function BookDemoButton({ size }: { size: 'sm' | 'lg' }) {
  const { t } = useTranslation();
  return (
    <a
      href={demoFormUrl}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center justify-center gap-1.5 rounded-[10px] border border-white/20 bg-transparent text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
        size === 'lg' ? 'h-11 px-5 text-base font-medium' : 'h-9 px-4 text-sm font-medium'
      }`}
    >
      <IconPhonePhosphor className="size-4" aria-hidden="true" />
      <span>{t('landing.bookDemo')}</span>
    </a>
  );
}

/** Tombol "Open app" untuk user yang sudah login — full blue background, text white dengan ikon squares-four. */
function OpenAppButton({ size }: { size: 'sm' | 'lg' }) {
  const { t } = useTranslation();
  return (
    <a
      href="/app/dashboard"
      className={`inline-flex items-center justify-center gap-1.5 rounded-[10px] bg-[#1017e8] text-white transition hover:bg-[#0c12bd] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1017e8] ${
        size === 'lg' ? 'h-11 px-5 text-base font-medium' : 'h-9 px-4 text-sm font-medium'
      }`}
    >
      <IconSquaresFour className="size-4" aria-hidden="true" />
      <span>{t('landing.goToDashboard')}</span>
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
        isDark ? 'text-white' : 'text-blue-400'
      }`}
    >
      <TopicIcon
        className={`size-4 ${isDark ? 'text-amber-300' : 'text-blue-400'}`}
        strokeWidth={2}
        aria-hidden="true"
      />
      {word}
    </div>
  );
}

/**
 * Prefetch chunk halaman auth (lazy di router) saat user menunjukkan intent
 * — hover/fokus/tekan. Dengan begitu klik "Sign in / Get started" tidak
 * menunggu download SDK Neon Auth (chunk terpisah) dulu sebelum render.
 */
let authChunkPrefetched = false;
function prefetchAuthPages(): void {
  if (authChunkPrefetched) return;
  authChunkPrefetched = true;
  void Promise.all([import('../auth/SignInPage'), import('../auth/SignUpPage')]);
}

export function LandingPage() {
  const { t } = useTranslation();
  const sessionStatus = useSessionStore((s) => s.status);
  const isAuthenticated =
    sessionStatus === 'authenticated' ||
    (sessionStatus === 'loading' && getCachedSessionStatus() === 'authenticated');

  useEffect(() => {
    applyTheme('dark');
  }, []);

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
        if (item.integrationType === 'google-calendar') connected.add('google-calendar');
        if (item.integrationType === 'google-forms') connected.add('google-forms');
        if (item.integrationType === 'tally') connected.add('tally');
        if (item.integrationType === 'notion') connected.add('notion');
        if (item.integrationType === 'webhook') connected.add('webhook');
        if (item.integrationType === 'payments') connected.add('payments');
        if (item.integrationType === 'slack') connected.add('slack');
        if (item.integrationType === 'video') connected.add('video');
      }
      if (loadObsidianConfig()) connected.add('obsidian');
      setConnectedTiles(connected);
    } catch {
      setConnectedTiles(null);
    }
  }, []);

  useEffect(() => {
    if (!getAccessToken()) return;
    void loadIntegrationState();
    const onFocus = () => void loadIntegrationState();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadIntegrationState]);

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
      setTyping(false);
      const timer = setTimeout(() => setVisibleCount(0), 3000);
      return () => clearTimeout(timer);
    }
    const message = demoMessages[visibleCount];
    if (message.sender === 'ai') {
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (reducedMotion) return;
    if (formStage === 'chat') {
      const next = chatCount < formChatMessages.length ? formChatMessages[chatCount] : null;
      if (next && (chatCount < 4 || formVisited)) {
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
        const timer = setTimeout(() => {
          setFormStage('form');
          setFormPhase(0);
          setFormFilled(false);
          setFormVisited(true);
        }, 1800);
        return () => clearTimeout(timer);
      }
      if (chatCount >= formChatMessages.length) {
        const timer = setTimeout(() => {
          setChatCount(0);
          setChatTyping(false);
          setFormVisited(false);
        }, 3600);
        return () => clearTimeout(timer);
      }
      return;
    }
    if (formPhase >= formSteps.length) {
      setFormFilled(false);
      const timer = setTimeout(() => {
        setFormStage('chat');
        setChatCount(4);
        setFormPhase(0);
      }, 1600);
      return () => clearTimeout(timer);
    }
    if (!formFilled) {
      const timer = setTimeout(() => setFormFilled(true), 600);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      setFormFilled(false);
      setFormPhase((phase) => phase + 1);
    }, 1400);
    return () => clearTimeout(timer);
  }, [formStage, chatCount, chatTyping, formVisited, formPhase, formFilled, reducedMotion]);

  useEffect(() => {
    if (reducedMotion) return;
    if (!callConnected) {
      const timer = setTimeout(() => {
        setCallConnected(true);
        setCallVisibleCount(1);
        setCallWordCount(0);
      }, 2000);
      return () => clearTimeout(timer);
    }
    if (callVisibleCount === 0) return;
    if (callVisibleCount > callTranscript.length) {
      const timer = setTimeout(() => {
        setCallConnected(false);
        setCallVisibleCount(0);
        setCallWordCount(0);
        setCallSeconds(0);
      }, 4000);
      return () => clearTimeout(timer);
    }
    const current = callTranscript[callVisibleCount - 1];
    const totalWords = t(current.textKey).split(/\s+/).length;
    if (callWordCount < totalWords) {
      const timer = setTimeout(() => setCallWordCount((c) => c + 1), 180);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      setCallVisibleCount((c) => c + 1);
      setCallWordCount(0);
    }, 500);
    return () => clearTimeout(timer);
  }, [callVisibleCount, callWordCount, callConnected, reducedMotion, t]);

  useEffect(() => {
    if (reducedMotion || !callConnected) return;
    const timer = setTimeout(() => setCallSeconds((s) => s + 1), 1000);
    return () => clearTimeout(timer);
  }, [callConnected, callSeconds, reducedMotion]);

  const [solutionsMenuOpen, setSolutionsMenuOpen] = useState(false);
  const [mobileSolutionsOpen, setMobileSolutionsOpen] = useState(false);

  useEffect(() => {
    const handleGlobalClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.solutions-dropdown-container')) {
        setSolutionsMenuOpen(false);
      }
    };
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  const activeSpeaker =
    reducedMotion || callVisibleCount > callTranscript.length || callVisibleCount === 0
      ? 'ai'
      : callTranscript[callVisibleCount - 1].speaker;
  const callDurationText = `${String(Math.floor(callSeconds / 60)).padStart(2, '0')}:${String(
    callSeconds % 60,
  ).padStart(2, '0')}`;
  return (
    <main className="landing-page flex min-h-screen flex-col bg-[#090d10] text-zinc-100">
      <header className="sticky top-0 z-40">
        <div
          aria-hidden="true"
          className="landing-header-blur pointer-events-none absolute inset-x-0 top-0 h-48 -z-10"
        />
        <div className="flex h-[72px] w-full items-center justify-between px-6 sm:px-8 lg:px-10">
          <div className="flex items-center gap-12 lg:gap-16">
            <Link to="/" className="flex items-center gap-3" aria-label={t('landing.ariaHome')}>
              <span className="flex size-8 items-center justify-center overflow-hidden rounded-md bg-white text-zinc-950 shadow-sm">
                <AppLogo />
              </span>
              <span className="text-[17px] font-semibold text-white sm:text-lg">oriole</span>
            </Link>

            <nav aria-label={t('landing.navLabel')} className="hidden items-center gap-10 lg:gap-12 md:flex">
            <a
              href="#how-it-works"
              className="text-lg font-medium text-white transition-opacity hover:opacity-80"
            >
              {t('landing.footerHowItWorks')}
            </a>

            {/* Solutions Dropdown Menu */}
            <div
              className="solutions-dropdown-container relative"
              onMouseEnter={() => setSolutionsMenuOpen(true)}
              onMouseLeave={() => setSolutionsMenuOpen(false)}
            >
              <button
                type="button"
                aria-expanded={solutionsMenuOpen}
                onClick={() => setSolutionsMenuOpen((open) => !open)}
                className="inline-flex items-center gap-1.5 text-lg font-medium text-white transition-opacity hover:opacity-80 focus-visible:outline-none"
              >
                <span>{t('landing.footerSolutions')}</span>
                <IconChevronDown
                  className={`size-4 text-zinc-400 transition-transform duration-200 ${
                    solutionsMenuOpen ? 'rotate-180 text-white' : ''
                  }`}
                  aria-hidden="true"
                />
              </button>

              {solutionsMenuOpen && (
                <div className="absolute left-1/2 top-full -translate-x-1/2 pt-3 z-50">
                  <div className="w-72 overflow-hidden rounded-2xl border border-white/10 bg-[#0c1218]/95 p-2 shadow-2xl backdrop-blur-xl">
                    <div className="grid grid-cols-1 gap-1">
                      {industrySolutions.map((item) => (
                        <a
                          key={item.key}
                          href={`#solution-${item.key}`}
                          onClick={() => setSolutionsMenuOpen(false)}
                          className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-zinc-200 transition hover:bg-white/10 hover:text-white"
                        >
                          <span className="text-base" aria-hidden="true">{item.emoji}</span>
                          <span className="font-medium">
                            {t('landing.forIndustry', { industry: t(item.labelKey) })}
                          </span>
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <a
              href="#integrations"
              className="text-lg font-medium text-white transition-opacity hover:opacity-80"
            >
              {t('landing.footerIntegrations')}
            </a>

            <a
              href="#faq"
              className="text-lg font-medium text-white transition-opacity hover:opacity-80"
            >
              {t('landing.footerFaq')}
            </a>
          </nav>
          </div>

          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <>
                <BookDemoButton size="sm" />
                <OpenAppButton size="sm" />
              </>
            ) : (
              <>
                <Link
                  to="/auth/sign-in"
                  onMouseEnter={prefetchAuthPages}
                  onFocus={prefetchAuthPages}
                  onPointerDown={prefetchAuthPages}
                  className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-lg font-medium text-white transition hover:bg-white/10"
                >
                  {t('landing.signIn')}
                </Link>
                <Link
                  to="/auth/sign-up"
                  onMouseEnter={prefetchAuthPages}
                  onFocus={prefetchAuthPages}
                  onPointerDown={prefetchAuthPages}
                  className="inline-flex h-10 items-center justify-center rounded-lg bg-white px-5 text-lg font-medium text-black transition hover:bg-zinc-200"
                >
                  {t('landing.getStarted')}
                </Link>
              </>
            )}
            <button
              type="button"
              aria-expanded={mobileMenuOpen}
              aria-label={mobileMenuOpen ? t('nav.closeMenu') : t('nav.openMenu')}
              onClick={() => setMobileMenuOpen((open) => !open)}
              className="flex size-9 items-center justify-center rounded-md text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white md:hidden"
            >
              {mobileMenuOpen ? (
                <IconX className="size-5" aria-hidden="true" />
              ) : (
                <IconMenu className="size-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <nav aria-label={t('landing.navLabel')} className="border-t border-white/10 bg-[#090d10] px-6 sm:px-8 pb-5 pt-2 md:hidden">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-1">
              <a
                href="#how-it-works"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-lg px-3 py-2.5 text-lg font-medium text-white transition-opacity hover:opacity-80 hover:bg-white/5"
              >
                {t('landing.footerHowItWorks')}
              </a>

              {/* Mobile Solutions Accordion */}
              <div>
                <button
                  type="button"
                  onClick={() => setMobileSolutionsOpen((o) => !o)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-lg font-medium text-white transition-opacity hover:opacity-80 hover:bg-white/5"
                >
                  <span>{t('landing.footerSolutions')}</span>
                  <IconChevronDown
                    className={`size-4 text-zinc-400 transition-transform duration-200 ${
                      mobileSolutionsOpen ? 'rotate-180 text-white' : ''
                    }`}
                    aria-hidden="true"
                  />
                </button>
                {mobileSolutionsOpen && (
                  <div className="ml-3 mt-1 flex flex-col gap-1 border-l border-white/10 pl-3">
                    {industrySolutions.map((item) => (
                      <a
                        key={item.key}
                        href={`#solution-${item.key}`}
                        onClick={() => {
                          setMobileSolutionsOpen(false);
                          setMobileMenuOpen(false);
                        }}
                        className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-base text-zinc-300 transition hover:text-white"
                      >
                        <span className="text-sm" aria-hidden="true">{item.emoji}</span>
                        <span>{t('landing.forIndustry', { industry: t(item.labelKey) })}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>

              <a
                href="#integrations"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-lg px-3 py-2.5 text-lg font-medium text-white transition-opacity hover:opacity-80 hover:bg-white/5"
              >
                {t('landing.footerIntegrations')}
              </a>

              <a
                href="#faq"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-lg px-3 py-2.5 text-lg font-medium text-white transition-opacity hover:opacity-80 hover:bg-white/5"
              >
                {t('landing.footerFaq')}
              </a>
            </div>
          </nav>
        )}
      </header>

      {/* 01 — Hero */}
      <section className="relative flex flex-1 items-center justify-center bg-[#090d10] px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
        <div className="pointer-events-none absolute left-1/2 top-1/3 size-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1017e8]/15 blur-3xl" aria-hidden="true" />
        <div className="relative mx-auto flex w-full max-w-5xl flex-col items-start text-left">
          <SectionTopic icon={IconRepeat} word={t('landing.heroEyebrow')} />
          <h1 className="text-4xl font-bold leading-[1.08] text-white sm:text-6xl lg:text-[64px]">
            {t('landing.heroHeadline')}
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-300 sm:text-xl sm:leading-9">
            {t('landing.heroSubheadline')}
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            {isAuthenticated ? (
              <>
                <BookDemoButton size="lg" />
                <OpenAppButton size="lg" />
              </>
            ) : (
              <>
                <Link
                  to="/auth/sign-up"
                  onMouseEnter={prefetchAuthPages}
                  onFocus={prefetchAuthPages}
                  onPointerDown={prefetchAuthPages}
                  className="inline-flex h-12 items-center justify-center rounded-xl bg-white px-7 text-lg font-semibold text-black shadow-sm transition hover:bg-zinc-200"
                >
                  {t('landing.heroCtaStart')}
                </Link>
                <a
                  href="#demo"
                  className="inline-flex h-12 items-center justify-center rounded-xl border border-white/20 bg-transparent px-7 text-lg font-medium text-white transition hover:bg-white/10"
                >
                  {t('landing.heroCtaDemo')}
                </a>
              </>
            )}
          </div>

          <p className="mt-6 font-mono text-xs text-zinc-400">
            {t('landing.heroTrustBadge')}
          </p>
        </div>
      </section>

      {/* 02 — Instant Product Proof (Demo) */}
      <section id="demo" className="scroll-mt-6 border-y border-white/10 bg-[#06090c] px-5 py-24 sm:px-8 sm:py-28">
        <div className="mx-auto w-full max-w-5xl">
          <SectionTopic icon={IconVideo} word={t('landing.topicDemo')} />
          <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] text-white sm:text-4xl">
            {t('landing.demoTitle')}
          </h2>
          <p className="mt-5 text-base leading-7 text-zinc-400 sm:text-lg sm:leading-8">
            {t('landing.demoDesc')}
          </p>

          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
            {/* Card 1: Chat Demo */}
            <div className="flex flex-col">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-blue-400">
                {t('landing.demoChatCaption')}
              </p>
              <div className="flex h-[36.5rem] flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-sm">
                <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
                  <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white text-zinc-950">
                    <AppLogo />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{t('landing.demoAssistant')}</p>
                    <p className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                      {t('landing.demoOnline')}
                    </p>
                  </div>
                </div>

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
                            className={`mb-1 font-mono text-[11px] font-semibold ${isCustomer ? 'text-zinc-400' : 'text-amber-400'}`}
                          >
                            {isCustomer ? t('landing.demoCustomerLabel') : t('landing.demoAiLabel')}
                          </p>
                          <div
                            className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
                              isCustomer
                                ? 'rounded-tl-sm border border-white/10 bg-zinc-800 text-white'
                                : 'rounded-tr-sm bg-amber-500 text-zinc-950'
                            }`}
                          >
                            <p className="whitespace-pre-line">{t(message.textKey)}</p>
                            <p className={`mt-1 font-mono text-right text-[10px] ${isCustomer ? 'text-zinc-400' : 'text-zinc-900/60'}`}>
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

            {/* Card 2: Voice AI Call */}
            <div className="flex flex-col">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-blue-400">
                {t('landing.demoCallCaption')}
              </p>
              <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-sm">
                <div className="flex items-center justify-between px-5 pt-3 font-mono text-[10px] font-medium tabular-nums text-white/70">
                  <span>9:41</span>
                  <div className="flex items-center gap-1.5">
                    <IconSignal className="size-3" />
                    <IconWifi className="size-3.5" />
                    <IconBattery className="size-4" />
                  </div>
                </div>

                <div className="relative flex items-center justify-center px-4 pt-2">
                  <IconChevronLeft className="absolute left-4 size-5 text-white/90" />
                  <div className="text-center">
                    <p className="text-[15px] font-semibold text-white">
                      {t('landing.demoCallContact')}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-white/60">
                      {reducedMotion || callVisibleCount > callTranscript.length || callVisibleCount === 0
                        ? t('landing.demoCallStatus')
                        : callConnected
                          ? `${t('landing.demoCallConnected')} · ${callDurationText}`
                          : t('landing.demoCallConnecting')}
                    </p>
                  </div>
                </div>

                <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-6">
                  <div className="relative flex size-24 items-center justify-center">
                    {!reducedMotion && !callConnected && (
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
                  <p className="font-mono text-xs font-medium text-white/80">
                    {activeSpeaker === 'ai'
                      ? t('landing.demoCallAgent')
                      : activeSpeaker === 'customer'
                        ? t('landing.demoCallCustomer')
                        : !callConnected
                          ? t('landing.demoCallRinging')
                          : t('landing.demoCallContact')}
                  </p>
                </div>

                <div className="border-t border-white/10 px-4 pb-4 pt-3">
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">
                      {t('landing.demoCallTranscript')}
                    </p>
                    <span className="flex items-center gap-1.5 font-mono text-[10px] text-emerald-300">
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
                              <span className="w-9 shrink-0 font-mono text-[10px] tabular-nums text-white/40">
                                {message.time}
                              </span>
                              <span
                                className={`flex w-20 shrink-0 items-center gap-1 truncate font-mono text-[10px] font-semibold ${
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
                  </div>
                </div>

                <div className="flex items-center justify-center gap-5 px-6 pb-7 pt-2 sm:gap-6">
                  <span className="flex size-12 items-center justify-center rounded-full bg-white/10 text-white">
                    <IconRefreshCw className="size-5" />
                  </span>
                  <span className="flex size-12 items-center justify-center rounded-full bg-white text-zinc-950">
                    <IconVideo className="size-5" />
                  </span>
                  <span className="flex size-12 items-center justify-center rounded-full bg-white/10 text-white">
                    <IconMicOff className="size-5" />
                  </span>
                  <span className="flex size-12 items-center justify-center rounded-full bg-red-500 text-white">
                    <IconPhone className="size-5 rotate-[135deg]" />
                  </span>
                </div>

                <div className="flex justify-center pb-2">
                  <span className="h-1 w-32 rounded-full bg-white/70" aria-hidden="true" />
                </div>
              </div>
            </div>

            {/* Card 3: Form Workflow */}
            <div className="flex flex-col">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-blue-400">
                {t('landing.demoFormCaption')}
              </p>
              <div className="flex h-[36.5rem] flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-sm">
                {formStage === 'form' && !reducedMotion ? (
                  <Fragment>
                    <div className="border-b border-white/10 px-4 py-3">
                      <p className="text-sm font-semibold text-white">{t('landing.demoFormTitle')}</p>
                      <p className="flex items-center gap-1 text-xs text-zinc-400">
                        <Trans
                          i18nKey="landing.demoFormPoweredBy"
                          components={{
                            icon: (
                              <span className="inline-flex size-3.5 items-center justify-center overflow-hidden rounded-sm bg-white text-zinc-950">
                                <AppLogo alt="" />
                              </span>
                            ),
                          }}
                        />
                      </p>
                    </div>

                    <div className="h-1 w-full bg-zinc-800" aria-hidden="true">
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
                        <div className="flex flex-1 flex-col items-center justify-center">
                          <motion.div
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3, ease: 'easeOut' }}
                            className="flex w-full max-w-[220px] items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-sm"
                          >
                            {t('landing.demoFormSubmit')}
                          </motion.div>
                        </div>
                      ) : (
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
                              <p className="text-sm font-semibold text-white">{t(step.labelKey)}</p>
                              <div className="mt-3">
                                {step.kind === 'text' ? (
                                  <div className="flex items-center rounded-lg border border-white/10 bg-zinc-800 px-3 py-2.5 text-sm text-white">
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
                                          : 'border-white/10 bg-zinc-800 text-zinc-300'
                                      }`}
                                    >
                                      {t(step.valueKey)}
                                    </span>
                                    {step.option2Key && (
                                      <span className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-zinc-300">
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
                  <Fragment>
                    <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
                      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white text-zinc-950">
                        <AppLogo />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white">{t('landing.demoAssistant')}</p>
                        <p className="flex items-center gap-1.5 text-xs text-zinc-400">
                          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                          {t('landing.demoOnline')}
                        </p>
                      </div>
                    </div>

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
                                className={`mb-1 font-mono text-[11px] font-semibold ${isCustomer ? 'text-zinc-400' : 'text-amber-400'}`}
                              >
                                {isCustomer ? t('landing.demoCustomerLabel') : t('landing.demoAiLabel')}
                              </p>
                              <div
                                className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
                                  isCustomer
                                    ? 'rounded-tl-sm border border-white/10 bg-zinc-800 text-white'
                                    : 'rounded-tr-sm bg-amber-500 text-zinc-950'
                                }`}
                              >
                                <p className="whitespace-pre-line">{t(message.textKey)}</p>
                                {message.link && (
                                  <a
                                    href={demoFormUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-xs font-semibold text-amber-400 shadow-sm transition hover:bg-zinc-700"
                                  >
                                    <IconExternalLink className="size-3.5" />
                                    {t('landing.demoFormLink')}
                                  </a>
                                )}
                                <p
                                  className={`mt-1 font-mono text-right text-[10px] ${isCustomer ? 'text-zinc-400' : 'text-zinc-900/60'}`}
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

      {/* 03 — The Problem (Text-Only Editorial Statement) */}
      <section className="relative border-y border-white/10 bg-[#090d10] px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto w-full max-w-5xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500 sm:text-sm">
            {t('landing.problemEyebrow')}
          </p>
          <h2 className="mt-8 max-w-5xl text-2xl font-medium leading-[1.3] text-white sm:text-4xl sm:leading-[1.28] md:text-5xl md:leading-[1.24]">
            {t('landing.problemStatement')}
          </h2>
        </div>
      </section>

      {/* 04 — How It Works */}
      <section id="how-it-works" className="scroll-mt-6 border-y border-white/10 bg-[#090d10] px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          <SectionTopic icon={IconRepeat} word={t('landing.topicHow')} />
          <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] text-white sm:text-4xl">
            {t('landing.howTitle')}
          </h2>

          <div className="mt-12 grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-3 lg:gap-x-10">
            {howItWorksSteps.map((step) => {
              return (
                <article key={step.titleKey}>
                  <div className="aspect-[1.08] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900">
                    <img
                      src={step.image}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  </div>
                  <div className="mt-5 text-sm leading-6 sm:text-base sm:leading-7">
                    <h3 className="inline font-semibold text-white">
                      {t(step.titleKey)}
                    </h3>{' '}
                    <p className="inline text-zinc-400">{t(step.descKey)}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* 05 — Integrations & Channels */}
      <section id="integrations" className="relative scroll-mt-6 overflow-hidden border-y border-white/10 bg-[#090d10] px-5 py-24 sm:px-8 sm:py-28">
        <div className="pointer-events-none absolute left-1/2 top-24 size-[28rem] -translate-x-1/2 rounded-full bg-[#1017e8]/15 opacity-60 blur-3xl" aria-hidden="true" />
        <div className="relative mx-auto w-full max-w-5xl text-center">
          <SectionTopic icon={IconPlug} word={t('landing.topicIntegrations')} />
          <h2 className="mx-auto max-w-4xl text-2xl font-semibold leading-[1.1] text-white sm:text-4xl lg:text-5xl">
            {t('landing.integrationTitle')}
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg sm:leading-8">
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

          <p className="mx-auto mt-14 max-w-3xl text-base leading-7 text-zinc-300 sm:text-lg sm:leading-8">
            {t('landing.integrationFootnote')}
          </p>
        </div>
      </section>

      {/* 06 — Solutions for Appointment-Based Businesses */}
      <section id="solutions" className="scroll-mt-6 border-y border-white/10 bg-[#090d10] px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          <SectionTopic icon={IconUsers} word={t('landing.topicSolutions')} />
          <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] text-white sm:text-4xl">
            {t('landing.whoTitle')}
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg sm:leading-8">
            {t('landing.whoDesc')}
          </p>

          <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {industrySolutions.map((item) => (
              <div
                id={`solution-${item.key}`}
                key={item.key}
                className="scroll-mt-24 rounded-2xl border border-white/10 bg-zinc-900/90 p-6 transition hover:border-white/20 hover:bg-zinc-900"
              >
                <span className="text-3xl" aria-hidden="true">{item.emoji}</span>
                <h3 className="mt-3 text-base font-semibold text-white">
                  {t('landing.forIndustry', { industry: t(item.labelKey) })}
                </h3>
                <p className="mt-2 text-sm leading-6 text-zinc-400">
                  {t(item.descKey)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 07 — Built for Real-World Reliability */}
      <section className="border-y border-white/10 bg-[#06090c] px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          <SectionTopic icon={IconShield} word={t('landing.topicTrust')} />
          <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] text-white sm:text-4xl">
            {t('landing.trustTitle')}
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg sm:leading-8">
            {t('landing.trustDesc')}
          </p>

          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {trustCards.map((card) => {
              const TrustIcon = card.icon;
              return (
                <div key={card.titleKey} className="rounded-2xl border border-white/10 bg-zinc-900/80 p-6">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400">
                    <TrustIcon className="size-5" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-white">
                    {t(card.titleKey)}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">
                    {t(card.descKey)}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 08 — FAQ */}
      <section id="faq" className="scroll-mt-6 border-y border-white/10 bg-[#090d10] px-5 py-20 sm:px-8">
        <div className="mx-auto grid w-full max-w-5xl gap-y-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-x-16 lg:gap-y-0">
          <div>
            <SectionTopic icon={IconHelp} word={t('landing.topicFaq')} />
            <h2 className="max-w-3xl text-2xl font-semibold leading-[1.15] text-white sm:text-4xl">
              {t('landing.faqTitle')}
            </h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg sm:leading-8">
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
                      className="flex max-w-[94%] items-center gap-4 rounded-2xl rounded-tl-sm border border-white/10 bg-zinc-900 px-3.5 py-3 text-left text-sm leading-relaxed text-zinc-100 shadow-sm transition hover:border-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 sm:text-base"
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

      {/* 09 — Final Conversion CTA */}
      <section className="relative overflow-hidden border-y border-[#232850] bg-gradient-to-b from-[#0d1130] to-[#090d10] px-5 py-24 text-center text-white sm:px-8 sm:py-28">
        <div className="pointer-events-none absolute left-1/2 top-1/2 size-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1017e8]/20 blur-3xl" aria-hidden="true" />
        <div className="relative mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold text-white sm:text-5xl">
            {t('landing.finalCtaTitle')}
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-[#adb3c7] sm:text-lg sm:leading-8">
            {t('landing.finalCtaDesc')}
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {isAuthenticated ? (
              <OpenAppButton size="lg" />
            ) : (
              <>
                <Link
                  to="/auth/sign-up"
                  onMouseEnter={prefetchAuthPages}
                  onFocus={prefetchAuthPages}
                  onPointerDown={prefetchAuthPages}
                  className="inline-flex h-12 items-center justify-center rounded-xl bg-white px-8 text-lg font-semibold text-black shadow-sm transition hover:bg-zinc-200"
                >
                  {t('landing.finalCtaButton')}
                </Link>
                <a
                  href="#demo"
                  className="inline-flex h-12 items-center justify-center rounded-xl border border-white/20 bg-transparent px-7 text-lg font-medium text-white transition hover:bg-white/10"
                >
                  {t('landing.heroCtaDemo')}
                </a>
              </>
            )}
          </div>

          <p className="mt-6 font-mono text-xs text-zinc-400">
            {t('landing.finalCtaSubtext')}
          </p>
        </div>
      </section>

      {/* 10 — Footer */}
      <footer className="border-t border-white/10 bg-[#090d10] px-5 py-16 sm:px-8 lg:py-20">
        <div className="mx-auto w-full max-w-5xl">
          <div className="grid grid-cols-1 gap-x-12 gap-y-12 sm:grid-cols-2 lg:grid-cols-[1.35fr_1fr_1fr]">
            <div className="space-y-4 lg:pr-12">
              <Link to="/" className="inline-flex items-center gap-2.5" aria-label={t('landing.ariaHome')}>
                <span className="flex size-8 items-center justify-center overflow-hidden rounded-md bg-white text-zinc-950 shadow-sm">
                  <AppLogo />
                </span>
                <span className="text-[15px] font-semibold text-white">oriole</span>
              </Link>
              <p className="max-w-sm text-[15px] leading-6 text-zinc-400">{t('landing.footerDescription')}</p>
              <p className="text-sm font-medium text-blue-400">{t('landing.footerTagline')}</p>
            </div>

            <FooterColumn column={footerColumns[0]} />
            <FooterColumn column={footerColumns[1]} />
          </div>

          <div className="mt-14 flex flex-col gap-4 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-6 text-zinc-500">
              {t('landing.footerCopyright', { year: new Date().getFullYear() })}
            </p>
            <div
              className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-800/60 bg-emerald-950/40 px-3 py-1.5 font-mono text-xs font-medium text-emerald-400"
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
