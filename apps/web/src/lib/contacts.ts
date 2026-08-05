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

/** Payload POST /api/contacts. */
export interface CreateContactPayload {
  name: string;
  phone: string;
  email?: string;
  notes?: string;
}
