import { Analytics } from "@vercel/analytics/next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ReportMasthead } from "./components/report-masthead";
import "./globals.css";

export const viewport: Viewport = {
  colorScheme: "dark",
};

const title = "Corpus NEEDLE Benchmark";
const description =
  "See how Corpus compares with live web search APIs on Keenable’s NEEDLE benchmark across Scholar, News, Finance, AgenticRare, and Legal.";

export const metadata: Metadata = {
  metadataBase: new URL("https://needle.corpusd.dev"),
  alternates: {
    types: {
      "text/markdown": [{ url: "/results.md", title: "Corpus NEEDLE results as Markdown" }],
    },
  },
  title: {
    default: title,
    template: "%s · Corpus NEEDLE",
  },
  description,
  openGraph: {
    type: "website",
    siteName: "Corpus NEEDLE",
    title,
    description,
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh">
        <ReportMasthead />
        <div className="guide-shell mx-auto w-full max-w-[1260px]">
          {children}
        </div>
        <Analytics />
      </body>
    </html>
  );
}
