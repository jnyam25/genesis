import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { TwinProvider } from "@/lib/twin/twin-context";
import { NavBar } from "@/components/dashboard/nav-bar";
import { SafetyBanner } from "@/components/safety/safety-banner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Captsone — Industrial Paint Mixing HMI",
  description:
    "Operator HMI for the Captsone Industrial Paint Mixing System: live OEE, line schematic, and 3D visualization of the digital twin.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <TwinProvider>
          <NavBar />
          <SafetyBanner />
          {children}
        </TwinProvider>
      </body>
    </html>
  );
}
