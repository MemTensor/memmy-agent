import type { ReactNode, SVGProps } from "react";

export interface MemoryIconProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  size?: number;
}

interface IconShellProps extends MemoryIconProps {
  name: string;
  children: ReactNode;
}

function IconShell(props: IconShellProps) {
  const { name, size = 24, className, children, ...svgProps } = props;

  return (
    <svg
      {...svgProps}
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={props["aria-label"] ? undefined : true}
    >
      {children}
    </svg>
  );
}

export function Layers(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="layers">
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </IconShell>
  );
}

export function BrainCircuit(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="brain-circuit">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M9 13a4.5 4.5 0 0 0 3-4" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M12 13h4" />
      <path d="M12 18h6a2 2 0 0 1 2 2v1" />
      <path d="M12 8h8" />
      <path d="M16 8V5a2 2 0 0 1 2-2" />
      <circle cx="16" cy="13" r="0.5" />
      <circle cx="18" cy="3" r="0.5" />
      <circle cx="20" cy="21" r="0.5" />
      <circle cx="20" cy="8" r="0.5" />
    </IconShell>
  );
}

export function ListChecks(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="list-checks">
      <path d="m3 6 1.5 1.5L8 4" />
      <path d="M11 6h10" />
      <path d="m3 12 1.5 1.5L8 10" />
      <path d="M11 12h10" />
      <path d="m3 18 1.5 1.5L8 16" />
      <path d="M11 18h10" />
    </IconShell>
  );
}

export function Sparkles(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="sparkles">
      <path d="M12 3 10.4 8.4 5 10l5.4 1.6L12 17l1.6-5.4L19 10l-5.4-1.6L12 3Z" />
      <path d="M5 3v4" />
      <path d="M3 5h4" />
      <path d="M19 17v4" />
      <path d="M17 19h4" />
    </IconShell>
  );
}

export function Globe2(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="globe-2">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </IconShell>
  );
}

export function Wand2(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="wand-2">
      <path d="m15 4 5 5" />
      <path d="m14 10 6-6" />
      <path d="M4 20 15 9" />
      <path d="M5 6v4" />
      <path d="M3 8h4" />
      <path d="M19 14v4" />
      <path d="M17 16h4" />
    </IconShell>
  );
}

export function BarChart3(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="bar-chart-3">
      <path d="M3 3v18h18" />
      <path d="M8 17V9" />
      <path d="M13 17V5" />
      <path d="M18 17v-6" />
    </IconShell>
  );
}

export function ScrollText(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="scroll-text">
      <path d="M8 21h9a3 3 0 0 0 3-3V5a2 2 0 0 0-2-2H7" />
      <path d="M10 17H6a3 3 0 1 0 0 6h2" />
      <path d="M6 17V5a2 2 0 1 1 4 0v12" />
      <path d="M13 8h4" />
      <path d="M13 12h4" />
    </IconShell>
  );
}

export function Settings2(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="settings-2">
      <path d="M20 7h-9" />
      <path d="M14 17H4" />
      <circle cx="7" cy="7" r="3" />
      <circle cx="17" cy="17" r="3" />
    </IconShell>
  );
}

export function Link2(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="link-2">
      <path d="M9 17H7a5 5 0 0 1 0-10h2" />
      <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
      <path d="M8 12h8" />
    </IconShell>
  );
}

export function MessageSquarePlus(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="message-square-plus">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
      <path d="M12 7v6" />
      <path d="M9 10h6" />
    </IconShell>
  );
}

export function LayoutList(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="layout-list">
      <rect x="3" y="5" width="6" height="5" rx="1" />
      <path d="M13 7.5h8" />
      <rect x="3" y="14" width="6" height="5" rx="1" />
      <path d="M13 16.5h8" />
    </IconShell>
  );
}

