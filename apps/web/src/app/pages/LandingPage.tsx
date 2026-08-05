import { Button, Card } from '@astryxdesign/core';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { TranslationKey } from '../../i18n';
import { LocaleSwitcher } from '../shell/LocaleSwitcher';
import {
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconChart,
  IconPhone,
  IconShield,
} from '../shell/icons';

const features: {
  icon: typeof IconCalendar;
  eyebrowKey: TranslationKey;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
}[] = [
  {
    icon: IconCalendar,
    eyebrowKey: 'landing.feature1Eyebrow',
    titleKey: 'landing.feature1Title',
    descriptionKey: 'landing.feature1Desc',
  },
  {
    icon: IconPhone,
    eyebrowKey: 'landing.feature2Eyebrow',
    titleKey: 'landing.feature2Title',
    descriptionKey: 'landing.feature2Desc',
  },
  {
    icon: IconChart,
    eyebrowKey: 'landing.feature3Eyebrow',
    titleKey: 'landing.feature3Title',
    descriptionKey: 'landing.feature3Desc',
  },
];

const benefits = [
  'landing.benefit1',
  'landing.benefit2',
  'landing.benefit3',
] as const;

const steps = [
  ['01', 'landing.step1Title', 'landing.step1Desc'],
  ['02', 'landing.step2Title', 'landing.step2Desc'],
  ['03', 'landing.step3Title', 'landing.step3Desc'],
] as const;

const securityItems = ['landing.securityItem1', 'landing.securityItem2', 'landing.securityItem3'] as const;

function Wordmark() {
  const { t } = useTranslation();
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label={t('landing.ariaHome')}>
      <span className="flex size-8 items-center justify-center rounded-[10px] bg-[#0a1317] text-sm font-semibold text-white shadow-sm">
        O
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.03em] text-[#0a1317]">oriole</span>
    </Link>
  );
}

