/** Opsi database Notion yang bisa diakses token integrasi. */
export interface NotionDatabaseOption {
  id: string;
  title: string;
  url: string;
}

/**
 * Integrasi terhubung (tanpa kredensial privat). `config` berisi field
 * publik per tipe — secret/token TIDAK pernah dikirim dari server.
 */
export interface WorkspaceIntegration {
  id: string;
  integrationType: 'notion' | 'google-forms' | 'google-calendar' | 'webhook' | 'tally' | 'slack' | 'payments' | 'video' | 'vapi' | string;
  identifier: string | null;
  isActive: boolean;
  lastSyncAt: string | null;
  config: {
    // Notion
    databaseId?: string | null;
    databaseName?: string | null;
    // Google Forms
    formId?: string | null;
    formName?: string | null;
    serviceAccountEmail?: string | null;
    // Google Forms & Tally — URL publik untuk dikirim ke customer
    formUrl?: string | null;
    // Google Calendar
    calendarId?: string | null;
    calendarName?: string | null;
    // Outgoing webhook
    url?: string | null;
    hasSecret?: boolean;
    // Tally
    webhookUrl?: string | null;
    hasWebhookSecret?: boolean;
    /** Marker migrasi dari Typeform (migration 0022) — banner di UI. */
    migratedFrom?: 'typeform' | null;
    // Slack — URL webhook TIDAK pernah dikirim (secret); hanya host + channel
    webhookUrlHost?: string | null;
    channel?: string | null;
    // Video — Zoom / Google Meet
    provider?: string | null;
    // Voice AI (Vapi) — nomor keluar pilihan workspace
    vapiPhoneNumberId?: string | null;
    phoneNumber?: string | null;
    /** 'byoc' = nomor dari akun Telnyx workspace sendiri; 'operator' = nomor server. */
    mode?: 'byoc' | 'operator' | null;
  };
}

export interface IntegrationListResponse {
  integrations: WorkspaceIntegration[];
}

/** Respons POST /integrations/notion/databases (token divalidasi, tidak disimpan). */
export interface NotionDatabasesResponse {
  user: { id: string; name: string | null };
  databases: NotionDatabaseOption[];
}

/** Respons POST /integrations/notion/sync. */
export interface NotionSyncResult {
  created: number;
  updated: number;
  total: number;
  lastSyncAt: string;
}

/** Respons POST /integrations/forms/preview (form + daftar pertanyaan). */
export interface GoogleFormPreviewResponse {
  form: { formId: string; title: string; questions: { id: string; title: string }[] };
  serviceAccountEmail: string;
}

/** Respons POST /integrations/forms/sync. */
export interface GoogleFormsSyncResult {
  imported: number;
  skipped: number;
  total: number;
  lastSyncAt: string;
}

/** Opsi form Tally milik akun (respons POST /integrations/tally/preview). */
export interface TallyFormOption {
  id: string;
  title: string;
}

/** Respons POST /integrations/tally/preview (API key divalidasi, tidak disimpan). */
export interface TallyPreviewResponse {
  forms: TallyFormOption[];
}

/** Respons POST /integrations/calendar/calendars. */
export interface GoogleCalendarListResponse {
  calendars: { id: string; summary: string; primary: boolean; accessRole: string }[];
  serviceAccountEmail: string;
}

/** Respons POST /integrations/calendar/sync. */
export interface GoogleCalendarSyncResult {
  created: number;
  updated: number;
  skipped: number;
  lastSyncAt: string;
}

/** Respons POST /integrations/webhook/test. */
export interface WebhookTestResult {
  delivered: boolean;
  status: number;
  sentAt: string;
}

/** Nomor telepon yang terdaftar di akun Vapi server (dari GET /integrations/vapi). */
export interface VapiPhoneNumberOption {
  id: string;
  number: string | null;
  name: string | null;
  provider: string;
}

/** Respons GET /integrations/vapi — status Voice AI + daftar nomor. */
export interface VapiVoiceStatusResponse {
  /** Panggilan keluar aktif (key + nomor default server). */
  configured: boolean;
  apiKeyConfigured: boolean;
  defaultPhoneNumberId: string | null;
  /** Nomor OPERATOR (BYOC workspace lain tidak tampil di picker). */
  numbers: VapiPhoneNumberOption[];
  selected: WorkspaceIntegration | null;
  error?: string | null;
}

/** Nomor di akun Telnyx milik workspace (dari POST /integrations/vapi/byoc/search). */
export interface TelnyxNumberOption {
  phoneNumber: string;
  /** ID internal Telnyx (ada pada nomor yang sudah dimiliki). */
  id?: string;
  connectionId?: string | null;
  locality?: string | null;
}

/** Respons POST /integrations/vapi/byoc/search — key divalidasi, tidak disimpan. */
export interface TelnyxByocSearchResponse {
  /** Nomor yang SUDAH dimiliki akun Telnyx ini (connect tanpa membeli). */
  owned: TelnyxNumberOption[];
  /** Nomor tersedia untuk dibeli (connect akan membeli). */
  available: TelnyxNumberOption[];
}

/** Respons POST /integrations/vapi/byoc/connect. */
export interface TelnyxByocConnectResponse {
  integration: WorkspaceIntegration;
  purchased: boolean;
  registered: boolean;
}

/** Satu nomor MASUK (inbound) milik workspace (dari GET /integrations/vapi/inbound). */
export interface VapiInboundNumber {
  id: string;
  vapiPhoneNumberId: string;
  /** Nomor E.164 — null selama provisioning berjalan. */
  number: string | null;
  name: string | null;
  provider: string;
  isActive: boolean;
  createdAt: string;
}

/** Respons GET /integrations/vapi/inbound. */
export interface VapiInboundStatusResponse {
  configured: boolean;
  numbers: VapiInboundNumber[];
}
