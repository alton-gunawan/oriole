import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  InputGroup,
  NumberInput,
  Selector,
  SelectorOption,
  Spinner,
  TextInput,
  useToast,
} from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';
import worldCountries from 'world-countries';

import { AppBrand, AppLogo } from '../components/AppLogo';
import { apiFetch } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { errorMessage } from '../../lib/errors';
import { browserCountryCode, browserTimezone, TIMEZONE_CURATED, timezoneLabel } from '../../lib/timezones';
import { signOut } from '../../lib/session';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';
import type { Workspace } from '../../lib/workspace';
import type { ServiceRecord } from '../../lib/services';
import type { StaffRecord } from '../../lib/staff';
import {
  IconLogout,
  IconMoon,
  IconPlus,
  IconServices,
  IconSun,
  IconTrash,
} from '../shell/icons';
import { applyTheme, readStoredTheme, storeTheme, type AppTheme } from '../../lib/theme';

type OnboardingStep = 1 | 2 | 3;

interface IndustryOption {
  id: string;
  label: string;
  emoji: string;
  templateCategory: string;
  defaultServices: { name: string; duration: number; price: number }[];
}

const INDUSTRIES_CONFIG: IndustryOption[] = [
  {
    id: 'barbershop',
    label: 'Barbershop',
    emoji: '✂️',
    templateCategory: 'beauty-wellness',
    defaultServices: [
      { name: 'Haircut', duration: 45, price: 40 },
      { name: 'Beard Trim', duration: 30, price: 25 },
      { name: 'Haircut & Beard', duration: 60, price: 60 },
    ],
  },
  {
    id: 'salon',
    label: 'Hair & Beauty Salon',
    emoji: '💇‍♀️',
    templateCategory: 'beauty-wellness',
    defaultServices: [
      { name: 'Women Haircut & Blowdry', duration: 60, price: 75 },
      { name: 'Color & Highlights', duration: 90, price: 150 },
      { name: 'Hair Treatment', duration: 45, price: 65 },
    ],
  },
  {
    id: 'nail-salon',
    label: 'Nail Salon',
    emoji: '💅',
    templateCategory: 'beauty-wellness',
    defaultServices: [
      { name: 'Classic Manicure', duration: 45, price: 35 },
      { name: 'Gel Pedicure', duration: 60, price: 55 },
      { name: 'Nail Art & Extension', duration: 90, price: 85 },
    ],
  },
  {
    id: 'massage-spa',
    label: 'Massage & Spa',
    emoji: '💆',
    templateCategory: 'beauty-wellness',
    defaultServices: [
      { name: 'Full Body Relaxation Massage', duration: 60, price: 80 },
      { name: 'Deep Tissue Massage', duration: 90, price: 120 },
      { name: 'Aromatherapy Session', duration: 60, price: 95 },
    ],
  },
  {
    id: 'pet-grooming',
    label: 'Pet Grooming',
    emoji: '🐾',
    templateCategory: 'home-services',
    defaultServices: [
      { name: 'Full Dog Grooming', duration: 60, price: 65 },
      { name: 'Bath & Brush', duration: 45, price: 40 },
      { name: 'Nail Clipping & Ear Cleaning', duration: 30, price: 25 },
    ],
  },
  {
    id: 'car-detailing',
    label: 'Car Detailing',
    emoji: '🚗',
    templateCategory: 'automotive',
    defaultServices: [
      { name: 'Interior Deep Clean', duration: 90, price: 120 },
      { name: 'Full Exterior Polish & Wax', duration: 120, price: 180 },
      { name: 'Express Wash & Vacuum', duration: 45, price: 50 },
    ],
  },
  {
    id: 'yoga-pilates',
    label: 'Yoga & Pilates',
    emoji: '🧘',
    templateCategory: 'fitness',
    defaultServices: [
      { name: 'Private Pilates Session', duration: 60, price: 85 },
      { name: '1-on-1 Yoga Alignment', duration: 60, price: 75 },
    ],
  },
  {
    id: 'personal-trainer',
    label: 'Personal Training',
    emoji: '🏋️‍♂️',
    templateCategory: 'fitness',
    defaultServices: [
      { name: 'Personal Training Session', duration: 60, price: 70 },
      { name: 'Fitness & Nutrition Consultation', duration: 45, price: 50 },
    ],
  },
  {
    id: 'clinic',
    label: 'Clinic & Healthcare',
    emoji: '🩺',
    templateCategory: 'healthcare-clinics',
    defaultServices: [
      { name: 'General Consultation', duration: 30, price: 60 },
      { name: 'Follow-up Checkup', duration: 20, price: 40 },
    ],
  },
  {
    id: 'photography-studio',
    label: 'Photography Studio',
    emoji: '📸',
    templateCategory: 'photography-creative',
    defaultServices: [
      { name: 'Studio Portrait Session', duration: 60, price: 150 },
      { name: 'Product Shoot (10 items)', duration: 120, price: 250 },
    ],
  },
  {
    id: 'other',
    label: 'General Appointment Business',
    emoji: '🏢',
    templateCategory: 'professional-services',
    defaultServices: [
      { name: 'Standard Appointment', duration: 45, price: 60 },
      { name: 'Consultation Session', duration: 60, price: 90 },
    ],
  },
];

