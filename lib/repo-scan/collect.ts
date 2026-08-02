import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  MAX_WALK_ENTRIES,
  PRIORITY_KEYWORDS,
} from "./config";

export type CollectedFile = {
  /** Repo-relative path, always forward-slashed. */
  relPath: string;
  bytes: number;
  text: string;
  /** Higher is riskier — see scoreFile. Comparable only within a tier. */
  score: number;
  /** Sample code, tests, or docs: ranked below all real source. */
  demoted: boolean;
  /** Priority keyword found in the path: this tier is never dropped by caps. */
  pathPriority: boolean;
  matchedKeywords: string[];
};

export type CollectResult = {
  files: CollectedFile[];
  /** Counts of what was left out, by reason — surfaced in the report. */
  excluded: {
    directories: number;
    extension: number;
    tooLarge: number;
    binary: number;
    lockfile: number;
    symlink: number;
  };
  /** True when caps dropped files that passed filtering. */
  truncated: boolean;
  droppedByCap: number;
  totalBytes: number;
};

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".turbo",
  ".yarn",
  "bower_components",
  // Test fixtures: high volume, low signal, and often intentionally
  // malformed in ways that read as vulnerabilities.
  "fixtures",
  "__fixtures__",
  "testdata",
  "test-fixtures",
  "snapshots",
  "__snapshots__",
  "cassettes",
]);

const EXCLUDED_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "cargo.lock",
  "go.sum",
  "packages.lock.json",
  "podfile.lock",
  "mix.lock",
]);

// Source extensions worth reviewing for vulnerabilities.
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".py",
  ".go",
  ".rb",
  ".erb",
  ".php",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".cs",
  ".rs",
  ".swift",
  ".m",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".pl",
  ".pm",
  ".ex",
  ".exs",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".graphql",
  ".gql",
  ".prisma",
  ".tf",
  ".tfvars",
  ".hcl",
  // Server-rendered templates. Easy to overlook as "not code", but they're
  // where output-escaping bugs (XSS) actually live — the first scan of a
  // real app excluded 130 files, most of them views.
  ".ejs",
  ".pug",
  ".jade",
  ".hbs",
  ".handlebars",
  ".mustache",
  ".twig",
  ".njk",
  ".jinja",
  ".jinja2",
  ".liquid",
  ".html",
  ".htm",
  ".jsp",
  ".aspx",
  ".cshtml",
  ".blade.php",
]);

// Config / infrastructure / env-adjacent files: where secrets and unsafe
// defaults actually live, so they're in scope even though they're not code.
const CONFIG_EXTENSIONS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".env",
  ".htaccess",
  ".pem",
  ".crt",
]);

const CONFIG_FILENAMES = new Set([
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "procfile",
  "nginx.conf",
  ".npmrc",
  ".dockerignore",
  ".gitattributes",
  "vercel.json",
  "netlify.toml",
  "serverless.yml",
]);

/** Media, archives, compiled objects, fonts, and other non-text payloads. */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".tiff", ".svg",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi", ".mkv", ".flac",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".so", ".dll", ".dylib", ".exe", ".bin", ".o", ".a", ".class", ".pyc", ".pyo",
  ".wasm", ".node", ".db", ".sqlite", ".sqlite3", ".mo", ".pack", ".idx",
  ".psd", ".ai", ".sketch", ".fig", ".blend", ".map",
]);

function isEnvFile(name: string): boolean {
  // .env, .env.local, .env.example, env.production …
  return name === ".env" || name.startsWith(".env.") || name.startsWith("env.");
}

function isMinified(name: string): boolean {
  return /\.min\.(js|css|mjs)$/.test(name) || name.endsWith(".bundle.js");
}

function isIncluded(name: string): boolean {
  const lower = name.toLowerCase();
  const ext = path.extname(lower);

  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (isMinified(lower)) return false;
  if (isEnvFile(lower)) return true;
  if (CONFIG_FILENAMES.has(lower)) return true;
  if (lower.startsWith("dockerfile")) return true;
  return SOURCE_EXTENSIONS.has(ext) || CONFIG_EXTENSIONS.has(ext);
}

/**
 * Sample code, tests, and documentation. Not excluded — a vulnerability in
 * an example that people copy/paste is a real finding — but demoted, for a
 * reason found by actually running the ranker: on a repo with an
 * `examples/` tree, every one of the top-scoring files came from it, and
 * the library's own source did not appear at all. The keywords that carry
 * the ranking (`auth`, `user`, `api`) are exactly the words demo apps are
 * named after, so this tier reliably outbids real source without being
 * where real vulnerabilities live.
 *
 * The deep-review budget is a dozen files, so losing it to sample code is
 * the difference between a useful scan and a useless one.
 */
const DEMOTED_PATH_RE =
  /(^|\/)(examples?|samples?|demos?|docs?|website|tests?|spec|specs|__tests__|e2e|benchmarks?)\//;

