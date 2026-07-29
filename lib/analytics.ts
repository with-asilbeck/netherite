// DataFast (datafa.st) analytics. Browser-only — the SDK reads window/document
// and localStorage at init, so everything here must be called from client code.
//
// The website ID is not a secret: DataFast's non-npm install is a plain
// <script data-website-id="..."> tag, so this value is public by design and
// only says which dashboard the events land in. Hardcoded so local dev and
// Vercel need no extra env setup — move it to NEXT_PUBLIC_DATAFAST_WEBSITE_ID
// if you ever want staging traffic reported to a separate DataFast site.

import { initDataFast, type CustomProperties, type DataFastWeb } from "datafast";

const WEBSITE_ID = "dfid_k4L9AHqnxEVXgYQr3GUpi";

let client: Promise<DataFastWeb | null> | null = null;

// Resolves to null rather than throwing when analytics is unavailable (SSR,
// blocked by an ad blocker, network error). Tracking failures should never be
// able to break a page.
export function getAnalytics(): Promise<DataFastWeb | null> {
  if (typeof window === "undefined") return Promise.resolve(null);

  if (!client) {
    client = initDataFast({
      websiteId: WEBSITE_ID,
      // Captures the initial pageview plus every history.pushState /
      // replaceState / popstate — which is exactly how the App Router
      // navigates, so client-side route changes are covered too.
      autoCapturePageviews: true,
    }).catch((error: unknown) => {
      console.error("[datafast] failed to initialize", error);
      client = null; // let a later caller retry instead of caching the failure
      return null;
    });
  }

  return client;
}

// Fire-and-forget custom event. Event names must be lowercase alphanumeric
// plus _ - : (max 64 chars); at most 10 properties, values max 255 chars —
// the SDK drops anything outside those limits.
export async function trackEvent(
  name: string,
  properties?: CustomProperties,
): Promise<void> {
  const analytics = await getAnalytics();
  await analytics?.track(name, properties);
}
