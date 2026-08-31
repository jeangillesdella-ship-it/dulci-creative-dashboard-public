import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dulci 海外投放素材看板",
  description: "Meta 与 TikTok 素材级安装、花费、Subpur 收入和事件成本监测。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
