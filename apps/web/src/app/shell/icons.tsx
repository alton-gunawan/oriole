import type { SVGProps } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Battery,
  Bell,
  Bookmark,
  Calendar,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock,
  Copy,
  CreditCard,
  ExternalLink,
  Filter,
  Folder,
  Globe,
  House,
  Hourglass,
  IdCard,
  List,

  LogOut,
  Mail,
  Menu,
  MessageSquare,
  MicOff,
  MoreHorizontal,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Phone,
  Plug,
  Plus,
  Receipt,
  RefreshCw,
  Repeat,
  RotateCcw,
  Search,
  SearchX,
  Send,
  Shield,
  Signal,
  SlidersVertical,
  Tags,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  Users,
  EyeOff,
  Video,
  Webhook,
  Wifi,
  X,
} from 'lucide-react';

/** Prop tipe ikon — tetap SVGProps agar konsumen (ui.tsx, dll.) tidak berubah. */
export type IconProps = SVGProps<SVGSVGElement>;

/*
 * Ikon di-re-export dari lucide-react (ISC) di balik nama Icon* yang lama
 * supaya seluruh halaman tetap berfungsi tanpa perubahan import.
 * Nama memakai varian kanonik Lucide (bukan alias lama yang deprecated):
 *   IconChart  → ChartColumn   (dulu BarChart3)
 *   IconHelp   → CircleHelp    (dulu HelpCircle)
 *   IconEdit   → Pencil        (dulu Edit)
 *   IconAlertTriangle → TriangleAlert (dulu AlertTriangle)
 *   IconSettings → SlidersVertical    (slider vertikal, bukan gerigi)
 *   IconRefresh → RotateCcw           (panah refresh kiri)
 *   IconStaff  → IdCard               (kartu + orang + baris teks)
 */

// Dashboard memakai glyph Phosphor "house-line" (bukan Lucide House) —
// dipakai di sidebar nav dan header halaman dashboard.
export const IconDashboard = IconHouseLine;
export const IconHome = House;
export const IconCalendar = Calendar;
export const IconStaff = IdCard;
export const IconServices = Tags;
export const IconUsers = Users;
export const IconChart = ChartColumn;
export const IconSettings = SlidersVertical;
export const IconHelp = CircleHelp;
export const IconUser = User;
export const IconLogout = LogOut;
export const IconMenu = Menu;
export const IconList = List;
export const IconX = X;
export const IconPhone = Phone;
export const IconArrowLeft = ArrowLeft;
export const IconArrowRight = ArrowRight;
export const IconArrowUpRight = ArrowUpRight;
export const IconCheck = Check;
export const IconPlus = Plus;
export const IconSearch = Search;
export const IconFolder = Folder;
export const IconFilter = Filter;
export const IconBell = Bell;
export const IconChevronDown = ChevronDown;
export const IconChevronLeft = ChevronLeft;
export const IconChevronRight = ChevronRight;
export const IconMail = Mail;
export const IconShield = Shield;
export const IconCreditCard = CreditCard;
export const IconClock = Clock;
export const IconHourglass = Hourglass;
export const IconSearchX = SearchX;
export const IconEyeOff = EyeOff;
export const IconAlertTriangle = TriangleAlert;
export const IconRefreshCw = RefreshCw;
export const IconEdit = Pencil;
export const IconTrash = Trash2;
export const IconChat = MessageSquare;
export const IconSend = Send;
export const IconCopy = Copy;
export const IconPlug = Plug;
export const IconRepeat = Repeat;
export const IconRefresh = RotateCcw;
export const IconWebhook = Webhook;
export const IconUpload = Upload;
export const IconDotsVertical = MoreVertical;
export const IconDotsHorizontal = MoreHorizontal;
export const IconPanelLeftClose = PanelLeftClose;
export const IconPanelLeftOpen = PanelLeftOpen;
export const IconBookmark = Bookmark;
export const IconReceipt = Receipt;
export const IconGlobe = Globe;
export const IconVideo = Video;
export const IconMicOff = MicOff;
export const IconSignal = Signal;
export const IconWifi = Wifi;
export const IconBattery = Battery;
export const IconExternalLink = ExternalLink;

/* ── Ikon brand (Obsidian, Notion) — tidak ada padanan di Lucide ── */

function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconObsidian(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 3h7l4 4v11a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V3z" />
      <path d="M14 3v4h4" />
      <path d="M10 11h4M10 14.5h4M10 18h2" />
    </Svg>
  );
}

export function IconNotion(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M9.2 16.5V7.5l5.6 9V7.5" />
    </Svg>
  );
}

/* ── Ikon Phosphor (MIT, phosphoricons.com) — dipakai bila glyph Lucide
   kurang pas; path resmi dari repo phosphor-icons/core (regular weight). ── */

export function IconHouseLine(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M240,208H224V136l2.34,2.34A8,8,0,0,0,237.66,127L139.31,28.68a16,16,0,0,0-22.62,0L18.34,127a8,8,0,0,0,11.32,11.31L32,136v72H16a8,8,0,0,0,0,16H240a8,8,0,0,0,0-16ZM48,120l80-80,80,80v88H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48Zm96,88H112V160h32Z" />
    </svg>
  );
}

/* ── Ikon merek channel — SVG resmi dari svgl.app (warna merek asli). ── */

