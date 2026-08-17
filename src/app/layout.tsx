import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control Plane · Agent Harness",
  description: "A local command center for coding agents across your repositories.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}