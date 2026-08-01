// A module resolve hook so the verification scripts can import the app's
// real TypeScript modules instead of a copy of their logic.
//
// Node strips TypeScript types on its own, but it does not know about
// tsconfig's `@/*` path alias or about extensionless relative imports —
// both of which the app uses everywhere. This teaches it just those two
// things. It exists for the scripts only; nothing in `app/` or `lib/`
// depends on it.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);

function resolveFile(url) {
  if (existsSync(fileURLToPath(url))) return url.href;
  for (const suffix of [".ts", ".tsx", "/index.ts"]) {
    const candidate = new URL(url.href + suffix);
    if (existsSync(fileURLToPath(candidate))) return candidate.href;
  }
  return url.href;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return { url: resolveFile(new URL(specifier.slice(2), projectRoot)), shortCircuit: true };
  }

  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && context.parentURL?.endsWith(".ts")) {
    return { url: resolveFile(new URL(specifier, context.parentURL)), shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