export function IconTelegram(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" preserveAspectRatio="xMidYMid" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id="svgl-telegram-grad" x1="50%" x2="50%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#2AABEE" />
          <stop offset="100%" stopColor="#229ED9" />
        </linearGradient>
      </defs>
      <path fill="url(#svgl-telegram-grad)" d="M128 0C94.06 0 61.48 13.494 37.5 37.49A128.038 128.038 0 0 0 0 128c0 33.934 13.5 66.514 37.5 90.51C61.48 242.506 94.06 256 128 256s66.52-13.494 90.5-37.49c24-23.996 37.5-56.576 37.5-90.51 0-33.934-13.5-66.514-37.5-90.51C194.52 13.494 161.94 0 128 0Z" />
      <path fill="#FFF" d="M57.94 126.648c37.32-16.256 62.2-26.974 74.64-32.152 35.56-14.786 42.94-17.354 47.76-17.441 1.06-.017 3.42.245 4.96 1.49 1.28 1.05 1.64 2.47 1.82 3.467.16.996.38 3.266.2 5.038-1.92 20.24-10.26 69.356-14.5 92.026-1.78 9.592-5.32 12.808-8.74 13.122-7.44.684-13.08-4.912-20.28-9.63-11.26-7.386-17.62-11.982-28.56-19.188-12.64-8.328-4.44-12.906 2.76-20.386 1.88-1.958 34.64-31.748 35.26-34.45.08-.338.16-1.598-.6-2.262-.74-.666-1.84-.438-2.64-.258-1.14.256-19.12 12.152-54 35.686-5.1 3.508-9.72 5.218-13.88 5.128-4.56-.098-13.36-2.584-19.9-4.708-8-2.606-14.38-3.984-13.82-8.41.28-2.304 3.46-4.662 9.52-7.072Z" />
    </svg>
  );
}

export function IconWhatsApp(props: IconProps) {
  return (
    <svg viewBox="0 0 360 362" fill="none" aria-hidden="true" {...props}>
      <path
        fill="#25D366"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M307.546 52.566C273.709 18.684 228.706.017 180.756 0 81.951 0 1.538 80.404 1.504 179.235c-.017 31.594 8.242 62.432 23.928 89.609L0 361.736l95.024-24.925c26.179 14.285 55.659 21.805 85.655 21.814h.077c98.788 0 179.21-80.413 179.244-179.244.017-47.898-18.608-92.926-52.454-126.807v-.008Zm-126.79 275.788h-.06c-26.73-.008-52.952-7.194-75.831-20.765l-5.44-3.231-56.391 14.791 15.05-54.981-3.542-5.638c-14.912-23.721-22.793-51.139-22.776-79.286.035-82.14 66.867-148.973 149.051-148.973 39.793.017 77.198 15.53 105.328 43.695 28.131 28.157 43.61 65.596 43.593 105.398-.035 82.149-66.867 148.982-148.982 148.982v.008Zm81.719-111.577c-4.478-2.243-26.497-13.073-30.606-14.568-4.108-1.496-7.09-2.243-10.073 2.243-2.982 4.487-11.568 14.577-14.181 17.559-2.613 2.991-5.226 3.361-9.704 1.117-4.477-2.243-18.908-6.97-36.02-22.226-13.313-11.878-22.304-26.54-24.916-31.027-2.613-4.486-.275-6.91 1.959-9.136 2.011-2.011 4.478-5.234 6.721-7.847 2.244-2.613 2.983-4.486 4.478-7.469 1.496-2.991.748-5.603-.369-7.847-1.118-2.243-10.073-24.289-13.812-33.253-3.636-8.732-7.331-7.546-10.073-7.692-2.613-.13-5.595-.155-8.586-.155-2.991 0-7.839 1.118-11.947 5.604-4.108 4.486-15.677 15.324-15.677 37.361s16.047 43.344 18.29 46.335c2.243 2.991 31.585 48.225 76.51 67.632 10.684 4.615 19.029 7.374 25.535 9.437 10.727 3.412 20.49 2.931 28.208 1.779 8.604-1.289 26.498-10.838 30.228-21.298 3.73-10.46 3.73-19.433 2.613-21.298-1.117-1.865-4.108-2.991-8.586-5.234l.008-.017Z"
      />
    </svg>
  );
}

export function IconGmail(props: IconProps) {
  return (
    <svg viewBox="0 49.4 512 399.42" aria-hidden="true" {...props}>
      <g fill="none" fillRule="evenodd">
        <g fillRule="nonzero">
          <path fill="#4285f4" d="M34.91 448.818h81.454V251L0 163.727V413.91c0 19.287 15.622 34.91 34.91 34.91z" />
          <path fill="#34a853" d="M395.636 448.818h81.455c19.287 0 34.909-15.622 34.909-34.909V163.727L395.636 251z" />
          <path fill="#fbbc04" d="M395.636 99.727V251L512 163.727v-46.545c0-43.142-49.25-67.782-83.782-41.891z" />
        </g>
        <path fill="#ea4335" d="M116.364 251V99.727L256 204.455 395.636 99.727V251L256 355.727z" />
        <path fill="#c5221f" fillRule="nonzero" d="M0 117.182v46.545L116.364 251V99.727L83.782 75.291C49.25 49.4 0 74.04 0 117.18z" />
      </g>
    </svg>
  );
}
