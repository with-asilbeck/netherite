import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import localFont from "next/font/local";

/**
 * The NETHERITE wordmark face — Arcade by Jakob Fischer (pizzadude.dk),
 * self-hosted from `lib/fonts/`. Used for the brand name and nothing else.
 *
 * **⚠ Licence: non-commercial use only.** The EULA (shipped beside the file as
 * `lib/fonts/arcade-LICENSE.txt`) reads "Use this font for non-commercial use
 * only! If you plan to use it for commercial purposes, contact me before doing
 * so!" and "Do not distribute without the author's permission." Netherite
 * sells paid plans, and serving a font from a web page distributes it — so
 * shipping this to production needs the author's written permission first.
 * Contact jakob@pizzadude.dk. See PROGRESS.md.
 *
 * One weight only, declared explicitly: the file carries a single cut, so any
 * `font-semibold` left on a wordmark would be synthesised by the browser
 * rather than drawn. The call sites drop that class for this reason.
 */
export const arcade = localFont({
  src: "./fonts/arcade.ttf",
  variable: "--font-arcade",
  weight: "400",
  style: "normal",
  display: "swap",
});

/**
 * The landing page's display and code faces. They are applied on the landing
 * wrapper rather than in the root layout on purpose — the rest of the app is
 * on the San Francisco system stack (`--system-sans` in globals.css), and
 * these two are only downloaded by the page that uses them.
 *
 * There was an `inter` export here that eleven page wrappers imported and
 * spread as `${inter.variable}`. That only ever *declared* `--font-inter`;
 * nothing read it, and `font-sans` resolved elsewhere — so Inter was fetched
 * on almost every route and rendered on none of them.
 */
export const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains-mono",
});
