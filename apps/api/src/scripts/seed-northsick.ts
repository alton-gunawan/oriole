import { eq } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import {
  createDb,
  workspaces,
  services,
  staffMembers,
  staffSchedules,
  serviceStaff,
  staffTimeOff,
  contacts,
  bookings,
  conversations,
  messages,
  waitlistEntries,
  type BusinessHoursEntry,
  type AiKnowledge,
} from '@oriole/database';

loadRootEnv();

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const db = createDb(dbUrl);

const USER_ID = '443fc524-8a27-4643-b620-c846c9df7e7b'; // altongunawan27@gmail.com
const WS_ID = 'cb6c875b-786c-492e-8561-813f6a357310'; // Northsick Studio
const TIMEZONE = 'Australia/Perth';

function at(h: number, m = 0): number {
  return h * 60 + m;
}

async function seed() {
  console.log('🚀 Mulai populating dummy data untuk Northsick Studio (altongunawan27@gmail.com)...');

  // 1. Update Workspace
  const businessHours: BusinessHoursEntry[] = [
    { dayOfWeek: 1, startMinutes: at(9), endMinutes: at(18) }, // Mon 09:00 - 18:00
    { dayOfWeek: 2, startMinutes: at(9), endMinutes: at(18) }, // Tue 09:00 - 18:00
    { dayOfWeek: 3, startMinutes: at(9), endMinutes: at(18) }, // Wed 09:00 - 18:00
    { dayOfWeek: 4, startMinutes: at(9), endMinutes: at(19) }, // Thu 09:00 - 19:00 (Late night)
    { dayOfWeek: 5, startMinutes: at(9), endMinutes: at(19) }, // Fri 09:00 - 19:00
    { dayOfWeek: 6, startMinutes: at(9), endMinutes: at(17) }, // Sat 09:00 - 17:00
    { dayOfWeek: 0, startMinutes: at(10), endMinutes: at(15) }, // Sun 10:00 - 15:00
  ];

  const aiKnowledge: AiKnowledge = {
    description: 'Northsick Studio is Perth’s premier modern barbershop & grooming studio, specializing in precision fades, beard sculpting, and luxury grooming.',
    services: 'Classic Haircut ($45), Signature Beard Sculpt ($35), Full Executive Package ($85), Buzz Cut & Lineup ($30), Royal Hot Towel Shave ($40), Scalp Treatment ($55), Junior Grooming ($30)',
    hours: 'Monday-Wednesday: 9am-6pm, Thursday-Friday: 9am-7pm, Saturday: 9am-5pm, Sunday: 10am-3pm',
    location: '128 Northbridge St, Perth WA 6000 (near Russell Square, street parking available)',
    policy: 'Appointments recommended. Walk-ins welcomed subject to chair availability. Please give at least 2 hours notice for cancellations.',
    faq: [
      { q: 'Do you accept walk-ins?', a: 'Yes! Walk-ins are welcomed, though bookings are recommended for peak hours.' },
      { q: 'Is parking available nearby?', a: 'Yes, street parking is available along Northbridge St and Russell Square.' },
      { q: 'Do you offer complimentary drinks?', a: 'Yes, we provide complimentary barista coffee, cold brew, and craft sodas for all clients.' },
    ],
  };

  await db
    .update(workspaces)
    .set({
      phone: '+61 8 9227 8890',
      city: 'Perth',
      country: 'Australia',
      address: '128 Northbridge St, Perth WA 6000',
      website: 'https://northsick.studio',
      businessHours,
      aiKnowledge,
      reminderLeadMinutes: 120,
      autoCallLeadHours: 24,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, WS_ID));

  console.log('✅ Workspace info & business hours updated.');

  // 2. Services (Katalog Layanan)
  const serviceDefs = [
    {
      name: 'Classic Haircut & Style',
      description: 'Consultation, precision tailored scissor & clipper cut, hot towel neck shave, styling with premium pomade.',
      durationMinutes: 45,
      priceMinor: 4500,
      currency: 'AUD',
      color: '#f59e0b',
      category: ['Haircut', 'Popular'],
      sortOrder: 1,
    },
    {
      name: 'Signature Beard Sculpt & Hot Towel',
      description: 'Precision beard shaping, line-up with straight razor, essential oil hot towel treatment, and beard balm.',
      durationMinutes: 30,
      priceMinor: 3500,
      currency: 'AUD',
      color: '#10b981',
      category: ['Beard', 'Grooming'],
      sortOrder: 2,
    },
    {
      name: 'The Full Executive Package',
      description: 'The ultimate gentleman’s experience: Classic Haircut, Signature Beard Sculpt, Clay Facial Mask, & Scalp Massage.',
      durationMinutes: 75,
      priceMinor: 8500,
      currency: 'AUD',
      color: '#8b5cf6',
      category: ['Package', 'VIP'],
      sortOrder: 3,
    },
    {
      name: 'Buzz Cut & Razor Lineup',
      description: 'Even clipper grade all over, sharp perimeter line-up with straight razor, and refreshing cold splash.',
      durationMinutes: 30,
      priceMinor: 3000,
      currency: 'AUD',
      color: '#0ea5e9',
      category: ['Haircut'],
      sortOrder: 4,
    },
    {
      name: 'Royal Hot Towel Shave',
      description: 'Traditional multi-step straight razor wet shave with pre-shave oil, hot lather, steamed towels, and cooling balm.',
      durationMinutes: 40,
      priceMinor: 4000,
      currency: 'AUD',
      color: '#ec4899',
      category: ['Shave', 'Traditional'],
      sortOrder: 5,
    },
    {
      name: 'Scalp Treatment & Relaxing Massage',
      description: 'Deep cleansing exfoliating scalp detox with tea tree & mint massage, followed by nourishing tonic.',
      durationMinutes: 45,
      priceMinor: 5500,
      currency: 'AUD',
      color: '#f97316',
      category: ['Treatment', 'Wellness'],
      sortOrder: 6,
    },
    {
      name: 'Junior Grooming (Under 16)',
      description: 'Clean, modern haircut for kids and teens including natural style finishing.',
      durationMinutes: 30,
      priceMinor: 3000,
      currency: 'AUD',
      color: '#06b6d4',
      category: ['Kids', 'Haircut'],
      sortOrder: 7,
    },
  ];

  const insertedServices = await db
    .insert(services)
    .values(
      serviceDefs.map((s) => ({
        userId: USER_ID,
        workspaceId: WS_ID,
        ...s,
        isActive: true,
      }))
    )
    .returning();

  console.log(`✅ ${insertedServices.length} Services created in catalog.`);

  // 3. Staff & Team
  const staffDefs = [
    {
      name: 'Emma Vance',
      email: 'emma.vance@northsick.studio',
      phone: '+61412100101',
      color: '#f59e0b',
      timezone: TIMEZONE,
      bufferMinutes: 5,
      isActive: true,
      schedules: [
        { dayOfWeek: 1, startMinutes: at(9), endMinutes: at(17) },
        { dayOfWeek: 2, startMinutes: at(9), endMinutes: at(17) },
        { dayOfWeek: 3, startMinutes: at(9), endMinutes: at(17) },
        { dayOfWeek: 4, startMinutes: at(10), endMinutes: at(19) },
        { dayOfWeek: 5, startMinutes: at(10), endMinutes: at(19) },
      ],
      timeOff: [
        {
          startDate: new Date(Date.now() + 18 * 86400000),
          endDate: new Date(Date.now() + 20 * 86400000),
          reason: 'Barber Expo Melbourne',
        },
      ],
    },
    {
      name: 'Liam "Slick" O’Connor',
      email: 'liam@northsick.studio',
      phone: '+61412100102',
      color: '#0ea5e9',
      timezone: TIMEZONE,
      bufferMinutes: 5,
      isActive: true,
      schedules: [
        { dayOfWeek: 2, startMinutes: at(9), endMinutes: at(18) },
        { dayOfWeek: 3, startMinutes: at(9), endMinutes: at(18) },
        { dayOfWeek: 4, startMinutes: at(9), endMinutes: at(19) },
        { dayOfWeek: 5, startMinutes: at(9), endMinutes: at(19) },
        { dayOfWeek: 6, startMinutes: at(9), endMinutes: at(17) },
      ],
    },
    {
      name: 'Lucas Vance',
      email: 'lucas@northsick.studio',
      phone: '+61412100103',
      color: '#10b981',
      timezone: TIMEZONE,
      bufferMinutes: 5,
      isActive: true,
      schedules: [
        { dayOfWeek: 1, startMinutes: at(9), endMinutes: at(18) },
        { dayOfWeek: 3, startMinutes: at(9), endMinutes: at(18) },
        { dayOfWeek: 4, startMinutes: at(9), endMinutes: at(18) },
        { dayOfWeek: 5, startMinutes: at(9), endMinutes: at(18) },
        { dayOfWeek: 6, startMinutes: at(9), endMinutes: at(17) },
        { dayOfWeek: 0, startMinutes: at(10), endMinutes: at(15) },
      ],
    },
    {
      name: 'Marcus Thorne',
      email: 'marcus@northsick.studio',
      phone: '+61412100104',
      color: '#8b5cf6',
      timezone: TIMEZONE,
      bufferMinutes: 0,
      isActive: true,
      schedules: [
        { dayOfWeek: 1, startMinutes: at(10), endMinutes: at(18) },
        { dayOfWeek: 2, startMinutes: at(10), endMinutes: at(18) },
        { dayOfWeek: 4, startMinutes: at(11), endMinutes: at(19) },
        { dayOfWeek: 5, startMinutes: at(11), endMinutes: at(19) },
        { dayOfWeek: 6, startMinutes: at(9), endMinutes: at(17) },
      ],
    },
  ];

  // Update existing Emma
  const existingStaff = await db.select().from(staffMembers).where(eq(staffMembers.workspaceId, WS_ID));
  let emmaId = existingStaff[0]?.id;
  if (emmaId) {
    await db
      .update(staffMembers)
      .set({
        name: 'Emma Vance',
        email: 'emma.vance@northsick.studio',
        phone: '+61412100101',
        color: '#f59e0b',
        timezone: TIMEZONE,
        bufferMinutes: 5,
        updatedAt: new Date(),
      })
      .where(eq(staffMembers.id, emmaId));
  } else {
    const [created] = await db
      .insert(staffMembers)
      .values({
        userId: USER_ID,
        workspaceId: WS_ID,
        name: 'Emma Vance',
        email: 'emma.vance@northsick.studio',
        phone: '+61412100101',
        color: '#f59e0b',
        timezone: TIMEZONE,
        bufferMinutes: 5,
        isActive: true,
      })
      .returning();
    emmaId = created.id;
  }

  // Insert remaining 3 staff
  const remainingStaffDefs = staffDefs.slice(1);
  const otherStaff = await db
    .insert(staffMembers)
    .values(
      remainingStaffDefs.map((st) => ({
        userId: USER_ID,
        workspaceId: WS_ID,
        name: st.name,
        email: st.email,
        phone: st.phone,
        color: st.color,
        timezone: st.timezone,
        bufferMinutes: st.bufferMinutes,
        isActive: st.isActive,
      }))
    )
    .returning();

  const allStaff = [{ id: emmaId, ...staffDefs[0] }, ...otherStaff.map((st, i) => ({ id: st.id, ...remainingStaffDefs[i] }))];

  // Insert Staff Schedules & TimeOff
  for (const st of allStaff) {
    if (st.schedules && st.schedules.length > 0) {
      await db.insert(staffSchedules).values(
        st.schedules.map((sch) => ({
          staffId: st.id,
          dayOfWeek: sch.dayOfWeek,
          startMinutes: sch.startMinutes,
          endMinutes: sch.endMinutes,
        }))
      );
    }
    if (st.timeOff && st.timeOff.length > 0) {
      await db.insert(staffTimeOff).values(
        st.timeOff.map((to) => ({
          staffId: st.id,
          startDate: to.startDate,
          endDate: to.endDate,
          reason: to.reason,
        }))
      );
    }
  }

  // Link services to all staff members
  const serviceStaffPairs: { serviceId: string; staffId: string }[] = [];
  for (const s of insertedServices) {
    for (const st of allStaff) {
      serviceStaffPairs.push({ serviceId: s.id, staffId: st.id });
    }
  }
  await db.insert(serviceStaff).values(serviceStaffPairs);
  console.log(`✅ ${allStaff.length} Staff members & schedules configured and linked to services.`);

  // 4. Contacts (16 realistic clients)
  const contactDefs = [
    { name: 'Oliver Smith', phone: '+61412345001', email: 'oliver.smith@gmail.com', notes: 'Prefers high skin fade with matte clay.' },
    { name: 'Jack Wilson', phone: '+61412345002', email: 'jack.w@outlook.com', notes: 'Regular every 3 weeks. Likes espresso before cut.' },
    { name: 'William Brown', phone: '+61412345003', email: 'willy.brown@icloud.com', notes: 'Executive beard shape & mustache trim.' },
    { name: 'Thomas Taylor', phone: '+61412345004', email: 'thomas.t@corp.com.au', notes: 'Sensitive skin - use alcohol-free balm.' },
    { name: 'Noah Davies', phone: '+61412345005', email: 'noah.davies@perthtech.io', notes: 'Prefers scissors on top, textured crop.' },
    { name: 'James Evans', phone: '+61412345006', email: 'james.evans@gmail.com', notes: 'Full Executive Package monthly.' },
    { name: 'Ethan Thomas', phone: '+61412345007', email: 'ethan.t@westoz.com.au', notes: 'Taper fade + beard line-up.' },
    { name: 'Alexander Roberts', phone: '+61412345008', email: 'alex.roberts@gmail.com', notes: 'Likes sharp razor line.' },
    { name: 'Lucas Campbell', phone: '+61412345009', email: 'luke.campbell@yahoo.com', notes: 'Usually books with Liam.' },
    { name: 'Mason Johnson', phone: '+61412345010', email: 'mason.j@gmail.com', notes: 'Hot towel shave regular.' },
    { name: 'Daniel Clark', phone: '+61412345011', email: 'daniel.clark@outlook.com', notes: 'Classic side part with pomade.' },
    { name: 'Matthew White', phone: '+61412345012', email: 'matt.white@perthlaw.com.au', notes: 'Corporate styling & beard trim.' },
    { name: 'Harry Walker', phone: '+61412345013', email: 'harry.walker@gmail.com', notes: 'Scalp detox + classic cut.' },
    { name: 'Benjamin Wright', phone: '+61412345014', email: 'ben.wright@icloud.com', notes: 'Buzz cut #2 with clean edge.' },
    { name: 'Samuel Hall', phone: '+61412345015', email: 'sam.hall@gmail.com', notes: 'Brought son for junior cut.' },
    { name: 'Christian Hughes', phone: '+61412345016', email: 'c.hughes@perthmining.com', notes: 'FIFO worker, books 2 weeks in advance.' },
  ];

  const insertedContacts = await db
    .insert(contacts)
    .values(
      contactDefs.map((c) => ({
        userId: USER_ID,
        workspaceId: WS_ID,
        ...c,
      }))
    )
    .returning();

  console.log(`✅ ${insertedContacts.length} Contacts created.`);

  // 5. Bookings (34 realistic bookings across -10 days, today, and +12 days)
  const now = new Date();
  const bookingRows: Array<{
    userId: string;
    workspaceId: string;
    description: string | null;
    scheduledAt: Date;
    timezone: string;
    status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
    customerName: string;
    phone: string;
    contactId: string;
    staffId: string;
    serviceId: string;
    durationMinutes: number;
    noShowCount: number;
    changeRequested: boolean;
  }> = [];

  const bookingConfigs: Array<{
    dayOffset: number;
    hour: number;
    minute: number;
    status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
    contactIdx: number;
    serviceIdx: number;
    staffIdx: number;
    note?: string;
    noShow?: number;
    changeReq?: boolean;
  }> = [
    // Past Bookings (Completed)
    { dayOffset: -7, hour: 10, minute: 0, status: 'completed', contactIdx: 0, serviceIdx: 0, staffIdx: 0 },
    { dayOffset: -7, hour: 14, minute: 30, status: 'completed', contactIdx: 1, serviceIdx: 1, staffIdx: 1 },
    { dayOffset: -6, hour: 11, minute: 0, status: 'completed', contactIdx: 2, serviceIdx: 2, staffIdx: 2 },
    { dayOffset: -5, hour: 15, minute: 0, status: 'completed', contactIdx: 3, serviceIdx: 0, staffIdx: 3 },
    { dayOffset: -4, hour: 9, minute: 30, status: 'completed', contactIdx: 4, serviceIdx: 3, staffIdx: 0 },
    { dayOffset: -4, hour: 16, minute: 0, status: 'completed', contactIdx: 5, serviceIdx: 2, staffIdx: 1 },
    { dayOffset: -3, hour: 10, minute: 30, status: 'completed', contactIdx: 6, serviceIdx: 1, staffIdx: 2 },
    { dayOffset: -3, hour: 13, minute: 0, status: 'completed', contactIdx: 7, serviceIdx: 4, staffIdx: 3 },
    { dayOffset: -2, hour: 11, minute: 30, status: 'completed', contactIdx: 8, serviceIdx: 0, staffIdx: 0 },
    { dayOffset: -2, hour: 14, minute: 0, status: 'cancelled', contactIdx: 9, serviceIdx: 1, staffIdx: 1, note: 'Client cancelled due to travel' },
    { dayOffset: -1, hour: 9, minute: 0, status: 'completed', contactIdx: 10, serviceIdx: 5, staffIdx: 2 },
    { dayOffset: -1, hour: 15, minute: 30, status: 'completed', contactIdx: 11, serviceIdx: 2, staffIdx: 3 },

    // Today's Bookings
    { dayOffset: 0, hour: 9, minute: 30, status: 'completed', contactIdx: 12, serviceIdx: 0, staffIdx: 0 },
    { dayOffset: 0, hour: 11, minute: 0, status: 'confirmed', contactIdx: 13, serviceIdx: 1, staffIdx: 1 },
    { dayOffset: 0, hour: 14, minute: 0, status: 'confirmed', contactIdx: 14, serviceIdx: 6, staffIdx: 2 },
    { dayOffset: 0, hour: 16, minute: 30, status: 'confirmed', contactIdx: 15, serviceIdx: 2, staffIdx: 3 },

    // Upcoming Bookings (Confirmed / Pending)
    { dayOffset: 1, hour: 10, minute: 0, status: 'confirmed', contactIdx: 0, serviceIdx: 0, staffIdx: 0 },
    { dayOffset: 1, hour: 11, minute: 30, status: 'confirmed', contactIdx: 1, serviceIdx: 2, staffIdx: 1 },
    { dayOffset: 1, hour: 14, minute: 0, status: 'pending', contactIdx: 2, serviceIdx: 1, staffIdx: 2 },
    { dayOffset: 2, hour: 9, minute: 30, status: 'confirmed', contactIdx: 3, serviceIdx: 4, staffIdx: 3 },
    { dayOffset: 2, hour: 13, minute: 0, status: 'confirmed', contactIdx: 4, serviceIdx: 0, staffIdx: 0, changeReq: true, note: 'Customer requested to push back by 30 mins' },
    { dayOffset: 2, hour: 15, minute: 30, status: 'confirmed', contactIdx: 5, serviceIdx: 5, staffIdx: 1 },
    { dayOffset: 3, hour: 10, minute: 30, status: 'confirmed', contactIdx: 6, serviceIdx: 2, staffIdx: 2 },
    { dayOffset: 3, hour: 14, minute: 0, status: 'pending', contactIdx: 7, serviceIdx: 0, staffIdx: 3 },
    { dayOffset: 4, hour: 11, minute: 0, status: 'confirmed', contactIdx: 8, serviceIdx: 1, staffIdx: 0 },
    { dayOffset: 4, hour: 16, minute: 0, status: 'confirmed', contactIdx: 9, serviceIdx: 3, staffIdx: 1 },
    { dayOffset: 5, hour: 10, minute: 0, status: 'confirmed', contactIdx: 10, serviceIdx: 0, staffIdx: 2 },
    { dayOffset: 5, hour: 13, minute: 30, status: 'confirmed', contactIdx: 11, serviceIdx: 2, staffIdx: 3 },
    { dayOffset: 6, hour: 11, minute: 0, status: 'confirmed', contactIdx: 12, serviceIdx: 4, staffIdx: 0 },
    { dayOffset: 7, hour: 14, minute: 30, status: 'confirmed', contactIdx: 13, serviceIdx: 0, staffIdx: 1 },
    { dayOffset: 8, hour: 10, minute: 0, status: 'confirmed', contactIdx: 14, serviceIdx: 1, staffIdx: 2 },
    { dayOffset: 9, hour: 15, minute: 0, status: 'pending', contactIdx: 15, serviceIdx: 2, staffIdx: 3 },
    { dayOffset: 10, hour: 11, minute: 30, status: 'confirmed', contactIdx: 0, serviceIdx: 5, staffIdx: 0 },
    { dayOffset: 12, hour: 14, minute: 0, status: 'confirmed', contactIdx: 1, serviceIdx: 0, staffIdx: 1 },
  ];

  for (const cfg of bookingConfigs) {
    const bDate = new Date(now);
    bDate.setDate(bDate.getDate() + cfg.dayOffset);
    bDate.setHours(cfg.hour, cfg.minute, 0, 0);

    const contact = insertedContacts[cfg.contactIdx % insertedContacts.length];
    const service = insertedServices[cfg.serviceIdx % insertedServices.length];
    const staff = allStaff[cfg.staffIdx % allStaff.length];

    bookingRows.push({
      userId: USER_ID,
      workspaceId: WS_ID,
      description: cfg.note ?? `${service.name} booked for ${contact.name}`,
      scheduledAt: bDate,
      timezone: TIMEZONE,
      status: cfg.status,
      customerName: contact.name,
      phone: contact.phone,
      contactId: contact.id,
      staffId: staff.id,
      serviceId: service.id,
      durationMinutes: service.durationMinutes,
      noShowCount: cfg.noShow ?? 0,
      changeRequested: cfg.changeReq ?? false,
    });
  }

  const insertedBookings = await db.insert(bookings).values(bookingRows).returning();
  console.log(`✅ ${insertedBookings.length} Bookings created with full staff, service, and contact links.`);

  // 6. Unified Inbox (Conversations & Messages)
  const conv1 = await db
    .insert(conversations)
    .values({
      workspaceId: WS_ID,
      bookingId: insertedBookings[16]?.id ?? null,
      channelType: 'whatsapp',
      externalId: '61412345001',
      customerName: 'Oliver Smith',
      status: 'active',
      state: { step: 'idle' },
      lastMessageAt: new Date(Date.now() - 15 * 60000),
      unreadCount: 0,
    })
    .returning();

  await db.insert(messages).values([
    {
      conversationId: conv1[0].id,
      channelType: 'whatsapp',
      direction: 'outbound',
      providerMessageId: `msg_wa_01_${Date.now()}`,
      status: 'delivered',
      content: 'Hi Oliver! Reminder for your Classic Haircut tomorrow at 10:00 AM with Emma at Northsick Studio.',
      createdAt: new Date(Date.now() - 60 * 60000),
    },
    {
      conversationId: conv1[0].id,
      channelType: 'whatsapp',
      direction: 'inbound',
      providerMessageId: `msg_wa_02_${Date.now()}`,
      status: 'delivered',
      content: 'Awesome, thanks! See you tomorrow at 10.',
      createdAt: new Date(Date.now() - 15 * 60000),
    },
  ]);

  const conv2 = await db
    .insert(conversations)
    .values({
      workspaceId: WS_ID,
      bookingId: insertedBookings[17]?.id ?? null,
      channelType: 'telegram',
      externalId: 'tg_chat_882910',
      customerName: 'Jack Wilson',
      status: 'active',
      state: { needsAttention: true },
      lastMessageAt: new Date(Date.now() - 8 * 60000),
      unreadCount: 1,
    })
    .returning();

  await db.insert(messages).values([
    {
      conversationId: conv2[0].id,
      channelType: 'telegram',
      direction: 'inbound',
      providerMessageId: `msg_tg_01_${Date.now()}`,
      status: 'delivered',
      content: 'Hey there! Can I add a beard trim to my executive package tomorrow?',
      createdAt: new Date(Date.now() - 8 * 60000),
    },
  ]);

  const conv3 = await db
    .insert(conversations)
    .values({
      workspaceId: WS_ID,
      bookingId: insertedBookings[20]?.id ?? null,
      channelType: 'whatsapp',
      externalId: '61412345005',
      customerName: 'Noah Davies',
      status: 'waiting_input',
      state: { step: 'awaiting-time', originalTime: '13:00' },
      lastMessageAt: new Date(Date.now() - 25 * 60000),
      unreadCount: 0,
    })
    .returning();

  await db.insert(messages).values([
    {
      conversationId: conv3[0].id,
      channelType: 'whatsapp',
      direction: 'inbound',
      providerMessageId: `msg_wa_03_${Date.now()}`,
      status: 'delivered',
      content: 'Hi! Could I reschedule my appointment on Thursday to 13:30?',
      createdAt: new Date(Date.now() - 30 * 60000),
    },
    {
      conversationId: conv3[0].id,
      channelType: 'whatsapp',
      direction: 'outbound',
      providerMessageId: `msg_wa_04_${Date.now()}`,
      status: 'delivered',
      content: 'Sure Noah! Emma has an opening at 13:30. Reply YES to confirm the change.',
      createdAt: new Date(Date.now() - 25 * 60000),
    },
  ]);

  console.log('✅ 3 Unified Inbox Conversations & message threads created.');

  // 7. Waitlist Entries
  await db.insert(waitlistEntries).values([
    {
      workspaceId: WS_ID,
      serviceId: insertedServices[0].id,
      staffId: allStaff[1].id,
      customerName: 'Thomas Taylor',
      contactPhone: '+61412345004',
      channelType: 'whatsapp',
      preferredDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      timePreference: 'After 3pm',
      status: 'waiting',
    },
    {
      workspaceId: WS_ID,
      serviceId: insertedServices[2].id,
      staffId: allStaff[0].id,
      customerName: 'Alexander Roberts',
      contactPhone: '+61412345008',
      channelType: 'telegram',
      preferredDate: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10),
      timePreference: 'Friday afternoon 5pm',
      status: 'waiting',
    },
  ]);
  console.log('✅ 2 Waitlist entries created.');

  console.log('🎉 Population data dummy untuk "Northsick Studio" selesai dengan sukses!');
}

seed().catch((err) => {
  console.error('❌ Error during seeding:', err);
  process.exit(1);
});
