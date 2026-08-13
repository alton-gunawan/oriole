import { and, eq, inArray } from 'drizzle-orm';
import { serviceStaff, services } from '@oriole/database';

import { db } from '../db/index.ts';

/**
 * Snapshot layanan (service catalog) + staf yang melayani — bentuk yang sama
 * dengan yang dikembalikan route /api/services (staffIds = id staf ter-assign).
 */
export interface ServiceSnapshot {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  /** Harga dalam minor units (sen) — null = belum di-set. */
  priceMinor: number | null;
  currency: string;
  color: string;
  category: string[] | null;
  isActive: boolean;
  sortOrder: number;
  staffIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

type ServiceRow = typeof services.$inferSelect;
type ServiceStaffRow = typeof serviceStaff.$inferSelect;

function serializeService(row: ServiceRow, staffIds: string[]): ServiceSnapshot {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: row.durationMinutes,
    priceMinor: row.priceMinor,
    currency: row.currency,
    color: row.color,
    category: row.category,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    staffIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Muat layanan workspace + staffIds (2 query, group di JS — mirror staff.ts). */
export async function loadServices(workspaceId: string): Promise<ServiceSnapshot[]> {
  const rows = await db
    .select()
    .from(services)
    .where(eq(services.workspaceId, workspaceId))
    .orderBy(services.sortOrder, services.name);

  const staffByService = new Map<string, string[]>();
  if (rows.length > 0) {
    const links: ServiceStaffRow[] = await db
      .select()
      .from(serviceStaff)
      .where(inArray(serviceStaff.serviceId, rows.map((row) => row.id)));
    for (const link of links) {
      const list = staffByService.get(link.serviceId) ?? [];
      list.push(link.staffId);
      staffByService.set(link.serviceId, list);
    }
  }

  return rows.map((row) => serializeService(row, staffByService.get(row.id) ?? []));
}

/** Cari satu layanan milik workspace (undefined bila tidak ada / beda workspace). */
export async function findService(
  workspaceId: string,
  serviceId: string,
): Promise<ServiceSnapshot | undefined> {
  const [row] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return undefined;

  const links = await db.select().from(serviceStaff).where(eq(serviceStaff.serviceId, row.id));
  return serializeService(
    row,
    links.map((link) => link.staffId),
  );
}