export function PanelLeft(props: MemoryIconProps) {
  const { size = 20, className, ...svgProps } = props;

  return (
    <svg
      {...svgProps}
      data-icon="panel-left"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      className={className}
      aria-hidden={props["aria-label"] ? undefined : true}
    >
      <path
        fill="currentColor"
        d="M16.835 8.66301C16.835 7.71885 16.8347 7.05065 16.792 6.52824C16.7605 6.14232 16.7073 5.86904 16.6299 5.65227L16.5439 5.45207C16.32 5.01264 15.9796 4.64498 15.5615 4.3886L15.3779 4.28606C15.1308 4.16013 14.8165 4.08006 14.3018 4.03801C13.7794 3.99533 13.1112 3.99504 12.167 3.99504H7.83301C6.88885 3.99504 6.22065 3.99533 5.69824 4.03801C5.31232 4.06954 5.03904 4.12266 4.82227 4.20012L4.62207 4.28606C4.18264 4.50996 3.81498 4.85035 3.55859 5.26848L3.45605 5.45207C3.33013 5.69922 3.25006 6.01354 3.20801 6.52824C3.16533 7.05065 3.16504 7.71885 3.16504 8.66301V11.3271C3.16504 12.2712 3.16533 12.9394 3.20801 13.4618C3.25006 13.9766 3.33013 14.2909 3.45605 14.538L3.55859 14.7216C3.81498 15.1397 4.18266 15.4801 4.62207 15.704L4.82227 15.79C5.03904 15.8674 5.31234 15.9205 5.69824 15.9521C6.22065 15.9947 6.88885 15.995 7.83301 15.995H12.167C13.1112 15.995 13.7794 15.9947 14.3018 15.9521C14.8164 15.91 15.1308 15.8299 15.3779 15.704L15.5615 15.6015C15.9797 15.3451 16.32 14.9774 16.5439 14.538L16.6299 14.3378C16.7074 14.121 16.7605 13.8478 16.792 13.4618C16.8347 12.9394 16.835 12.2712 16.835 11.3271V8.66301ZM5.00195 13.3329V6.66692C5.00195 6.29965 5.29972 6.00188 5.66699 6.00188C6.03412 6.00204 6.33203 6.29975 6.33203 6.66692V13.3329C6.33203 13.7001 6.03412 13.9978 5.66699 13.998C5.29972 13.998 5.00195 13.7002 5.00195 13.3329ZM18.165 11.3271C18.165 12.2493 18.1653 12.9811 18.1172 13.5702C18.0745 14.0924 17.9916 14.5472 17.8125 14.9648L17.7295 15.1415C17.394 15.8 16.8834 16.3511 16.2568 16.7353L15.9814 16.8896C15.5157 17.1268 15.0069 17.2285 14.4102 17.2773C13.821 17.3254 13.0893 17.3251 12.167 17.3251H7.83301C6.91071 17.3251 6.17898 17.3254 5.58984 17.2773C5.06757 17.2346 4.61294 17.1508 4.19531 16.9716L4.01855 16.8896C3.36014 16.5541 2.80898 16.0434 2.4248 15.4169L2.27051 15.1415C2.03328 14.6758 1.93158 14.167 1.88281 13.5702C1.83468 12.9811 1.83496 12.2493 1.83496 11.3271V8.66301C1.83496 7.74072 1.83468 7.00898 1.88281 6.41985C1.93157 5.82309 2.03329 5.31432 2.27051 4.84856L2.4248 4.57317C2.80898 3.94666 3.36012 3.436 4.01855 3.10051L4.19531 3.0175C4.61285 2.83843 5.06771 2.75548 5.58984 2.71281C6.17898 2.66468 6.91071 2.66496 7.83301 2.66496H12.167C13.0893 2.66496 13.821 2.66468 14.4102 2.71281C15.0069 2.76157 15.5157 2.86329 15.9814 3.10051L16.2568 3.25481C16.8833 3.63898 17.394 4.19012 17.7295 4.84856L17.8125 5.02531C17.9916 5.44285 18.0745 5.89771 18.1172 6.41985C18.1653 7.00898 18.165 7.74072 18.165 8.66301V11.3271Z"
      />
    </svg>
  );
}

