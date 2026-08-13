/** Mirrors GET /api/contacts — kontak klien per workspace. */
export interface ContactRecord {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactsListResponse {
  contacts: ContactRecord[];
  /** Kursor base64url untuk halaman berikutnya, null bila sudah di akhir. */
  nextCursor: string | null;
  hasMore: boolean;
}

/** Mirrors GET /api/contacts/:id — detail satu kontak. */
export interface ContactDetailResponse {
  contact: ContactRecord;
}

/** Payload POST /api/contacts. */
export interface CreateContactPayload {
  name: string;
  phone: string;
  email?: string;
  notes?: string;
}

export interface ContactFormDraft {
  name: string;
  phone: string;
  email: string;
  notes: string;
}

/** Normalize the add-contact form and reject the two required fields early. */
export function buildCreateContactPayload(draft: ContactFormDraft): CreateContactPayload | null {
  const name = draft.name.trim();
  const phone = draft.phone.trim();
  if (!name || !phone) return null;

  return {
    name,
    phone,
    ...(draft.email.trim() ? { email: draft.email.trim() } : {}),
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
  };
}
