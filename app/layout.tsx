import type { Metadata } from "next";
import localFont from "next/font/local";
import { initializeTheme } from "./theme";
import "./globals.css";

const dmSans = localFont({
  src: "./fonts/dm-sans.woff2",
  weight: "100 1000",
  display: "swap",
  variable: "--font-dm-sans",
});

export const metadata: Metadata = {
  title: "Mój chatbot",
  description: "Mój pierwszy chatbot na kursie LABA",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: initializeTheme }} />
      </head>
      <body className={dmSans.variable}>{children}</body>
    </html>
  );
}