const COUNTRIES_OPTIONS = worldCountries
  .map((c) => ({
    value: c.name.common,
    label: c.name.common,
    flag: c.flag,
    code: c.cca2,
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD ($)', symbol: '$' },
  { value: 'EUR', label: 'EUR (€)', symbol: '€' },
  { value: 'GBP', label: 'GBP (£)', symbol: '£' },
  { value: 'IDR', label: 'IDR (Rp)', symbol: 'Rp' },
  { value: 'SGD', label: 'SGD (S$)', symbol: 'S$' },
  { value: 'AUD', label: 'AUD (A$)', symbol: 'A$' },
  { value: 'CAD', label: 'CAD (C$)', symbol: 'C$' },
  { value: 'JPY', label: 'JPY (¥)', symbol: '¥' },
  { value: 'MYR', label: 'MYR (RM)', symbol: 'RM' },
  { value: 'PHP', label: 'PHP (₱)', symbol: '₱' },
  { value: 'INR', label: 'INR (₹)', symbol: '₹' },
];

// ── Deteksi otomatis negara & zona waktu (best effort, tanpa izin/peretwork)
// Negara: zona waktu IANA → negara, fallback region locale. Zona waktu sudah
// dari browser; kalau di luar daftar kurasi, tetap ditambahkan ke opsi supaya
// trigger Selector menampilkan nilainya (bukan placeholder kosong).
function detectedCountryName(): string {
  const code = browserCountryCode();
  const country = code ? worldCountries.find((c) => c.cca2 === code) : undefined;
  return country?.name.common ?? 'United States';
}

export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useSessionStore((s) => s.user);
  const setUser = useSessionStore((s) => s.setUser);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const updateWorkspaceStore = useWorkspaceStore((s) => s.updateWorkspace);

  const [theme, setTheme] = useState<AppTheme>(() => readStoredTheme());

  useEffect(() => {
    // Default to dark mode for onboarding
    applyTheme('dark');
    setTheme('dark');
    storeTheme('dark');
  }, []);

  const toggleTheme = () => {
    const nextTheme: AppTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    storeTheme(nextTheme);
    applyTheme(nextTheme);
  };

  const toast = useToast();
  const showError = (msg: string) => {
    toast({
      body: msg,
      type: 'error',
      isAutoHide: true,
      autoHideDuration: 5000,
    });
  };

  const [step, setStep] = useState<OnboardingStep>(1);
  /**
   * Langkah terakhir yang sudah dikirim ke backend. Persist hanya MAJU
   * (tidak boleh regresi saat user tekan Back) — progres wizard tidak
   * hilang jika user refresh di tengah jalan.
   */
  const persistedStepRef = useRef<OnboardingStep>(1);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Step 1: Business
  const [businessName, setBusinessName] = useState('');
  const [industry, setIndustry] = useState('barbershop');
  const [country, setCountry] = useState<string>(() => detectedCountryName());
  const [timezone, setTimezone] = useState<string>(() => browserTimezone());

  // Step 2: Services
  const [servicesList, setServicesList] = useState<ServiceRecord[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [newServiceName, setNewServiceName] = useState('');
  const [newServiceDuration, setNewServiceDuration] = useState(45);
  const [newServicePrice, setNewServicePrice] = useState(60);
  const [currency, setCurrency] = useState('USD');

  const [staffList, setStaffList] = useState<StaffRecord[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffContact, setNewStaffContact] = useState('');

  const activeWorkspace = useMemo(() => {
    return workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  }, [workspaces, activeWorkspaceId]);

  const workspaceSlug = useMemo(() => {
    const clean = businessName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return clean || 'subdomain';
  }, [businessName]);

  useEffect(() => {
    let cancelled = false;
    async function loadOnboarding() {
      try {
        void trackEvent('onboarding.started');
        const res = await apiFetch<{
          completed: boolean;
          step: number;
          workspace: Workspace | null;
          workspaces: Workspace[];
        }>('/me/onboarding');

        if (cancelled) return;

        if (res.completed) {
          navigate('/app/bookings', { replace: true });
          return;
        }

        if (res.workspace) {
          setBusinessName(res.workspace.name);
          if (res.workspace.industry) setIndustry(res.workspace.industry);
          if (res.workspace.country) setCountry(res.workspace.country);
        }

        const savedStep = (Math.min(Math.max(res.step || 1, 1), 3) as OnboardingStep);

        setStep(savedStep);
        persistedStepRef.current = savedStep;
      } catch (err) {
        console.error('Failed to load onboarding status:', err);
      } finally {
        if (!cancelled) setLoadingInitial(false);
      }
    }

    void loadOnboarding();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  useEffect(() => {
    if (!activeWorkspace?.id || step !== 2) return;
    let cancelled = false;
    async function fetchServices() {
      setServicesLoading(true);
      try {
        const res = await apiFetch<{ services: ServiceRecord[] }>('/services');
        if (!cancelled) {
          setServicesList(res.services);
        }
      } catch (err) {
        console.error('Failed to load services:', err);
      } finally {
        if (!cancelled) setServicesLoading(false);
      }
    }
    void fetchServices();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.id, step]);

  useEffect(() => {
    if (!activeWorkspace?.id || step !== 3) return;
    let cancelled = false;
    async function fetchStaff() {
      setStaffLoading(true);
      try {
        const res = await apiFetch<{ staff: StaffRecord[] }>('/staff');
        if (!cancelled) {
          setStaffList(res.staff);
        }
      } catch (err) {
        console.error('Failed to load staff:', err);
      } finally {
        if (!cancelled) setStaffLoading(false);
      }
    }
    void fetchStaff();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.id, step]);

  const goToStep = (nextStep: OnboardingStep) => {
    setStep(nextStep);
    if (nextStep > persistedStepRef.current) {
      persistedStepRef.current = nextStep;
      void apiFetch('/me/onboarding', {
        method: 'POST',
        body: JSON.stringify({ step: nextStep }),
      }).catch((err) => {
        console.error('Failed to save onboarding step:', err);
      });
    }
  };

  const handleStep1Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = businessName.trim();
    if (cleanName.length < 2) {
      showError(t('onboarding.step1_namePlaceholder'));
      return;
    }

    setIsSubmitting(true);
    try {
      const selectedInd = INDUSTRIES_CONFIG.find((ind) => ind.id === industry) ?? INDUSTRIES_CONFIG[0];
      let ws = activeWorkspace;

      if (!ws) {
        const res = await apiFetch<{ workspace: Workspace }>('/me/workspaces', {
          method: 'POST',
          body: JSON.stringify({
            name: cleanName,
            industry: selectedInd.id,
            country: country.trim() || null,
            templateCategory: selectedInd.templateCategory,
          }),
        });
        ws = res.workspace;
        addWorkspace(ws);
      } else {
        const res = await apiFetch<{ workspace: Workspace }>(`/me/workspaces/${ws.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: cleanName,
            industry: selectedInd.id,
            country: country.trim() || null,
            templateCategory: selectedInd.templateCategory,
          }),
        });
        ws = res.workspace;
        updateWorkspaceStore(ws);
      }

      await apiFetch('/me', {
        method: 'PATCH',
        body: JSON.stringify({
          name: user?.name || cleanName,
          timezone,
        }),
      });

      if (user) {
        setUser({ ...user, timezone });
      }

      void trackEvent('onboarding.business_created', {
        industry: selectedInd.id,
        country,
        timezone,
      });

      goToStep(2);
    } catch (err) {
      showError(errorMessage(err, t, 'errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddService = async (template?: { name: string; duration: number; price: number }) => {
    const sName = template ? template.name : newServiceName.trim();
    const sDuration = template ? template.duration : newServiceDuration;
    const sPrice = template ? template.price : newServicePrice;

    if (!sName) return;
    setIsSubmitting(true);

    try {
      const res = await apiFetch<{ service: ServiceRecord }>('/services', {
        method: 'POST',
        body: JSON.stringify({
          name: sName,
          durationMinutes: sDuration,
          priceMinor: Math.round(sPrice * 100),
          currency,
          isActive: true,
        }),
      });
      setServicesList((prev) => [...prev, res.service]);
      if (!template) {
        setNewServiceName('');
        setNewServicePrice(60);
      }
    } catch (err) {
      showError(errorMessage(err, t, 'errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteService = async (serviceId: string) => {
    try {
      await apiFetch(`/services/${serviceId}`, { method: 'DELETE' });
      setServicesList((prev) => prev.filter((s) => s.id !== serviceId));
    } catch (err) {
      showError(errorMessage(err, t, 'errors.generic'));
    }
  };

  const handleStep2Continue = () => {
    const activeCount = servicesList.filter((s) => s.isActive).length;
    if (activeCount === 0) {
      showError(t('onboarding.step2_atLeastOne'));
      return;
    }
    goToStep(3);
  };

  const handleAddStaff = async () => {
    const sName = newStaffName.trim();
    if (!sName) return;
    setIsSubmitting(true);

    const contact = newStaffContact.trim();
    const isEmail = contact.includes('@');

    try {
      const res = await apiFetch<{ staff: StaffRecord }>('/staff', {
        method: 'POST',
        body: JSON.stringify({
          name: sName,
          email: isEmail ? contact : undefined,
          phone: !isEmail && contact ? contact : undefined,
          isActive: true,
          timezone,
        }),
      });
      setStaffList((prev) => [...prev, res.staff]);
      setNewStaffName('');
      setNewStaffContact('');
    } catch (err) {
      showError(errorMessage(err, t, 'errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteStaff = async (staffId: string) => {
    try {
      await apiFetch(`/staff/${staffId}`, { method: 'DELETE' });
      setStaffList((prev) => prev.filter((s) => s.id !== staffId));
    } catch (err) {
      showError(errorMessage(err, t, 'errors.generic'));
    }
  };

  const handleStep3Continue = async () => {
    const activeCount = staffList.filter((s) => s.isActive).length;
    if (activeCount === 0) {
      showError(t('onboarding.step3_atLeastOne'));
      return;
    }
    await handleFinishOnboarding();
  };

  const handleFinishOnboarding = async () => {
    setIsSubmitting(true);
    try {
      await apiFetch('/me/onboarding', {
        method: 'POST',
        body: JSON.stringify({ completed: true }),
      });
      if (user) {
        setUser({ ...user, onboardingCompleted: true });
      }
      void trackEvent('onboarding.completed', {
        industry,
        services_count: servicesList.length,
        staff_count: staffList.length,
      });
      navigate('/app/bookings', { replace: true });
    } catch (err) {
      showError(errorMessage(err, t, 'errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/auth/sign-in', { replace: true });
  };

  const selectedIndustryObj = useMemo(() => {
    return INDUSTRIES_CONFIG.find((ind) => ind.id === industry) ?? INDUSTRIES_CONFIG[0];
  }, [industry]);

  const selectedCountryObj = useMemo(() => {
    return COUNTRIES_OPTIONS.find((c) => c.value.toLowerCase() === country.toLowerCase()) ?? COUNTRIES_OPTIONS.find((c) => c.value === 'United States');
  }, [country]);

  // Opsi zona waktu: daftar kurasi + zona browser bila di luar daftar.
  const timezoneOptions = useMemo(() => {
    const options = TIMEZONE_CURATED.map((tz) => ({ value: tz, label: timezoneLabel(tz) }));
    if (!TIMEZONE_CURATED.includes(timezone)) {
      options.push({ value: timezone, label: timezoneLabel(timezone) });
    }
    return options;
  }, [timezone]);

  if (loadingInitial) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-[#0B0D11] px-4 text-zinc-100 selection:bg-amber-500 selection:text-white">
        <div className="flex flex-col items-center gap-6">
          <AppBrand />
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-[#0B0D11] px-4 py-12 selection:bg-amber-500 selection:text-white">
      {/* Top right controls */}
      <div className="absolute right-6 top-6 flex items-center gap-3">
        <span className="text-xs font-medium text-zinc-400 hidden sm:inline-block">
          {`Step ${step} of 3`}
        </span>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex size-9 items-center justify-center rounded-lg border border-zinc-800 bg-[#161922] text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800/80 transition cursor-pointer"
          title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          {theme === 'dark' ? <IconSun className="size-4.5" /> : <IconMoon className="size-4.5" />}
        </button>
        <button
          type="button"
          onClick={() => void handleLogout()}
          className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/15 px-3.5 py-2 text-sm font-medium text-red-300 hover:bg-red-500/25 hover:border-red-500/50 hover:text-red-100 transition cursor-pointer"
          title={t('common.logout')}
        >
          <IconLogout className="size-4" />
          <span>{t('common.logout')}</span>
        </button>
      </div>

      <div className="w-full max-w-xl">
        {/* Logo icon */}
        <div className="mx-auto mb-5 flex size-11 items-center justify-center overflow-hidden rounded-lg bg-amber-500 shadow-md shadow-amber-500/10">
          <AppLogo />
        </div>

        {/* Heading & Subtitle */}
        {step === 1 && (
          <>
            <h1 className="text-center text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {t('onboarding.step1_title')}
            </h1>
            <p className="mt-1.5 text-center text-sm text-zinc-400">
              {t('onboarding.step1_subtitle')}
            </p>
          </>
        )}
        {step === 2 && (
          <>
            <h1 className="text-center text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {t('onboarding.step2_title')}
            </h1>
            <p className="mt-1.5 text-center text-sm text-zinc-400">
              {t('onboarding.step2_subtitle')}
            </p>
          </>
        )}
        {step === 3 && (
          <>
            <h1 className="text-center text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {t('onboarding.step3_title')}
            </h1>
            <p className="mt-1.5 text-center text-sm text-zinc-400">
              {t('onboarding.step3_subtitle')}
            </p>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════
         * STEP 1 — Company Name & Setup
         * ══════════════════════════════════════════════════════════ */}
        {step === 1 && (
          <form onSubmit={handleStep1Submit} className="mt-7 space-y-5">
            {/* Business Name */}
            <div>
              <TextInput
                label={t('onboarding.step1_nameLabel')}
                value={businessName}
                onChange={(val) => setBusinessName(val)}
                placeholder={t('onboarding.step1_namePlaceholder')}
                isRequired
                hasAutoFocus
                width="100%"
              />
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="text-zinc-500">{t('onboarding.step1_workspaceNotice')}</span>
                <span className="rounded-md border border-zinc-800/90 bg-[#161922] px-2.5 py-0.5 font-mono text-[11px] text-amber-400">
                  {workspaceSlug}.oriole.app
                </span>
              </div>
            </div>

            {/* Industry Selection via Astryx Selector */}
            <div>
              <Selector
                label={t('onboarding.step1_industryLabel')}
                description={t('onboarding.step1_industryDesc')}
                placeholder={t('onboarding.step1_industryPlaceholder')}
                options={INDUSTRIES_CONFIG.map((item) => ({
                  value: item.id,
                  label: item.label,
                  icon: <span className="text-base">{item.emoji}</span>,
                }))}
                value={industry}
                onChange={(val) => setIndustry(val)}
                startIcon={selectedIndustryObj?.emoji ? <span className="text-base">{selectedIndustryObj.emoji}</span> : undefined}
                hasSearch
                width="100%"
                renderOption={(option) => (
                  <SelectorOption
                    icon={option.icon}
                    label={option.label}
                  />
                )}
              />
            </div>

            {/* Country & Timezone (2 Cols) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Selector
                  label={t('onboarding.step1_countryLabel')}
                  placeholder={t('onboarding.step1_countryPlaceholder')}
                  options={COUNTRIES_OPTIONS.map((c) => ({
                    value: c.value,
                    label: c.label,
                    icon: <span className="text-base">{c.flag}</span>,
                  }))}
                  value={country}
                  onChange={(val) => setCountry(val)}
                  startIcon={selectedCountryObj?.flag ? <span className="text-base">{selectedCountryObj.flag}</span> : undefined}
                  hasSearch
                  searchPlaceholder={t('onboarding.step1_countrySearch')}
                  width="100%"
                  renderOption={(option) => (
                    <SelectorOption
                      icon={option.icon}
                      label={option.label}
                    />
                  )}
                />
              </div>
              <div>
                <Selector
                  label={t('onboarding.step1_timezoneLabel')}
                  options={timezoneOptions}
                  value={timezone}
                  onChange={(val) => setTimezone(val)}
                  hasSearch
                  width="100%"
                />
              </div>
            </div>

            {/* Submit Action */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={isSubmitting || businessName.trim().length < 2}
                className="w-full rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed h-10 px-4 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center cursor-pointer"
              >
                {isSubmitting ? (
                  <Spinner size="sm" />
                ) : (
                  <span>{t('onboarding.goToStep2')}</span>
                )}
              </button>
            </div>
          </form>
        )}

        {/* ══════════════════════════════════════════════════════════
         * STEP 2 — Add Services
         * ══════════════════════════════════════════════════════════ */}
        {step === 2 && (
          <div className="mt-7 space-y-5">
            {/* Quick Templates for Industry */}
            {servicesList.length === 0 && selectedIndustryObj.defaultServices.length > 0 && (
              <div>
                <span className="text-xs text-zinc-500 font-medium">{t('onboarding.step2_quickAdd')}:</span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedIndustryObj.defaultServices.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => void handleAddService(s)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#161922] px-3 py-1.5 text-xs font-medium text-amber-400 hover:border-amber-500/50 hover:bg-[#1c202c] transition cursor-pointer"
                    >
                      <IconPlus className="size-3" />
                      <span>{s.name} ({s.duration}m • ${s.price})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 2-Row Add Service Form */}
            <div className="space-y-3.5">
              <div>
                <TextInput
                  label={t('onboarding.step2_serviceName')}
                  value={newServiceName}
                  onChange={setNewServiceName}
                  placeholder={t('onboarding.step2_serviceNamePlaceholder')}
                  width="100%"
                />
              </div>

              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end w-full">
                <div className="w-full sm:flex-1 min-w-0">
                  <Selector
                    label={t('onboarding.step2_duration')}
                    options={[
                      { value: '15', label: '15 min' },
                      { value: '30', label: '30 min' },
                      { value: '45', label: '45 min' },
                      { value: '60', label: '60 min (1 hr)' },
                      { value: '90', label: '90 min (1.5 hr)' },
                      { value: '120', label: '120 min (2 hr)' },
                    ]}
                    value={String(newServiceDuration)}
                    onChange={(val) => setNewServiceDuration(Number(val))}
                    width="100%"
                  />
                </div>

                <div className="w-full sm:flex-1 min-w-0">
                  <InputGroup
                    label={t('onboarding.step2_priceAmount')}
                    className="w-full"
                  >
                    <Selector
                      label={t('onboarding.step2_currency')}
                      isLabelHidden
                      options={CURRENCY_OPTIONS.map((c) => ({
                        value: c.value,
                        label: c.label,
                      }))}
                      value={currency}
                      onChange={(val) => setCurrency(val)}
                      hasSearch
                      style={{ flex: '0 0 auto', width: 'fit-content' }}
                    />
                    <NumberInput
                      label={t('onboarding.step2_priceAmount')}
                      isLabelHidden
                      value={newServicePrice}
                      onChange={(val) => setNewServicePrice(val ?? 0)}
                      min={0}
                      width="100%"
                    />
                  </InputGroup>
                </div>

                <Button
                  label={t('onboarding.step2_addService')}
                  variant="primary"
                  size="md"
                  icon={<IconPlus className="size-3.5" />}
                  isDisabled={!newServiceName.trim() || isSubmitting}
                  onClick={() => void handleAddService()}
                />
              </div>
            </div>

            {/* Services List (Cards formatted like Staff Section) */}
            {servicesLoading ? (
              <div className="flex justify-center py-4"><Spinner size="sm" /></div>
            ) : servicesList.length > 0 ? (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {servicesList.map((service) => (
                  <div
                    key={service.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-[#161922] p-3 shadow-sm hover:border-zinc-700 transition"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-800/80 text-amber-400">
                        <IconServices className="size-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold text-white">
                          {service.name}
                        </div>
                        <div className="truncate text-xs text-zinc-400">
                          {service.durationMinutes} {t('onboarding.step2_minutes')} •{' '}
                          {service.priceMinor != null
                            ? `$${(service.priceMinor / 100).toFixed(0)}`
                            : 'No price'}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteService(service.id)}
                      className="flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-red-500/15 hover:text-red-400 transition cursor-pointer"
                      title={t('common.delete')}
                    >
                      <IconTrash className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-800 bg-[#161922]/50 px-4 py-4 text-center text-sm text-zinc-500">
                {t('onboarding.step2_noServices')}
              </div>
            )}

            {/* Navigation Actions */}
            <div className="pt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={servicesList.length === 0}
                onClick={handleStep2Continue}
                className="w-full rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed h-10 px-6 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center cursor-pointer"
              >
                {t('onboarding.goToStep3')}
              </button>
              <button
                type="button"
                onClick={() => goToStep(1)}
                className="w-full h-10 px-6 text-base font-semibold text-zinc-400 hover:text-zinc-200 active:scale-[0.99] transition duration-150 flex items-center justify-center cursor-pointer"
              >
                <span>{t('onboarding.backToStep1')}</span>
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
         * STEP 3 — Add Staff
         * ══════════════════════════════════════════════════════════ */}
        {step === 3 && (
          <div className="mt-7 space-y-5">
            {/* Single Row Add Staff Member Form */}
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end w-full">
              <div className="w-full sm:flex-1 min-w-0">
                <TextInput
                  label={t('onboarding.step3_staffName')}
                  value={newStaffName}
                  onChange={setNewStaffName}
                  placeholder={t('onboarding.step3_staffNamePlaceholder')}
                  width="100%"
                />
              </div>
              <div className="w-full sm:flex-1 min-w-0">
                <TextInput
                  label={t('onboarding.step3_staffContact')}
                  value={newStaffContact}
                  onChange={setNewStaffContact}
                  placeholder={t('onboarding.step3_staffContactPlaceholder')}
                  width="100%"
                />
              </div>
              <Button
                label={t('onboarding.step3_addStaff')}
                variant="primary"
                size="md"
                icon={<IconPlus className="size-3.5" />}
                isDisabled={!newStaffName.trim() || isSubmitting}
                onClick={() => void handleAddStaff()}
              />
            </div>

            {/* Staff List (Cards with DiceBear Critters Avatar) */}
            {staffLoading ? (
              <div className="flex justify-center py-4"><Spinner size="sm" /></div>
            ) : staffList.length > 0 ? (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {staffList.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-[#161922] p-3 shadow-sm hover:border-zinc-700 transition"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="size-10 shrink-0 overflow-hidden rounded-md border border-zinc-700/60 bg-zinc-800/80">
                        <img
                          src={`https://api.dicebear.com/10.x/critters/svg?seed=${encodeURIComponent(member.name || member.id)}`}
                          alt={member.name}
                          className="size-full object-cover"
                          loading="lazy"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold text-white">
                          {member.name}
                        </div>
                        <div className="truncate text-xs text-zinc-400">
                          {member.email || member.phone || t('onboarding.step3_active')}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteStaff(member.id)}
                      className="flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-red-500/15 hover:text-red-400 transition cursor-pointer"
                      title={t('common.delete')}
                    >
                      <IconTrash className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-800 bg-[#161922]/50 px-4 py-4 text-center text-sm text-zinc-500">
                {t('onboarding.step3_noStaff')}
              </div>
            )}

            {/* Navigation Actions */}
            <div className="pt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={staffList.length === 0 || isSubmitting}
                onClick={() => void handleStep3Continue()}
                className="w-full rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed h-10 px-6 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center cursor-pointer"
              >
                {isSubmitting ? (
                  <Spinner size="sm" />
                ) : (
                  <span>{t('onboarding.goToStep4')}</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => goToStep(2)}
                className="w-full h-10 px-6 text-base font-semibold text-zinc-400 hover:text-zinc-200 active:scale-[0.99] transition duration-150 flex items-center justify-center cursor-pointer"
              >
                <span>{t('onboarding.backToStep2')}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