export function PanelLeftCollapsed(props: MemoryIconProps) {
  const { size = 20, className, ...svgProps } = props;

  return (
    <svg
      {...svgProps}
      data-icon="panel-left-collapsed"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      className={className}
      aria-hidden={props["aria-label"] ? undefined : true}
    >
      <path
        fill="currentColor"
        d="M6.83496 3.99992C6.38353 4.00411 6.01421 4.0122 5.69824 4.03801C5.31232 4.06954 5.03904 4.12266 4.82227 4.20012L4.62207 4.28606C4.18264 4.50996 3.81498 4.85035 3.55859 5.26848L3.45605 5.45207C3.33013 5.69922 3.25006 6.01354 3.20801 6.52824C3.16533 7.05065 3.16504 7.71885 3.16504 8.66301V11.3271C3.16504 12.2712 3.16533 12.9394 3.20801 13.4618C3.25006 13.9766 3.33013 14.2909 3.45605 14.538L3.55859 14.7216C3.81498 15.1397 4.18266 15.4801 4.62207 15.704L4.82227 15.79C5.03904 15.8674 5.31234 15.9205 5.69824 15.9521C6.01398 15.9779 6.383 15.986 6.83398 15.9902L6.83496 3.99992ZM18.165 11.3271C18.165 12.2493 18.1653 12.9811 18.1172 13.5702C18.0745 14.0924 17.9916 14.5472 17.8125 14.9648L17.7295 15.1415C17.394 15.8 16.8834 16.3511 16.2568 16.7353L15.9814 16.8896C15.5157 17.1268 15.0069 17.2285 14.4102 17.2773C13.821 17.3254 13.0893 17.3251 12.167 17.3251H7.83301C6.91071 17.3251 6.17898 17.3254 5.58984 17.2773C5.06757 17.2346 4.61294 17.1508 4.19531 16.9716L4.01855 16.8896C3.36014 16.5541 2.80898 16.0434 2.4248 15.4169L2.27051 15.1415C2.03328 14.6758 1.93158 14.167 1.88281 13.5702C1.83468 12.9811 1.83496 12.2493 1.83496 11.3271V8.66301C1.83496 7.74072 1.83468 7.00898 1.88281 6.41985C1.93157 5.82309 2.03329 5.31432 2.27051 4.84856L2.42480 4.57317C2.80898 3.94666 3.36012 3.436 4.01855 3.10051L4.19531 3.0175C4.61285 2.83843 5.06771 2.75548 5.58984 2.71281C6.17898 2.66468 6.91071 2.66496 7.83301 2.66496H12.167C13.0893 2.66496 13.821 2.66468 14.4102 2.71281C15.0069 2.76157 15.5157 2.86329 15.9814 3.10051L16.2568 3.25481C16.8833 3.63898 17.394 4.19012 17.7295 4.84856L17.8125 5.02531C17.9916 5.44285 18.0745 5.89771 18.1172 6.41985C18.1653 7.00898 18.165 7.74072 18.165 8.66301V11.3271ZM8.16406 15.995H12.167C13.1112 15.995 13.7794 15.9947 14.3018 15.9521C14.8164 15.91 15.1308 15.8299 15.3779 15.704L15.5615 15.6015C15.9797 15.3451 16.32 14.9774 16.5439 14.538L16.6299 14.3378C16.7074 14.121 16.7605 13.8478 16.792 13.4618C16.8347 12.9394 16.835 12.2712 16.835 11.3271V8.66301C16.835 7.71885 16.8347 7.05065 16.792 6.52824C16.7605 6.14232 16.7073 5.86904 16.6299 5.65227L16.5439 5.45207C16.32 5.01264 15.9796 4.64498 15.5615 4.3886L15.3779 4.28606C15.1308 4.16013 14.8165 4.08006 14.3018 4.03801C13.7794 3.99533 13.1112 3.99504 12.167 3.99504H8.16406C8.16407 3.99667 8.16504 3.99829 8.16504 3.99992L8.16406 15.995Z"
      />
    </svg>
  );
}

export function ArrowLeft(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="arrow-left">
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </IconShell>
  );
}

export function Pin(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="pin">
      <path d="M12 17v5" />
      <path d="M8 3h8l-1 8 4 4H5l4-4Z" />
    </IconShell>
  );
}

export function MoreHorizontal(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="more-horizontal">
      <circle cx="6" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="18" cy="12" r="1.5" />
    </IconShell>
  );
}

export function User(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="user">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </IconShell>
  );
}

