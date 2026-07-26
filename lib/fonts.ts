import localFont from "next/font/local";
import { Inter } from "next/font/google";

export const jersey10 = localFont({
  src: "../public/fonts/Jersey10Charted-Regular.ttf",
  variable: "--font-jersey10",
  display: "swap",
});

export const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});
