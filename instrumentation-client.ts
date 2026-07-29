// Runs after the document loads but before React hydration (Next 15.3+), so
// DataFast is listening in time to record the landing pageview with its
// original referrer and UTM/ad-click params intact.
//
// Kicked off without awaiting: Next warns if client instrumentation blocks for
// more than ~16ms, and getAnalytics() swallows its own failures.

import { getAnalytics } from "@/lib/analytics";

void getAnalytics();
