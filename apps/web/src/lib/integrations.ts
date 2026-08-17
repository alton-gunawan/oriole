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
    /** Form memuat hidden field `phone` → URL ?phone= mengisi nomor otomatis. */
    prefillPhone?: boolean;
    /** Pertanyaan layanan memakai DROPDOWN dari katalog (bukan teks bebas). */
    serviceDropdown?: boolean;
    /** Kapan terakhir konten form disinkronkan (auto-sync guard). */
    lastContentSyncAt?: string | null;
    /** Alasan sinkronisasi konten gagal terakhir (null = sukses). */
    lastContentSyncError?: string | null;
    /** Status konfirmasi booking terakhir ke customer (diagnostik). */
    lastConfirmationAt?: string | null;
    lastConfirmationError?: string | null;
    // Slack — URL webhook TIDAK pernah dikirim (secret); hanya host + channel
    webhookUrlHost?: string | null;
    channel?: string | null;
    // Telegram booking alerts — chatId TIDAK pernah dikirim; hanya status + nama chat
    bound?: boolean;
    chatName?: string | null;
    // Video — Zoom / Google Meet
    provider?: string | null;
    // Voice AI (Vapi) — nomor keluar pilihan workspace
    vapiPhoneNumberId?: string | null;
    phoneNumber?: string | null;
    /** 'byoc' = nomor dari akun Telnyx workspace sendiri; 'operator' = nomor server. */
    mode?: 'byoc' | 'operator' | null;
    /** true = nomor baru diprovision tapi wizard setup belum selesai (belum aktif). */
    provisionPending?: boolean;
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

/**
 * Respons POST /integrations/telegram-alerts/connect — tautan bind deep-link.
 * Buka `bindUrl` lalu tekan Start pada bot untuk mengikat chat.
 */
export interface TelegramAlertsConnectResponse {
  integration: WorkspaceIntegration;
  bindUrl: string;
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

/** Satu nomor inbound (panggilan masuk) milik workspace. */
export interface InboundNumberInfo {
  id: string;
  vapiPhoneNumberId: string;
  number: string | null;
  name: string | null;
  provider: string;
  isActive: boolean;
  createdAt: string;
}

/** Respons GET /integrations/vapi/inbound — daftar nomor inbound workspace. */
export interface VapiInboundListResponse {
  configured: boolean;
  numbers: InboundNumberInfo[];
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

/** Respons POST /integrations/vapi/provision — nomor Vapi baru (belum aktif). */
export interface VapiProvisionResponse {
  integration: WorkspaceIntegration;
  vapiPhoneNumberId: string;
  number: string | null;
  provider: string;
}

/** Respons POST /integrations/vapi/test-call — panggilan uji dimulai. */
export interface VapiTestCallStartResponse {
  callId: string;
  status: string | null;
}

/** Respons GET /integrations/vapi/test-call/:callId — polling status. */
export interface VapiTestCallStatusResponse {
  status: string | null;
  endedReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  /** 'completed' | 'failed' | 'canceled' | null — dipetakan dari endedReason. */
  outcome: 'completed' | 'failed' | 'canceled' | null;
}

/** Respons GET /integrations/vapi/health — card "Phone health". */
export interface VapiHealthResponse {
  checkedAt: string;
  configured: boolean;
  vapiPhoneNumberId: string | null;
  numberActive: boolean;
  number: string | null;
  provider: string | null;
  assistantAssigned: boolean;
  outboundReady: boolean;
  webhookConfigured: boolean;
  lastWebhookAt: string | null;
  lastSuccessfulCallAt: string | null;
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

/** Status koneksi WhatsApp Business (Meta Embedded Signup — Tech Provider). */
export type WhatsAppBusinessStatus =
  | 'not_connected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected';

/**
 * Koneksi WhatsApp Business publik (dari GET /whatsapp-business) — TANPA
 * token/ID privat. `platformConfigured` = Meta App platform sudah disetel.
 */
export interface WhatsAppBusinessConnection {
  status: WhatsAppBusinessStatus;
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  businessName: string | null;
  aiAssistantEnabled: boolean;
  errorMessage: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  disconnectedAt: string | null;
  platformConfigured: boolean;
}

/** Respons GET /whatsapp-business (dan POST /refresh, /check). */
export interface WhatsAppBusinessStatusResponse {
  connection: WhatsAppBusinessConnection;
}

/** Respons POST /whatsapp-business/connect — URL dialog Embedded Signup. */
export interface WhatsAppBusinessConnectResponse {
  signupUrl: string;
}
