import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "arrow-up-right"
  | "board"
  | "bot"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "circle"
  | "code"
  | "command"
  | "git-branch"
  | "github"
  | "grid"
  | "inbox"
  | "layers"
  | "link"
  | "loader"
  | "pause"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "spark"
  | "stop"
  | "terminal"
  | "user"
  | "x";

export function Icon({ name, size = 18, strokeWidth = 1.8, ...props }: { name: IconName; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...props };
  switch (name) {
    case "activity": return <svg {...common}><path d="M3 12h4l2-7 4 14 2-7h6" /></svg>;
    case "arrow-up-right": return <svg {...common}><path d="M7 17 17 7M7 7h10v10" /></svg>;
    case "board": return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 8v8M12 8v4M16 8v6" /></svg>;
    case "bot": return <svg {...common}><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 4v4M8 13h.01M16 13h.01M9 16h6" /><path d="M3 12h2M19 12h2" /></svg>;
    case "check": return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case "chevron-down": return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
    case "chevron-right": return <svg {...common}><path d="m9 18 6-6-6-6" /></svg>;
    case "circle": return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
    case "code": return <svg {...common}><path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 6l-4 12" /></svg>;
    case "command": return <svg {...common}><path d="M18 9V6a3 3 0 1 0-3 3h3v6a3 3 0 1 1-3 3h-3v-3a3 3 0 1 1-3 3H6a3 3 0 1 1 3-3V9H6a3 3 0 1 1 3-3v3h6" /></svg>;
    case "git-branch": return <svg {...common}><path d="M6 3v12a3 3 0 1 0 3 3h6a3 3 0 1 0 3-3V9a3 3 0 1 0-3-3H9a3 3 0 1 0-3 3" /><path d="M9 9h6" /></svg>;
    case "github": return <svg {...common}><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.1.1 15 2.1a13.4 13.4 0 0 0-6 0C5.9.1 4.7.5 4.7.5A5 5 0 0 0 4.6 4a5.4 5.4 0 0 0-1.4 3.5c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 9 18v4" /><path d="M9 18c-4.5 2-5-2-7-2" /></svg>;
    case "grid": return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
    case "inbox": return <svg {...common}><path d="M4 4h16v13H4zM4 13h4l2 3h4l2-3h4" /></svg>;
    case "layers": return <svg {...common}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></svg>;
    case "link": return <svg {...common}><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" /></svg>;
    case "loader": return <svg {...common}><path d="M12 3a9 9 0 1 0 9 9" /></svg>;
    case "pause": return <svg {...common}><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>;
    case "plus": return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case "refresh": return <svg {...common}><path d="M20 11a8 8 0 0 0-14.7-4L3 9M3 4v5h5M4 13a8 8 0 0 0 14.7 4L21 15M21 20v-5h-5" /></svg>;
    case "search": return <svg {...common}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>;
    case "settings": return <svg {...common}><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" /><path d="m19.4 15 .1.1a2 2 0 1 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.2a2 2 0 1 1-4 0v-.2a2 2 0 0 0-3.4-1.4l-.1.1A2 2 0 1 1 3 15.1l.1-.1A2 2 0 0 0 1.7 11.6h-.2a2 2 0 1 1 0-4h.2A2 2 0 0 0 3 4.2L3 4.1A2 2 0 1 1 5.8 1.3l.1.1a2 2 0 0 0 3.4-1.4v-.2a2 2 0 1 1 4 0V0a2 2 0 0 0 3.4 1.4l.1-.1A2 2 0 1 1 19.6 4l-.1.1a2 2 0 0 0 1.4 3.4h.2a2 2 0 1 1 0 4h-.2a2 2 0 0 0-1.5 3.5Z" transform="scale(.78) translate(3.4 3.4)" /></svg>;
    case "spark": return <svg {...common}><path d="m12 3 1.2 5.8L19 10l-5.8 1.2L12 17l-1.2-5.8L5 10l5.8-1.2L12 3ZM19 16l.5 2.5L22 19l-2.5.5L19 22l-.5-2.5L16 19l2.5-.5L19 16Z" /></svg>;
    case "stop": return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
    case "terminal": return <svg {...common}><path d="m5 7 5 5-5 5M12 17h7" /></svg>;
    case "user": return <svg {...common}><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>;
    case "x": return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
  }
}