function ArrowUpRight() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4">
      <path d="M4 12 12 4M5 4h7v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DashboardPreview() {
  const { t } = useTranslation();
  return (
    <div className="landing-preview relative mx-auto w-full max-w-[670px]">
      <div className="landing-preview-glow" aria-hidden="true" />
      <Card padding={0} elevation="med" className="landing-dashboard relative overflow-hidden rounded-[18px] border border-[#d9e1e5] bg-white">
        <div className="flex items-center justify-between border-b border-[#edf0f2] px-5 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="size-2 rounded-full bg-[#0d8626]" />
            <span className="text-xs font-semibold tracking-[0.02em] text-[#0a1317]">{t('landing.previewOverview')}</span>
          </div>
          <span className="rounded-md bg-[#f1f4f7] px-2.5 py-1 text-[10px] font-medium text-[#4e606f]">{t('landing.previewThisMonth')}</span>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-[1fr_1.35fr] sm:p-6">
          <div className="flex flex-col justify-between rounded-xl bg-[#f5f7f8] p-4 sm:min-h-[236px]">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#71808a]">{t('landing.previewBookedRevenue')}</p>
              <p className="mt-3 text-3xl font-semibold tracking-[-0.06em] text-[#0a1317]">$24,860</p>
              <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-[#0d8626]"><span>↗</span> 18.4% <span className="font-normal text-[#71808a]">{t('landing.previewVsLastMonth')}</span></p>
            </div>
            <div className="mt-8 flex h-32 items-end gap-1.5" aria-label={t('landing.previewRevenueTrend')}>
              {[30, 43, 39, 58, 52, 72, 66, 86, 78, 100].map((height, index) => (
                <span key={index} className="landing-bar flex-1 rounded-t-sm bg-[#b9c9d1]" style={{ height: `${height}%` }} />
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-[#edf0f2] p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#71808a]">{t('landing.previewUpcoming')}</p>
                <p className="mt-1 text-sm font-semibold text-[#0a1317]">{t('landing.previewToday')}</p>
              </div>
              <span className="flex size-8 items-center justify-center rounded-lg bg-[#e9f3ff] text-[#0064e0]"><IconCalendar className="size-4" /></span>
            </div>
            <div className="mt-5 flex flex-col gap-3">
              {[
                ['09:30', t('landing.previewBooking1'), 'Maya Lin'],
                ['11:00', t('landing.previewBooking2'), 'Alex Morgan'],
                ['14:30', t('landing.previewBooking3'), 'Sam Rivera'],
              ].map(([time, title, name], index) => (
                <div key={time} className="flex items-center gap-3 rounded-lg border border-[#edf0f2] px-3 py-2.5">
                  <span className="w-10 text-[10px] font-semibold text-[#71808a]">{time}</span>
                  <span className="h-7 w-px bg-[#e4e9ec]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold text-[#0a1317]">{title}</p>
                    <p className="mt-0.5 text-[10px] text-[#71808a]">{name}</p>
                  </div>
                  <span className={`size-1.5 rounded-full ${index === 1 ? 'bg-[#e9af08]' : 'bg-[#0d8626]'}`} />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-[#edf0f2] px-5 py-3.5 sm:px-6">
          <span className="text-[10px] text-[#71808a]">{t('landing.previewUpdated')}</span>
          <Link to="/app/dashboard" className="flex items-center gap-1.5 text-[10px] font-semibold text-[#0064e0] transition hover:text-[#004da8]">{t('landing.previewViewDashboard')} <ArrowUpRight /></Link>
        </div>
      </Card>
    </div>
  );
}

export function LandingPage() {
  const { t } = useTranslation();
  return (
    <main className="landing-page min-h-screen overflow-hidden bg-[#f8fafb] text-[#0a1317]">
      <header className="landing-header relative z-10">
        <div className="landing-container flex h-[72px] items-center justify-between">
          <Wordmark />
          <nav className="hidden items-center gap-8 md:flex" aria-label={t('landing.ariaMainNav')}>
            <a href="#product" className="landing-nav-link">{t('landing.navProduct')}</a>
            <a href="#how-it-works" className="landing-nav-link">{t('landing.navHowItWorks')}</a>
            <a href="#security" className="landing-nav-link">{t('landing.navSecurity')}</a>
          </nav>
          <div className="flex items-center gap-2.5">
            <LocaleSwitcher />
            <Button label={t('landing.signIn')} variant="ghost" size="sm" href="/auth/sign-in" />
            <Button label={t('landing.getStarted')} variant="primary" size="sm" href="/auth/sign-up" endContent={<ArrowUpRight />} />
          </div>
        </div>
      </header>

      <section className="landing-container relative flex flex-col items-center pb-20 pt-20 text-center sm:pb-28 sm:pt-28 lg:pt-32">
        <div className="landing-ambient landing-ambient-one" aria-hidden="true" />
        <div className="landing-ambient landing-ambient-two" aria-hidden="true" />
        <div className="landing-kicker"><span className="size-1.5 rounded-full bg-[#0064e0]" /> {t('landing.kicker')}</div>
        <h1 className="landing-hero-title mt-7 max-w-4xl">
          <Trans i18nKey="landing.heroTitle" />
        </h1>
        <p className="mt-7 max-w-[590px] text-base leading-7 text-[#4e606f] sm:text-lg sm:leading-8">{t('landing.heroSubtitle')}</p>
        <div className="mt-9 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
          <Button label={t('landing.startFree')} variant="primary" size="lg" href="/auth/sign-up" endContent={<IconArrowRight />} />
          <Button label={t('landing.seeHow')} variant="secondary" size="lg" href="#how-it-works" />
        </div>
        <p className="mt-4 text-[11px] text-[#71808a]">{t('landing.noCard')}</p>

        <div className="mt-16 w-full sm:mt-20"><DashboardPreview /></div>
      </section>

      <section id="product" className="landing-container border-t border-[#e4e9ec] py-20 sm:py-28">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <div>
            <p className="landing-section-label">{t('landing.sectionLabelRhythm')}</p>
            <h2 className="landing-section-title mt-4">{t('landing.sectionTitleRhythm')}</h2>
            <p className="mt-5 text-sm leading-7 text-[#4e606f]">{t('landing.sectionDescRhythm')}</p>
            <ul className="mt-7 flex flex-col gap-3.5">
              {benefits.map((benefitKey) => <li key={benefitKey} className="flex items-start gap-2.5 text-sm text-[#0a1317]"><span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-[#dff3e4] text-[#0d8626]"><IconCheck className="size-2.5" /></span>{t(benefitKey)}</li>)}
            </ul>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {features.map(({ icon: Icon, eyebrowKey, titleKey, descriptionKey }) => (
              <Card key={eyebrowKey} padding={0} className="landing-feature-card flex flex-col rounded-2xl border border-[#e4e9ec] bg-white p-5 transition duration-200 hover:-translate-y-1 hover:shadow-[0_18px_40px_rgba(10,19,23,0.08)] sm:p-6">
                <span className="flex size-10 items-center justify-center rounded-xl bg-[#e9f3ff] text-[#0064e0]"><Icon className="size-[18px]" /></span>
                <p className="mt-10 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#71808a]">{t(eyebrowKey)}</p>
                <h3 className="mt-2.5 text-base font-semibold leading-6 tracking-[-0.02em] text-[#0a1317]">{t(titleKey)}</h3>
                <p className="mt-3 text-xs leading-5 text-[#71808a]">{t(descriptionKey)}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="landing-container border-t border-[#e4e9ec] py-20 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <p className="landing-section-label">{t('landing.loopLabel')}</p>
          <h2 className="landing-section-title mt-4">{t('landing.loopTitle')}</h2>
          <p className="mt-5 text-sm leading-7 text-[#4e606f]">{t('landing.loopDesc')}</p>
        </div>
        <div className="mx-auto mt-14 grid max-w-4xl gap-0 md:grid-cols-3">
          {steps.map(([number, titleKey, descriptionKey], index) => (
            <div key={number} className="relative border-l border-[#d9e1e5] px-6 pb-8 pt-1 first:border-l-0 md:px-8 md:pb-2 md:pt-0">
              <span className="text-[11px] font-semibold tracking-[0.12em] text-[#0064e0]">{number}</span>
              <h3 className="mt-4 text-lg font-semibold tracking-[-0.03em]">{t(titleKey)}</h3>
              <p className="mt-3 max-w-[210px] text-sm leading-6 text-[#71808a]">{t(descriptionKey)}</p>
              {index < 2 && <span className="absolute right-[-7px] top-0 hidden size-3.5 rounded-full border-4 border-[#f8fafb] bg-[#b9c9d1] md:block" />}
            </div>
          ))}
        </div>
      </section>

      <section id="security" className="landing-container pb-20 sm:pb-28">
        <Card padding={0} className="landing-security-card overflow-hidden rounded-[24px] border border-[#d9e1e5] bg-[#0a1317] text-white">
          <div className="grid gap-10 px-6 py-10 sm:px-10 sm:py-12 lg:grid-cols-[1fr_auto] lg:items-center lg:px-14">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-[#a9d2ff]"><IconShield className="size-4" /> {t('landing.securityKicker')}</div>
              <h2 className="mt-5 max-w-xl text-2xl font-semibold tracking-[-0.05em] sm:text-3xl">{t('landing.securityTitle')}</h2>
              <p className="mt-4 max-w-xl text-sm leading-7 text-[#aab4ba]">{t('landing.securityDesc')}</p>
            </div>
            <div className="flex shrink-0 flex-col gap-2.5 text-sm text-[#dfe2e5]">
              {securityItems.map((itemKey) => <div key={itemKey} className="flex items-center gap-2.5"><span className="flex size-5 items-center justify-center rounded-full bg-[#1f3946] text-[#a9d2ff]"><IconCheck className="size-3" /></span>{t(itemKey)}</div>)}
            </div>
          </div>
        </Card>
      </section>

      <footer className="landing-footer relative overflow-hidden text-white">
        <div className="landing-footer-orb landing-footer-orb-one" aria-hidden="true" />
        <div className="landing-footer-orb landing-footer-orb-two" aria-hidden="true" />
        <div className="landing-container relative z-10">
          <div className="landing-footer-cta flex flex-col items-center text-center">
            <p className="landing-section-label landing-section-label-light">{t('landing.footerReadyLabel')}</p>
            <h2 className="mt-5 max-w-2xl text-3xl font-semibold leading-[1.05] tracking-[-0.055em] sm:text-5xl">{t('landing.footerCtaTitle')}</h2>
            <p className="mt-5 max-w-md text-sm leading-6 text-white/70 sm:text-base">{t('landing.footerCtaDesc')}</p>
            <Button label={t('landing.startFree')} variant="secondary" size="lg" href="/auth/sign-up" className="landing-footer-cta-button mt-8" endContent={<ArrowUpRight />} />
          </div>

          <div className="landing-footer-details grid gap-12 border-t border-white/20 py-12 md:grid-cols-[1.5fr_1fr_1fr] md:gap-16">
            <div className="max-w-sm">
              <div className="flex items-center gap-2.5">
                <span className="flex size-9 items-center justify-center rounded-xl bg-white text-sm font-semibold text-[#2459ed] shadow-sm">O</span>
                <span className="text-lg font-semibold tracking-[-0.04em]">oriole</span>
              </div>
              <p className="mt-5 text-sm leading-6 text-white/70">{t('landing.footerBrandDesc')}</p>
              <p className="mt-7 text-xs text-white/50">{t('landing.copyright', { year: new Date().getFullYear() })}</p>
            </div>
            <div className="flex flex-col gap-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/50">{t('landing.footerCompany')}</p>
              <a href="#product" className="landing-footer-link-light">{t('landing.navProduct')}</a>
              <a href="#how-it-works" className="landing-footer-link-light">{t('landing.navHowItWorks')}</a>
              <a href="mailto:hello@oriole.app" className="landing-footer-link-light">{t('landing.contact')}</a>
            </div>
            <div className="flex flex-col gap-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/50">{t('landing.footerAccount')}</p>
              <Link to="/auth/sign-in" className="landing-footer-link-light">{t('landing.footerSignIn')}</Link>
              <Link to="/auth/sign-up" className="landing-footer-link-light">{t('landing.getStarted')}</Link>
              <a href="#security" className="landing-footer-link-light">{t('landing.navSecurity')}</a>
            </div>
          </div>

          <div className="landing-footer-wordmark" aria-hidden="true">oriole</div>
        </div>
      </footer>
    </main>
  );
}