/**
 * Risk rank. A priority keyword in the **path** is worth far more than one in
 * the body, because path matches actually discriminate (`app/api/auth/...`)
 * while body matches barely do — the word "user" appears in most files of a
 * typical web app. Only path matches confer never-skip status.
 */
function scoreFile(relPath: string, text: string) {
  const lowerPath = relPath.toLowerCase();
  const lowerText = text.toLowerCase();

  const pathHits = PRIORITY_KEYWORDS.filter((k) => lowerPath.includes(k));
  const contentHits = PRIORITY_KEYWORDS.filter(
    (k) => !pathHits.includes(k) && lowerText.includes(k),
  );

  let score = pathHits.length * 10 + contentHits.length;

  // Small nudges for the shapes that carry most real findings.
  if (/(^|\/)(migrations?|db|database)\//.test(lowerPath)) score += 3;
  if (/(^|\/)(routes?|controllers?|handlers?|middleware)\//.test(lowerPath)) score += 3;
  if (isEnvFile(path.basename(lowerPath))) score += 8;

  // Demotion is a separate tier rather than a score penalty. Scaling the
  // score down instead was the first attempt and it compressed everything
  // into a two-point band, leaving real source tied with demo code — which
  // is the situation this was meant to fix. A tier gives the guarantee
  // outright: every non-demoted file ranks above every demoted one, and the
  // score keeps its original meaning within each tier.
  return {
    score,
    demoted: DEMOTED_PATH_RE.test(lowerPath),
    pathPriority: pathHits.length > 0 && !DEMOTED_PATH_RE.test(lowerPath),
    matchedKeywords: [...pathHits, ...contentHits],
  };
}

/**
 * The one ranking order, exported so the deep-review stage picks up the same
 * tiering rather than re-sorting on `score` alone and undoing it.
 */
export function byRisk(a: CollectedFile, b: CollectedFile): number {
  if (a.demoted !== b.demoted) return a.demoted ? 1 : -1;
  return b.score - a.score || a.relPath.localeCompare(b.relPath);
}

export async function collectFiles(root: string): Promise<CollectResult> {
  const excluded = {
    directories: 0,
    extension: 0,
    tooLarge: 0,
    binary: 0,
    lockfile: 0,
    symlink: 0,
  };

  const candidates: { relPath: string; absPath: string; bytes: number }[] = [];
  let walked = 0;

  async function walk(dir: string) {
    if (walked > MAX_WALK_ENTRIES) return;

    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return; // unreadable directory — skip rather than fail the scan
    }

    for await (const entry of handle) {
      if (walked++ > MAX_WALK_ENTRIES) return;

      const absPath = path.join(dir, entry.name);

      // Symlinks are never followed. core.symlinks=false during clone means
      // git shouldn't have created any, so this is the second line of defense
      // against being walked outside the clone directory.
      if (entry.isSymbolicLink()) {
        excluded.symlink++;
        continue;
      }

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
          excluded.directories++;
          continue;
        }
        await walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue; // sockets, FIFOs, devices

      const lowerName = entry.name.toLowerCase();
      if (EXCLUDED_FILENAMES.has(lowerName)) {
        excluded.lockfile++;
        continue;
      }
      if (!isIncluded(entry.name)) {
        excluded.extension++;
        continue;
      }

      let size: number;
      try {
        size = (await stat(absPath)).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        excluded.tooLarge++;
        continue;
      }

      candidates.push({
        relPath: path.relative(root, absPath).split(path.sep).join("/"),
        absPath,
        bytes: size,
      });
    }
  }

  await walk(root);

  const files: CollectedFile[] = [];
  for (const candidate of candidates) {
    let buffer: Buffer;
    try {
      buffer = await readFile(candidate.absPath);
    } catch {
      continue;
    }

    // A NUL byte means this is binary regardless of its extension — don't
    // hand it to a model as if it were source.
    if (buffer.includes(0)) {
      excluded.binary++;
      continue;
    }

    const text = buffer.toString("utf8");
    const { score, demoted, pathPriority, matchedKeywords } = scoreFile(
      candidate.relPath,
      text,
    );
    files.push({
      relPath: candidate.relPath,
      bytes: candidate.bytes,
      text,
      score,
      demoted,
      pathPriority,
      matchedKeywords,
    });
  }

  // Real source first, then sample code and tests; highest risk within each
  // tier, with a stable tiebreak by path so runs are reproducible.
  files.sort(byRisk);

  // Apply caps from the low-risk end. Path-priority files are exempt, so a
  // cap can never silence the auth/admin/payment/config files.
  const kept: CollectedFile[] = [];
  let totalBytes = 0;
  let droppedByCap = 0;

  for (const file of files) {
    const overCount = kept.length >= MAX_FILES;
    const overBytes = totalBytes + file.bytes > MAX_TOTAL_BYTES;
    if ((overCount || overBytes) && !file.pathPriority) {
      droppedByCap++;
      continue;
    }
    kept.push(file);
    totalBytes += file.bytes;
  }

  return {
    files: kept,
    excluded,
    truncated: droppedByCap > 0,
    droppedByCap,
    totalBytes,
  };
}
