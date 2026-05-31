import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Podcast Generator",
  description: "Your interests, synthesized into a daily podcast.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
