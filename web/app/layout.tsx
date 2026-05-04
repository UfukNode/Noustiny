import type { Metadata } from "next";
import { Saira_Semi_Condensed, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Cursor from "../components/Cursor";

const saira = Saira_Semi_Condensed({
  variable: "--font-saira",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Noustiny · Branching Narrative Engine",
  description:
    "Detroit-style divergence flowchart, powered by Hermes agents. Every choice is a universe.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${saira.variable} ${jetbrains.variable}`}>
      <body>
        <Cursor />
        {children}
      </body>
    </html>
  );
}
