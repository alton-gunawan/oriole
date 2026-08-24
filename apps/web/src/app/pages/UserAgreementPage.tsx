import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { AppBrand } from '../components/AppLogo';
import { LocaleSwitcher } from '../shell/LocaleSwitcher';
import { IconChevronLeft, IconShield } from '../shell/icons';

export function UserAgreementPage() {
  const { t } = useTranslation();

  const sections = [
    { title: t('legal.uaSection1Title'), text: t('legal.uaSection1Text') },
    { title: t('legal.uaSection2Title'), text: t('legal.uaSection2Text') },
    { title: t('legal.uaSection3Title'), text: t('legal.uaSection3Text') },
    { title: t('legal.uaSection4Title'), text: t('legal.uaSection4Text') },
    { title: t('legal.uaSection5Title'), text: t('legal.uaSection5Text') },
    { title: t('legal.uaSection6Title'), text: t('legal.uaSection6Text') },
    { title: t('legal.uaSection7Title'), text: t('legal.uaSection7Text') },
  ];

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 flex flex-col">
      {/* Navigation Header */}
      <header className="sticky top-0 z-30 border-b border-zinc-200/80 bg-white/80 backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-900/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
          <Link to="/" className="transition hover:opacity-90">
            <AppBrand iconSize="size-9" textSize="text-xl" />
          </Link>
          <div className="flex items-center gap-3">
            <LocaleSwitcher />
            <Link
              to="/auth/sign-in"
              className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {t('legal.backToSignIn')}
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 px-4 py-10 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-8">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 mb-4"
            >
              <IconChevronLeft className="size-3.5" />
              {t('legal.backToHome')}
            </Link>
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-500 mb-2">
              <IconShield className="size-5" />
              <span className="text-xs font-semibold uppercase tracking-wider">Oriole Legal</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl text-zinc-900 dark:text-zinc-100">
              {t('legal.userAgreementTitle')}
            </h1>
            <p className="mt-2 text-base text-zinc-600 dark:text-zinc-400">
              {t('legal.userAgreementSubtitle')}
            </p>
            <p className="mt-3 text-xs font-medium text-zinc-400 dark:text-zinc-500">
              {t('legal.lastUpdated')}
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-xs sm:p-8 dark:border-zinc-800/80 dark:bg-zinc-900">
            <div className="space-y-8 divide-y divide-zinc-100 dark:divide-zinc-800/60">
              {sections.map((section, idx) => (
                <div key={idx} className={idx === 0 ? '' : 'pt-8'}>
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
                    {section.title}
                  </h2>
                  <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300 whitespace-pre-line">
                    {section.text}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Links */}
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-zinc-200 pt-6 dark:border-zinc-800 text-xs text-zinc-500 dark:text-zinc-400">
            <div>
              {t('landing.footerCopyright', { year: new Date().getFullYear() })}
            </div>
            <div className="flex items-center gap-4">
              <Link to="/privacy-policy" className="hover:text-zinc-900 dark:hover:text-zinc-200 underline underline-offset-2">
                {t('legal.privacyPolicyTitle')}
              </Link>
              <Link to="/auth/sign-up" className="hover:text-zinc-900 dark:hover:text-zinc-200 underline underline-offset-2">
                {t('legal.backToSignUp')}
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