export function MessageCircle(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="message-circle">
      <path d="M21 11.5a8.5 8.5 0 0 1-12.7 7.4L3 21l2.1-5.1A8.5 8.5 0 1 1 21 11.5Z" />
    </IconShell>
  );
}

export function Search(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="search">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </IconShell>
  );
}

export function ChevronRight(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="chevron-right">
      <path d="m9 18 6-6-6-6" />
    </IconShell>
  );
}

export function ChevronLeft(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="chevron-left">
      <path d="m15 18-6-6 6-6" />
    </IconShell>
  );
}

export function Radar(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="radar">
      <path d="M19 11a7 7 0 1 1-6-6" />
      <path d="M12 12 21 3" />
      <path d="M16 8a4 4 0 1 1-5-1" />
      <circle cx="12" cy="12" r="1" />
    </IconShell>
  );
}

export function Plus(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="plus">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </IconShell>
  );
}

export function X(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="x">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </IconShell>
  );
}

export function Terminal(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="terminal">
      <path d="m4 17 5-5-5-5" />
      <path d="M12 19h8" />
    </IconShell>
  );
}

export function Server(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="server">
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 8h.01" />
      <path d="M7 17h.01" />
    </IconShell>
  );
}

export function Info(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="info">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </IconShell>
  );
}

export function RefreshCw(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="refresh-cw">
      <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
      <path d="M3 21v-5h5" />
      <path d="M3 12A9 9 0 0 1 18.3 5.6L21 8" />
      <path d="M21 3v5h-5" />
    </IconShell>
  );
}

export function Trash2(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="trash-2">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6 18 20H6L5 6" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </IconShell>
  );
}

export function Archive(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="archive">
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </IconShell>
  );
}

export function Download(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="download">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </IconShell>
  );
}

export function Plug(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="plug">
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M6 8h12v4a6 6 0 0 1-12 0V8Z" />
    </IconShell>
  );
}

export function FolderOpen(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="folder-open">
      <path d="M3 7h6l2 2h10v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7Z" />
      <path d="M3 13h18" />
    </IconShell>
  );
}

export function FolderSearch(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="folder-search">
      <path d="M3 7h6l2 2h10v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7Z" />
      <circle cx="11" cy="14" r="2.5" />
      <path d="m13 16 2 2" />
    </IconShell>
  );
}

export function CheckCircle2(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="check-circle-2">
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" />
    </IconShell>
  );
}

export function AlertCircle(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="alert-circle">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </IconShell>
  );
}

export function AlertTriangle(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="alert-triangle">
      <path d="M10.3 4.5 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.5a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </IconShell>
  );
}

export function Loader2(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="loader-2">
      <path d="M21 12a9 9 0 0 1-9 9" />
      <path d="M3 12a9 9 0 0 1 9-9" />
    </IconShell>
  );
}

export function Send(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="send">
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
      <path d="M22 2 11 13" />
    </IconShell>
  );
}

export function Mic(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="mic">
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 11a7 7 0 0 1-14 0" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </IconShell>
  );
}

export function Pause(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="pause">
      <path d="M8 5v14" />
      <path d="M16 5v14" />
    </IconShell>
  );
}

export function StopSquare(props: MemoryIconProps) {
  const { size = 24, className, ...svgProps } = props;

  return (
    <svg
      {...svgProps}
      data-icon="stop-square"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden={props["aria-label"] ? undefined : true}
    >
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </svg>
  );
}

export function Play(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="play">
      <path d="m8 5 11 7-11 7V5Z" />
    </IconShell>
  );
}

export function Maximize(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="maximize">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    </IconShell>
  );
}

export function Maximize2(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="maximize-2">
      <path d="M15 3h6v6" />
      <path d="m21 3-7 7" />
      <path d="M9 21H3v-6" />
      <path d="m3 21 7-7" />
    </IconShell>
  );
}

export function ImagePlus(props: MemoryIconProps) {
  return (
    <IconShell {...props} name="image-plus">
      <path d="M16 5h6" />
      <path d="M19 2v6" />
      <path d="M21 12v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
      <path d="m3 16 4-4 4 4 3-3 5 5" />
      <circle cx="8" cy="9" r="1.5" />
    </IconShell>
  );
}
