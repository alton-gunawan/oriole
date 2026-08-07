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
  integrationType: 'notion' | 'google-forms' | 'google-calendar' | 'webhook' | string;
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
    // Google Calendar
    calendarId?: string | null;
    calendarName?: string | null;
    // Outgoing webhook
    url?: string | null;
    hasSecret?: boolean;
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
