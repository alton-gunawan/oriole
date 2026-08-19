import type { SVGProps } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Battery,
  Bell,
  Bookmark,
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
  Info,
  List,

  LogOut,
  Mail,
  Menu,
  MicOff,
  Monitor,
  Moon,
  MoreHorizontal,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
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
  Sun,
  SunMoon,
  Trash2,
  TriangleAlert,
  Upload,
  User,
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

// Ikon sidebar & header memakai glyph Phosphor (phosphoricons.com, regular weight)
export const IconDashboard = IconHouseLine;
export const IconCalendarCheck = IconCalendarCheckPhosphor;
export const IconCalendar = IconCalendarBlank;
export const IconStaff = IconIdentificationCard;
export const IconServices = IconTagPhosphor;
export const IconUsers = IconUsersPhosphor;
export const IconChat = IconChats;
export const IconPhone = IconPhonePhosphor;
export const IconPlug = IconPlugPhosphor;
export const IconHome = House;
export const IconChart = ChartColumn;
export const IconSettings = SlidersVertical;
export const IconHelp = CircleHelp;
export const IconInfo = Info;
export const IconUser = User;
export const IconLogout = LogOut;
export const IconMenu = Menu;
export const IconList = List;
export const IconX = X;
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
export const IconSend = Send;
export const IconCopy = Copy;
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
export const IconSun = Sun;
export const IconSunMoon = SunMoon;
export const IconMoon = Moon;
export const IconMonitor = Monitor;
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

export function IconSquaresFour(props: IconProps) {
  return (
    <svg
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth="16"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="48" y="48" width="64" height="64" rx="10" />
      <rect x="144" y="48" width="64" height="64" rx="10" />
      <rect x="48" y="144" width="64" height="64" rx="10" />
      <rect x="144" y="144" width="64" height="64" rx="10" />
    </svg>
  );
}

export function IconPhonePhosphor(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M222.37,158.46l-48-24A16,16,0,0,0,155.8,138l-19.16,24c-22.39-11.45-43.23-32.28-54.68-54.67L106,88.19A16,16,0,0,0,109.53,69.6l-24-48A16,16,0,0,0,67.38,13.23L23.1,28.2A16,16,0,0,0,12,43.28C12,149.6,98.4,236,204.72,236a16,16,0,0,0,15.08-11.1l14.97-44.28A16,16,0,0,0,222.37,158.46ZM204.72,220C107.27,220,28,140.73,28,43.28L72.28,28.31,96.28,76.31,73.8,94.3a8,8,0,0,0-2,9.39c14,27.53,38.77,52.3,66.3,66.3a8,8,0,0,0,9.39-2l18-22.48,48,24Z" />
    </svg>
  );
}

export function IconNotePencil(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M227.31,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96A16,16,0,0,0,227.31,73.37ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.69,147.31,64l24-24L216,84.69Z" />
    </svg>
  );
}

export function IconCalendarCheckPhosphor(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Zm-38.34-85.66a8,8,0,0,1,0,11.32l-48,48a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L116,164.69l42.34-42.35A8,8,0,0,1,169.66,122.34Z" />
    </svg>
  );
}

export function IconCalendarBlank(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Z" />
    </svg>
  );
}

export function IconUsersPhosphor(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M117.25,157.92a60,60,0,1,0-66.5,0A95.83,95.83,0,0,0,3.53,195.63a8,8,0,1,0,13.4,8.74,80,80,0,0,1,134.14,0,8,8,0,0,0,13.4-8.74A95.83,95.83,0,0,0,117.25,157.92ZM40,108a44,44,0,1,1,44,44A44.05,44.05,0,0,1,40,108Zm210.14,98.7a8,8,0,0,1-11.07-2.33A79.83,79.83,0,0,0,172,168a8,8,0,0,1,0-16,44,44,0,1,0-16.34-84.87,8,8,0,1,1-5.94-14.85,60,60,0,0,1,55.53,105.64,95.83,95.83,0,0,1,47.22,37.71A8,8,0,0,1,250.14,206.7Z" />
    </svg>
  );
}

export function IconTagPhosphor(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M243.31,136,144,36.69A15.86,15.86,0,0,0,132.69,32H40a8,8,0,0,0-8,8v92.69A15.86,15.86,0,0,0,36.69,144L136,243.31a16,16,0,0,0,22.63,0l84.68-84.68a16,16,0,0,0,0-22.63Zm-96,96L48,132.69V48h84.69L232,147.31ZM96,84A12,12,0,1,1,84,72,12,12,0,0,1,96,84Z" />
    </svg>
  );
}

export function IconIdentificationCard(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M200,112a8,8,0,0,1-8,8H152a8,8,0,0,1,0-16h40A8,8,0,0,1,200,112Zm-8,24H152a8,8,0,0,0,0,16h40a8,8,0,0,0,0-16Zm40-80V200a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V56A16,16,0,0,1,40,40H216A16,16,0,0,1,232,56ZM216,200V56H40V200H216Zm-80.26-34a8,8,0,1,1-15.5,4c-2.63-10.26-13.06-18-24.25-18s-21.61,7.74-24.25,18a8,8,0,1,1-15.5-4,39.84,39.84,0,0,1,17.19-23.34,32,32,0,1,1,45.12,0A39.76,39.76,0,0,1,135.75,166ZM96,136a16,16,0,1,0-16-16A16,16,0,0,0,96,136Z" />
    </svg>
  );
}

export function IconChats(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M216,80H184V48a16,16,0,0,0-16-16H40A16,16,0,0,0,24,48V176a8,8,0,0,0,13,6.22L72,154V184a16,16,0,0,0,16,16h93.59L219,230.22a8,8,0,0,0,5,1.78,8,8,0,0,0,8-8V96A16,16,0,0,0,216,80ZM66.55,137.78,40,159.25V48H168v88H71.58A8,8,0,0,0,66.55,137.78ZM216,207.25l-26.55-21.47a8,8,0,0,0-5-1.78H88V152h80a16,16,0,0,0,16-16V96h32Z" />
    </svg>
  );
}

export function IconPlugPhosphor(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M237.66,66.34a8,8,0,0,0-11.32,0L192,100.69,155.31,64l34.35-34.34a8,8,0,1,0-11.32-11.32L144,52.69,117.66,26.34a8,8,0,0,0-11.32,11.32L112.69,44l-53,53a40,40,0,0,0,0,56.57l15.71,15.71L26.34,218.34a8,8,0,0,0,11.32,11.32l49.09-49.09,15.71,15.71a40,40,0,0,0,56.57,0l53-53,6.34,6.35a8,8,0,0,0,11.32-11.32L203.31,112l34.35-34.34A8,8,0,0,0,237.66,66.34ZM147.72,185a24,24,0,0,1-33.95,0L71,142.23a24,24,0,0,1,0-33.95l53-53L200.69,132Z" />
    </svg>
  );
}

export function IconBuildings(props: IconProps) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M240,208H224V96a16,16,0,0,0-16-16H144V32a16,16,0,0,0-24.88-13.32L39.12,72A16,16,0,0,0,32,85.34V208H16a8,8,0,0,0,0,16H240a8,8,0,0,0,0-16ZM208,96V208H144V96ZM48,85.34,128,32V208H48ZM112,112v16a8,8,0,0,1-16,0V112a8,8,0,1,1,16,0Zm-32,0v16a8,8,0,0,1-16,0V112a8,8,0,1,1,16,0Zm0,56v16a8,8,0,0,1-16,0V168a8,8,0,0,1,16,0Zm32,0v16a8,8,0,0,1-16,0V168a8,8,0,0,1,16,0Z" />
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
