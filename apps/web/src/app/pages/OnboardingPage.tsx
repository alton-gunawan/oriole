import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  NumberInput,
  Selector,
  SelectorOption,
  Spinner,
  TextInput,
} from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';
import worldCountries from 'world-countries';

import { AppBrand, AppLogo } from '../components/AppLogo';
import { apiFetch, ApiError } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { errorMessage } from '../../lib/errors';
import { browserTimezone, TIMEZONE_CURATED, timezoneLabel } from '../../lib/timezones';
import { signOut } from '../../lib/session';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';
import type { Workspace } from '../../lib/workspace';
import type { ServiceRecord } from '../../lib/services';
import type { StaffRecord } from '../../lib/staff';
import type {
  VapiTestCallStartResponse,
  VapiTestCallStatusResponse,
  VapiVoiceStatusResponse,
} from '../../lib/integrations';
import {
  PhoneNumberWizardDialog,
  type WizardInitialState,
} from '../shell/phone/PhoneNumberWizard';
import { displayNumber } from '../shell/phone/phone';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronLeft,
  IconCreditCard,
  IconLogout,
  IconMoon,
  IconPhone,
  IconPlus,
  IconSparkles,
  IconSun,
  IconTrash,
} from '../shell/icons';
import { applyTheme, readStoredTheme, storeTheme, type AppTheme } from '../../lib/theme';

