import type { Metadata } from "next";
import { Cairo, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["400", "700", "800"],
});

export const metadata: Metadata = {
  title: "سند | منصة الدعم الفني",
  description: "منصة الدعم الفني سند",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${geistSans.variable} ${geistMono.variable} ${cairo.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className={`${cairo.className} min-h-full flex flex-col`}>
        <script dangerouslySetInnerHTML={{ __html: "try{if(localStorage.getItem('sanad-theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}" }} />
        {children}
      </body>
    </html>
  );
}
