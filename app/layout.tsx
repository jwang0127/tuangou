import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "邻里团购记账", description: "选好商品，自动算账。" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