type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

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

  const [step, setStep] = useState<OnboardingStep>(1);
  /**
   * Langkah terakhir yang sudah dikirim ke backend. Persist hanya MAJU
   * (tidak boleh regresi saat user tekan Back) — progres wizard tidak
   * hilang jika user refresh di tengah jalan.
   */
  const persistedStepRef = useRef<OnboardingStep>(1);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Business
  const [businessName, setBusinessName] = useState('');
  const [industry, setIndustry] = useState('barbershop');
  const [country, setCountry] = useState('United States');
  const [timezone, setTimezone] = useState(browserTimezone);

  // Step 2: Services
  const [servicesList, setServicesList] = useState<ServiceRecord[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [newServiceName, setNewServiceName] = useState('');
  const [newServiceDuration, setNewServiceDuration] = useState(45);
  const [newServicePrice, setNewServicePrice] = useState(60);
  const [currency, setCurrency] = useState('USD');

  // Step 3: Staff
  const [staffList, setStaffList] = useState<StaffRecord[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffContact, setNewStaffContact] = useState('');

  // Step 4: Phone
  const [existingPhoneNumber, setExistingPhoneNumber] = useState('');
  const [phoneWizardOpen, setPhoneWizardOpen] = useState(false);
  const [phoneWizardInitial, setPhoneWizardInitial] = useState<WizardInitialState | null>(null);
  const [phoneStatus, setPhoneStatus] = useState<VapiVoiceStatusResponse | null>(null);
  const [phoneStatusLoading, setPhoneStatusLoading] = useState(false);

  // Step 5: Test Call
  const [testPhone, setTestPhone] = useState('');
  const [testCallPhase, setTestCallPhase] = useState<'idle' | 'calling' | 'success' | 'failed'>('idle');
  const [testCallStatus, setTestCallStatus] = useState<string | null>(null);
  const [testCallDuration, setTestCallDuration] = useState<number | null>(null);

  // Step 6: Trial / Subscription
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  // Active workspace object
  const activeWorkspace = useMemo(() => {
    return workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  }, [workspaces, activeWorkspaceId]);

  // Nomor AI yang sudah aktif (provisionPending diabaikan → belum siap).
  const connectedPhone = useMemo(() => {
    const s = phoneStatus?.selected;
    if (!s || s.config.provisionPending) return null;
    return s;
  }, [phoneStatus]);

  // Subdomain preview slug untuk Step 1
  const workspaceSlug = useMemo(() => {
    const clean = businessName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return clean || 'subdomain';
  }, [businessName]);

  // Muat status Voice AI saat user masuk Step 4 (untuk resume & menu wizard).
  useEffect(() => {
    if (step !== 4) return;
    let cancelled = false;
    setPhoneStatusLoading(true);
    apiFetch<VapiVoiceStatusResponse>('/integrations/vapi')
      .then((res) => {
        if (!cancelled) setPhoneStatus(res);
      })
      .catch(() => {
        if (!cancelled) setPhoneStatus(null);
      })
      .finally(() => {
        if (!cancelled) setPhoneStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Load saved onboarding status from backend
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
          if (res.workspace.phone) setExistingPhoneNumber(res.workspace.phone);
        }

        const isPaymentSuccess =
          typeof window !== 'undefined' &&
          (window.location.search.includes('_ptxn') ||
            window.location.search.includes('session=success'));

        const savedStep = isPaymentSuccess
          ? (7 as OnboardingStep)
          : (Math.min(Math.max(res.step || 1, 1), 7) as OnboardingStep);

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

  // Load services when reaching Step 2
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

  // Load staff when reaching Step 3
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

  // Save onboarding step progress to backend (only forward, never regress).
  const persistStep = async (nextStep: OnboardingStep) => {
    // Tekan Back → jangan turunkan step tersimpan di server; wizard tetap
    // dilanjutkan dari langkah terakhir yang pernah dicapai.
    if (nextStep <= persistedStepRef.current) return;
    persistedStepRef.current = nextStep;
    try {
      await apiFetch('/me/onboarding', {
        method: 'POST',
        body: JSON.stringify({ step: nextStep }),
      });
    } catch {
      // Non-critical, ignore transient failure
    }
  };

  const goToStep = (targetStep: OnboardingStep) => {
    setError(null);
    setStep(targetStep);
    void persistStep(targetStep);
  };

  // ── Step 1 Submit: Create or Update Business ──
  const handleStep1Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim() || businessName.trim().length < 2) {
      setError(t('validation.nameMin'));
      return;
    }
    setError(null);
    setIsSubmitting(true);

    try {
      const selectedInd = INDUSTRIES_CONFIG.find((ind) => ind.id === industry) ?? INDUSTRIES_CONFIG[0];
      let ws: Workspace;

      if (activeWorkspace) {
        const res = await apiFetch<{ workspace: Workspace }>(`/me/workspaces/${activeWorkspace.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: businessName.trim(),
            industry: selectedInd.id,
            country: country.trim() || null,
            templateCategory: selectedInd.templateCategory,
          }),
        });
        ws = res.workspace;
        updateWorkspaceStore(ws);
      } else {
        const res = await apiFetch<{ workspace: Workspace }>('/me/workspaces', {
          method: 'POST',
          body: JSON.stringify({
            name: businessName.trim(),
            industry: selectedInd.id,
            country: country.trim() || null,
            templateCategory: selectedInd.templateCategory,
          }),
        });
        ws = res.workspace;
        addWorkspace(ws);
      }

      // Update user profile timezone
      await apiFetch('/me', {
        method: 'PATCH',
        body: JSON.stringify({
          name: user?.name || businessName.trim(),
          timezone,
        }),
      });

      // Pastikan progres "di tengah wizard" (step 2) tersimpan sebelum
      // pindah langkah — kalau user refresh sesaat setelah ini, ia tetap
      // dilanjutkan di wizard, bukan dianggap selesai (backend melihat
      // workspace sudah ada).
      await persistStep(2);

      goToStep(2);
    } catch (err) {
      setError(errorMessage(err, t, 'errors.createBusiness'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Step 2 Actions: Services ──
  const handleAddService = async (customService?: { name: string; duration: number; price: number }) => {
    const sName = (customService ? customService.name : newServiceName).trim();
    const sDuration = customService ? customService.duration : newServiceDuration;
    const sPrice = customService ? customService.price : newServicePrice;

    if (!sName) return;
    setError(null);
    setIsSubmitting(true);

    try {
      const res = await apiFetch<{ service: ServiceRecord }>('/services', {
        method: 'POST',
        body: JSON.stringify({
          name: sName,
          durationMinutes: sDuration,
          priceMinor: Math.round(sPrice * 100),
          currency: currency || 'USD',
          isActive: true,
        }),
      });
      setServicesList((prev) => [...prev, res.service]);
      setNewServiceName('');
    } catch (err) {
      setError(errorMessage(err, t, 'errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteService = async (serviceId: string) => {
    try {
      await apiFetch(`/services/${serviceId}`, { method: 'DELETE' });
      setServicesList((prev) => prev.filter((s) => s.id !== serviceId));
    } catch (err) {
      setError(errorMessage(err, t, 'errors.generic'));
    }
  };

  const handleStep2Continue = () => {
    const activeCount = servicesList.filter((s) => s.isActive).length;
    if (activeCount === 0) {
      setError(t('onboarding.step2_atLeastOne'));
      return;
    }
    setError(null);
    goToStep(3);
  };

  // ── Step 3 Actions: Staff ──
  const handleAddStaff = async () => {
    const sName = newStaffName.trim();
    if (!sName) return;
    setError(null);
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
      setError(errorMessage(err, t, 'errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteStaff = async (staffId: string) => {
    try {
      await apiFetch(`/staff/${staffId}`, { method: 'DELETE' });
      setStaffList((prev) => prev.filter((s) => s.id !== staffId));
    } catch (err) {
      setError(errorMessage(err, t, 'errors.generic'));
    }
  };

  const handleStep3Continue = () => {
    const activeCount = staffList.filter((s) => s.isActive).length;
    if (activeCount === 0) {
      setError(t('onboarding.step3_atLeastOne'));
      return;
    }
    setError(null);
    goToStep(4);
  };

  // ── Step 4 Actions: Phone ──
  const refreshPhoneStatus = async (): Promise<VapiVoiceStatusResponse | null> => {
    try {
      const res = await apiFetch<VapiVoiceStatusResponse>('/integrations/vapi');
      setPhoneStatus(res);
      return res;
    } catch {
      setPhoneStatus(null);
      return null;
    }
  };

  const handleOpenPhoneWizard = () => {
    const pending = phoneStatus?.selected;
    if (pending?.config.provisionPending && pending.config.vapiPhoneNumberId) {
      // Setup belum selesai — lanjutkan wizard dari step Configure (resume).
      setPhoneWizardInitial({
        provisioned: {
          vapiPhoneNumberId: pending.config.vapiPhoneNumberId,
          number: pending.config.phoneNumber ?? null,
        },
      });
    } else {
      setPhoneWizardInitial(null);
    }
    setPhoneWizardOpen(true);
  };

  const handlePhoneWizardFinished = async () => {
    // Setelah nomor dikonfirmasi aktif, muat ulang status agar card
    // Step 4 menampilkan nomor yang terhubung.
    const res = await refreshPhoneStatus();
    const num = res?.selected?.config.phoneNumber ?? res?.selected?.identifier ?? null;
    if (num && !existingPhoneNumber.trim() && activeWorkspace) {
      try {
        await apiFetch(`/me/workspaces/${activeWorkspace.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ phone: num }),
        });
      } catch {
        // non-blocking
      }
    }
  };

  const handleStep4Continue = async () => {
    if (existingPhoneNumber.trim() && activeWorkspace) {
      try {
        await apiFetch(`/me/workspaces/${activeWorkspace.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ phone: existingPhoneNumber.trim() }),
        });
      } catch {
        // non-blocking
      }
    }
    goToStep(5);
  };

  // ── Step 5 Actions: Test AI Call ──
  const handleStartTestCall = async () => {
    const clean = testPhone.trim();
    if (!clean) {
      setError(t('onboarding.step5_testPhoneDesc'));
      return;
    }

    setError(null);
    setTestCallPhase('calling');
    setTestCallStatus('starting');

    try {
      const res = await apiFetch<VapiTestCallStartResponse>('/integrations/vapi/test-call', {
        method: 'POST',
        body: JSON.stringify({ phone: clean }),
      });

      const callId = res.callId;
      // Poll call status until completed
      const interval = window.setInterval(async () => {
        try {
          const info = await apiFetch<VapiTestCallStatusResponse>(`/integrations/vapi/test-call/${callId}`);
          setTestCallStatus(info.status);
          if (info.status === 'ended' || info.outcome) {
            window.clearInterval(interval);
            if (info.outcome === 'completed') {
              setTestCallPhase('success');
              setTestCallDuration(info.durationSeconds ?? 45);
            } else {
              setTestCallPhase('failed');
            }
          }
        } catch {
          window.clearInterval(interval);
          setTestCallPhase('failed');
        }
      }, 2500);
    } catch (err) {
      // Panggilan uji tidak benar-benar terjadi — jangan memalsukan sukses.
      // User harus tahu bahwa langkah verifikasi gagal agar tidak salah
      // mengira AI phone-nya sudah terverifikasi.
      setTestCallPhase('failed');
      setError(errorMessage(err, t, 'onboarding.step5_failedDesc'));
    }
  };

  // ── Step 6 Actions: Start 7-Day Trial ──
  const handleStartTrial = async () => {
    setError(null);
    setCheckoutBusy(true);
    try {
      const res = await apiFetch<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan: 'pro' }),
      });
      if (res.url) {
        window.location.assign(res.url);
      } else {
        goToStep(7);
      }
    } catch (err) {
      // Paddle belum dikonfigurasi (dev/test tanpa kunci) → izinkan lanjut
      // tanpa checkout. Kegagalan checkout NYATA ditampilkan agar user tidak
      // mengira trial sudah aktif padahal belum.
      if (err instanceof ApiError && err.status === 503) {
        goToStep(7);
      } else {
        setError(errorMessage(err, t, 'errors.billingAction'));
      }
    } finally {
      setCheckoutBusy(false);
    }
  };

  // ── Step 7 Actions: Finish Onboarding & Go to Bookings ──
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
      setError(errorMessage(err, t, 'errors.generic'));
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

  if (loadingInitial) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-[#0B0D11] px-4 text-zinc-100 selection:bg-amber-500 selection:text-white">
        <div className="flex flex-col items-center gap-6">
          <AppBrand />
          <span
            aria-hidden
            className="inline-block size-6 animate-spin rounded-full border-2 border-zinc-800 border-t-amber-500"
          />
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-[#0B0D11] px-4 py-12 selection:bg-amber-500 selection:text-white">
      {/* Top right controls */}
      <div className="absolute right-6 top-6 flex items-center gap-3">
        <span className="text-xs font-medium text-zinc-400 hidden sm:inline-block">
          {step <= 6 ? `Step ${step} of 6` : t('onboarding.step7_title')}
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
        {step <= 6 ? (
          <div className="mx-auto mb-5 flex size-11 items-center justify-center overflow-hidden rounded-lg bg-amber-500 shadow-md shadow-amber-500/10">
            <AppLogo />
          </div>
        ) : (
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/20">
            <IconSparkles className="size-7" />
          </div>
        )}

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
        {step === 4 && (
          <>
            <h1 className="text-center text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {t('onboarding.step4_title')}
            </h1>
            <p className="mt-1.5 text-center text-sm text-zinc-400">
              {t('onboarding.step4_subtitle')}
            </p>
          </>
        )}
        {step === 5 && (
          <>
            <h1 className="text-center text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {t('onboarding.step5_title')}
            </h1>
            <p className="mt-1.5 text-center text-sm text-zinc-400">
              {t('onboarding.step5_subtitle')}
            </p>
          </>
        )}
        {step === 6 && (
          <>
            <h1 className="text-center text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {t('onboarding.step6_title')}
            </h1>
            <p className="mt-1.5 text-center text-sm text-zinc-400">
              {t('onboarding.step6_subtitle')}
            </p>
          </>
        )}
        {step === 7 && (
          <>
            <h1 className="text-center text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {t('onboarding.step7_title')}
            </h1>
            <p className="mt-1.5 text-center text-sm text-zinc-400">
              {t('onboarding.step7_subtitle')}
            </p>
          </>
        )}

        {/* Global Error Banner */}
        {error && (
          <div className="mt-5 flex items-center justify-center gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-2.5 text-xs font-medium text-red-400">
            <IconAlertTriangle className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
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
                onChange={(val) => {
                  setBusinessName(val);
                  if (error) setError(null);
                }}
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
                  options={TIMEZONE_CURATED.map((tz) => ({
                    value: tz,
                    label: timezoneLabel(tz),
                  }))}
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
                  <span>{t('onboarding.step1_goToNext')}</span>
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

            {/* Services List */}
            {servicesLoading ? (
              <div className="flex justify-center py-3"><Spinner size="sm" /></div>
            ) : servicesList.length > 0 ? (
              <div className="divide-y divide-zinc-800/80 border-y border-zinc-800/80 py-1">
                {servicesList.map((service) => (
                  <div
                    key={service.id}
                    className="flex items-center justify-between py-2.5"
                  >
                    <div>
                      <span className="text-sm font-medium text-white">{service.name}</span>
                      <span className="ml-2 text-xs text-zinc-500">
                        {service.durationMinutes} {t('onboarding.step2_minutes')} •{' '}
                        {service.priceMinor != null
                          ? `$${(service.priceMinor / 100).toFixed(0)}`
                          : 'No price'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteService(service.id)}
                      className="text-zinc-500 hover:text-red-400 p-1 transition cursor-pointer"
                    >
                      <IconTrash className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Flat Add Custom Service Form */}
            <div>
              <TextInput
                label={t('onboarding.step2_serviceName')}
                value={newServiceName}
                onChange={setNewServiceName}
                placeholder={t('onboarding.step2_serviceNamePlaceholder')}
                width="100%"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
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
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  {t('onboarding.step2_priceAmount')}
                </label>
                <div className="flex gap-2 items-center">
                  <div className="w-28 shrink-0">
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
                      width="100%"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <NumberInput
                      label={t('onboarding.step2_priceAmount')}
                      isLabelHidden
                      value={newServicePrice}
                      onChange={(val) => setNewServicePrice(val ?? 0)}
                      min={0}
                      width="100%"
                    />
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              disabled={!newServiceName.trim() || isSubmitting}
              onClick={() => void handleAddService()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#161922] px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:border-zinc-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
            >
              <IconPlus className="size-3.5" />
              <span>{t('onboarding.step2_addService')}</span>
            </button>

            {/* Navigation Actions */}
            <div className="pt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => goToStep(1)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
              >
                <IconChevronLeft className="size-4" />
                <span>{t('onboarding.back')}</span>
              </button>
              <button
                type="button"
                disabled={servicesList.length === 0}
                onClick={handleStep2Continue}
                className="w-full sm:w-auto flex-1 rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed h-10 px-6 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center cursor-pointer"
              >
                {t('onboarding.continue')}
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
         * STEP 3 — Add Staff
         * ══════════════════════════════════════════════════════════ */}
        {step === 3 && (
          <div className="mt-7 space-y-5">
            {/* Staff List */}
            {staffLoading ? (
              <div className="flex justify-center py-3"><Spinner size="sm" /></div>
            ) : staffList.length > 0 ? (
              <div className="divide-y divide-zinc-800/80 border-y border-zinc-800/80 py-1">
                {staffList.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between py-2.5"
                  >
                    <div>
                      <span className="text-sm font-medium text-white">{member.name}</span>
                      {(member.email || member.phone) && (
                        <span className="ml-2 text-xs text-zinc-500">
                          {member.email ?? member.phone}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteStaff(member.id)}
                      className="text-zinc-500 hover:text-red-400 p-1 transition cursor-pointer"
                    >
                      <IconTrash className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Flat Add Staff Member Form */}
            <div>
              <TextInput
                label={t('onboarding.step3_staffName')}
                value={newStaffName}
                onChange={setNewStaffName}
                placeholder={t('onboarding.step3_staffNamePlaceholder')}
                width="100%"
              />
            </div>

            <div>
              <TextInput
                label={t('onboarding.step3_staffContact')}
                value={newStaffContact}
                onChange={setNewStaffContact}
                placeholder={t('onboarding.step3_staffContactPlaceholder')}
                width="100%"
              />
            </div>

            <button
              type="button"
              disabled={!newStaffName.trim() || isSubmitting}
              onClick={() => void handleAddStaff()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#161922] px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:border-zinc-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
            >
              <IconPlus className="size-3.5" />
              <span>{t('onboarding.step3_addStaff')}</span>
            </button>

            {/* Navigation Actions */}
            <div className="pt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => goToStep(2)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
              >
                <IconChevronLeft className="size-4" />
                <span>{t('onboarding.back')}</span>
              </button>
              <button
                type="button"
                disabled={staffList.length === 0}
                onClick={handleStep3Continue}
                className="w-full sm:w-auto flex-1 rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed h-10 px-6 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center cursor-pointer"
              >
                {t('onboarding.continue')}
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
         * STEP 4 — Connect Business Phone
         * ══════════════════════════════════════════════════════════ */}
        {step === 4 && (
          <div className="mt-7 space-y-5">
            {/* AI Phone Line */}
            {phoneStatusLoading ? (
              <div className="flex items-center gap-2 py-2 text-xs text-zinc-500">
                <Spinner size="sm" />
                <span>{t('phoneNumber.connecting')}</span>
              </div>
            ) : connectedPhone ? (
              <div className="rounded-lg border border-emerald-800/80 bg-emerald-950/30 p-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <IconCheck className="size-4" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {displayNumber(connectedPhone.config.phoneNumber ?? connectedPhone.identifier)}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {t('onboarding.step4_connectedTitle')}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleOpenPhoneWizard}
                  className="rounded-lg border border-zinc-700 bg-[#161922] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white transition cursor-pointer"
                >
                  {t('phoneNumber.manage')}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-zinc-400">
                  {t('onboarding.step4_connectDesc')}
                </p>
                <button
                  type="button"
                  onClick={handleOpenPhoneWizard}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] h-10 px-5 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 cursor-pointer"
                >
                  <IconPhone className="size-4" />
                  <span>{t('onboarding.step4_connectCta')}</span>
                </button>
              </div>
            )}

            <div className="pt-2">
              <TextInput
                label={t('onboarding.step4_phoneInputLabel')}
                value={existingPhoneNumber}
                onChange={setExistingPhoneNumber}
                placeholder={t('onboarding.step4_phoneInputPlaceholder')}
                width="100%"
              />
              <p className="mt-1.5 text-xs text-zinc-500">
                {t('onboarding.step4_skipNote')}
              </p>
            </div>

            {/* Navigation Actions */}
            <div className="pt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => goToStep(3)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
              >
                <IconChevronLeft className="size-4" />
                <span>{t('onboarding.back')}</span>
              </button>
              <button
                type="button"
                onClick={handleStep4Continue}
                className="w-full sm:w-auto flex-1 rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] h-10 px-6 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center cursor-pointer"
              >
                {t('onboarding.continue')}
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
         * STEP 5 — Test AI Call
         * ══════════════════════════════════════════════════════════ */}
        {step === 5 && (
          <div className="mt-7 space-y-5">
            {testCallPhase === 'idle' && (
              <div className="space-y-4">
                <div>
                  <TextInput
                    label={t('onboarding.step5_testPhoneLabel')}
                    value={testPhone}
                    onChange={setTestPhone}
                    placeholder={t('onboarding.step5_testPhonePlaceholder')}
                    description={t('onboarding.step5_testPhoneDesc')}
                    width="100%"
                    hasAutoFocus
                  />
                </div>
                <button
                  type="button"
                  disabled={!testPhone.trim()}
                  onClick={() => void handleStartTestCall()}
                  className="w-full rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed h-10 px-4 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <IconPhone className="size-4" />
                  <span>{t('onboarding.step5_callMyPhone')}</span>
                </button>
              </div>
            )}

            {testCallPhase === 'calling' && (
              <div className="py-6 text-center space-y-3">
                <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-500 text-zinc-950 animate-bounce">
                  <IconPhone className="size-6" />
                </span>
                <h3 className="text-lg font-bold text-white">
                  {t('onboarding.step5_callingStatus')}
                </h3>
                <p className="text-sm text-zinc-400">
                  {testCallStatus === 'ringing'
                    ? 'Phone is ringing… Answer to speak with Sarah.'
                    : 'Connecting to your phone…'}
                </p>
              </div>
            )}

            {testCallPhase === 'success' && (
              <div className="py-4 space-y-2">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-emerald-500 text-white shrink-0">
                    <IconCheck className="size-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-bold text-white">
                      {t('onboarding.step5_successTitle')}
                    </h3>
                    <p className="text-xs text-zinc-400">
                      {t('onboarding.step5_successDesc')}
                    </p>
                  </div>
                </div>
                {testCallDuration && (
                  <p className="text-xs font-semibold text-emerald-400">
                    Duration: {testCallDuration}s • Verified bookable assistant
                  </p>
                )}
              </div>
            )}

            {testCallPhase === 'failed' && (
              <div className="py-4 space-y-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-red-500 text-white shrink-0">
                    <IconAlertTriangle className="size-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-bold text-white">
                      {t('onboarding.step5_failedTitle')}
                    </h3>
                    <p className="text-xs text-zinc-400">
                      {t('onboarding.step5_failedDesc')}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setTestCallPhase('idle')}
                    className="rounded-lg border border-zinc-700 bg-[#161922] px-3.5 py-1.5 text-xs font-medium text-zinc-300 hover:text-white transition cursor-pointer"
                  >
                    {t('onboarding.step5_tryAgain')}
                  </button>
                  <button
                    type="button"
                    onClick={() => goToStep(4)}
                    className="rounded-lg px-3.5 py-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-300 transition cursor-pointer"
                  >
                    {t('onboarding.step5_reviewPhone')}
                  </button>
                </div>
              </div>
            )}

            {/* Navigation Actions */}
            <div className="pt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => goToStep(4)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
              >
                <IconChevronLeft className="size-4" />
                <span>{t('onboarding.back')}</span>
              </button>
              <button
                type="button"
                onClick={() => goToStep(6)}
                className="w-full sm:w-auto flex-1 rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] h-10 px-6 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center cursor-pointer"
              >
                {t('onboarding.step5_continue')}
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
         * STEP 6 — Start 7-Day Trial
         * ══════════════════════════════════════════════════════════ */}
        {step === 6 && (
          <div className="mt-7 space-y-6">
            <div className="space-y-3 text-center">
              <div className="flex items-baseline justify-center gap-2">
                <span className="text-5xl font-extrabold text-white">
                  {t('onboarding.step6_todayZero')}
                </span>
                <span className="text-sm font-medium text-zinc-500">
                  ({t('onboarding.step6_afterTrial')})
                </span>
              </div>
              <p className="text-sm font-semibold text-emerald-400">
                ✓ {t('onboarding.step6_trialCreditIncluded')} • 7-day free trial • Cancel anytime
              </p>
            </div>

            <div className="space-y-2 text-sm text-zinc-400 border-y border-zinc-800/80 py-4">
              <p>✓ Unlimited bookings & automated confirmation</p>
              <p>✓ AI rescheduling & cancellation handling</p>
              <p>✓ Manage staff schedules & service catalog</p>
              <p>✓ Keep your existing business phone number</p>
              <p>✓ {t('onboarding.step6_paygNote')}</p>
              <p>✓ {t('onboarding.step6_noSetup')}</p>
            </div>

            <p className="text-xs text-zinc-500 text-center">
              {t('onboarding.step6_cardNotice')}
            </p>

            {/* Trial CTA */}
            <div className="space-y-3">
              <button
                type="button"
                disabled={checkoutBusy}
                onClick={() => void handleStartTrial()}
                className="w-full rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed h-10 px-4 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center gap-2 cursor-pointer"
              >
                {checkoutBusy ? (
                  <Spinner size="sm" />
                ) : (
                  <>
                    <IconCreditCard className="size-4" />
                    <span>{t('onboarding.step6_startTrial')}</span>
                  </>
                )}
              </button>
            </div>

            {/* Navigation Actions */}
            <div className="pt-2 flex items-center">
              <button
                type="button"
                onClick={() => goToStep(5)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
              >
                <IconChevronLeft className="size-4" />
                <span>{t('onboarding.back')}</span>
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
         * STEP 7 — Ready to Go (Success Screen)
         * ══════════════════════════════════════════════════════════ */}
        {step === 7 && (
          <div className="mt-7 space-y-6">
            <div className="space-y-3 text-sm text-zinc-300 border-y border-zinc-800/80 py-4">
              <div className="flex items-center gap-2.5">
                <IconCheck className="size-4 text-emerald-400 shrink-0" />
                <span>{t('onboarding.step7_businessReady')}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <IconCheck className="size-4 text-emerald-400 shrink-0" />
                <span>{t('onboarding.step7_servicesReady')}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <IconCheck className="size-4 text-emerald-400 shrink-0" />
                <span>{t('onboarding.step7_staffReady')}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <IconCheck className="size-4 text-emerald-400 shrink-0" />
                <span>{t('onboarding.step7_aiReady')}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <IconCheck className="size-4 text-emerald-400 shrink-0" />
                <span>{t('onboarding.step7_trialReady')}</span>
              </div>
            </div>

            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => void handleFinishOnboarding()}
              className="w-full rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed h-10 px-4 text-base font-semibold text-zinc-950 shadow-sm transition duration-150 flex items-center justify-center cursor-pointer"
            >
              {isSubmitting ? (
                <Spinner size="sm" />
              ) : (
                <span>{t('onboarding.step7_goToBookings')}</span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Wizard provisioning nomor AI (Step 4) */}
      <PhoneNumberWizardDialog
        isOpen={phoneWizardOpen}
        onOpenChange={setPhoneWizardOpen}
        initialState={phoneWizardInitial}
        existingNumbers={phoneStatus?.numbers ?? null}
        onComplete={() => void refreshPhoneStatus()}
        onFinished={() => void handlePhoneWizardFinished()}
      />
    </main>
  );
}
