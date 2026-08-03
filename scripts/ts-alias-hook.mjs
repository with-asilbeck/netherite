// A module resolve hook so the verification scripts can import the app's
// real TypeScript modules instead of a copy of their logic.
//
// Node strips TypeScript types on its own, but it does not know about
// tsconfig's `@/*` path alias or about extensionless relative imports —
// both of which the app uses everywhere. This teaches it just those two
// things. It exists for the scripts only; nothing in `app/` or `lib/`
// depends on it.

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);

// A *file*, not merely something that exists: `@/lib/llm` names a directory,
// and an existence check alone hands Node the directory to read as source
// (EISDIR) instead of falling through to the /index.ts candidate below.
function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

function resolveFile(url) {
  if (isFile(url)) return url.href;
  for (const suffix of [".ts", ".tsx", "/index.ts"]) {
    const candidate = new URL(url.href + suffix);
    if (isFile(candidate)) return candidate.href;
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
