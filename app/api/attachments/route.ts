import { createClient } from "@/lib/supabase/server";
import { checkUploadRateLimit } from "@/lib/rate-limit";

const BUCKET = "chat-attachments";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB — code/text files
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB — screenshots tend to be bigger

// Rejects oversized requests by their declared Content-Length before doing
// any body parsing — request.formData()/request.json() would otherwise
// buffer the whole body into memory first, so a client could send a huge
// payload to burn memory before the per-file/per-field checks below ever
// run. Content-Length is client-reported and can be omitted or understated
// (e.g. with chunked transfer-encoding), so this is a fast-path guard, not
// the only one — the post-parse byte-length checks below remain the real
// backstop.
const MAX_REQUEST_BYTES = Math.max(MAX_FILE_BYTES, MAX_IMAGE_BYTES) + 64 * 1024;

function rejectIfTooLarge(request: Request): Response | null {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Request is too large." }, { status: 413 });
  }
  return null;
}

// Kept in sync with the same constant in app/api/chat/route.ts, which
// re-validates this length independently — never trust the client to have
// already enforced it.
const MAX_ATTACHMENT_TEXT_LENGTH = 20000;

const ALLOWED_FILE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rb",
  ".php",
  ".java",
  ".json",
  ".yaml",
  ".yml",
  ".env.example",
  ".sql",
  ".md",
  ".txt",
];

const ALLOWED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

function isAllowedExtension(filename: string, allowList: string[]): boolean {
  const lower = filename.toLowerCase();
  return allowList.some((ext) => lower.endsWith(ext));
}

function sanitizeFilename(filename: string): string {
  // Basename only — strip any path-like segments a client might send —
  // then replace anything outside a conservative safe set. This isn't the
  // security boundary (the user-id path prefix is what RLS checks), just
  // hygiene so storage keys stay sane.
  const base = filename.split(/[/\\]/).pop() || "file";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(-150) || "file";
}

function decodeAsText(bytes: Uint8Array): string | null {
  try {
    // fatal: true rejects anything that isn't valid UTF-8 — a basic check
    // that a mislabeled binary/executable (renamed to an allowed
    // extension) at least isn't garbage bytes. The real safety guarantee
    // is that this content is never executed, only ever stored and passed
    // to the LLM as inert text — see app/api/chat/route.ts.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // PNG signature
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return true;
  }
  // JPEG signature
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true;
  }
  // WEBP: "RIFF"....."WEBP"
  const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return isRiff && isWebp;
}

function imageContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

async function handleFileUpload(
  supabase: SupabaseServerClient,
  userId: string,
  file: File,
) {
  if (!isAllowedExtension(file.name, ALLOWED_FILE_EXTENSIONS)) {
    return Response.json(
      { error: "That file type isn't supported. Allowed: code and text files only." },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_BYTES) {
    return Response.json(
      { error: "File is too large. Maximum size is 2MB." },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Never trust file.size (or any client-reported metadata) alone.
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return Response.json(
      { error: "File is too large. Maximum size is 2MB." },
      { status: 400 },
    );
  }

  const text = decodeAsText(bytes);
  if (text === null) {
    return Response.json(
      { error: "That file doesn't look like readable text." },
      { status: 400 },
    );
  }

  const truncated = text.length > MAX_ATTACHMENT_TEXT_LENGTH;
  const finalText = truncated ? text.slice(0, MAX_ATTACHMENT_TEXT_LENGTH) : text;

  const safeName = sanitizeFilename(file.name);
  const storagePath = `${userId}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType: "text/plain", upsert: false });

  if (uploadError) {
    console.error("[attachments] Supabase Storage upload (file) failed:", uploadError);
    return Response.json(
      { error: "Couldn't upload the file. Please try again." },
      { status: 500 },
    );
  }

  return Response.json({
    kind: "file" as const,
    storagePath,
    filename: file.name,
    text: finalText,
    truncated,
  });
}

async function handleImageUpload(
  supabase: SupabaseServerClient,
  userId: string,
  file: File,
) {
  if (!isAllowedExtension(file.name, ALLOWED_IMAGE_EXTENSIONS)) {
    return Response.json(
      { error: "That image type isn't supported. Allowed: PNG, JPG, WEBP." },
      { status: 400 },
    );
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json(
      { error: "Image is too large. Maximum size is 4MB." },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return Response.json(
      { error: "Image is too large. Maximum size is 4MB." },
      { status: 400 },
    );
  }

  if (!looksLikeImage(bytes)) {
    return Response.json(
      { error: "That doesn't look like a valid image file." },
      { status: 400 },
    );
  }

  const safeName = sanitizeFilename(file.name);
  const storagePath = `${userId}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType: imageContentType(safeName), upsert: false });

  if (uploadError) {
    console.error("[attachments] Supabase Storage upload (image) failed:", uploadError);
    return Response.json(
      { error: "Couldn't upload the image. Please try again." },
      { status: 500 },
    );
  }

  return Response.json({
    kind: "image" as const,
    storagePath,
    filename: file.name,
  });
}

export async function POST(request: Request) {
  const tooLarge = rejectIfTooLarge(request);
  if (tooLarge) return tooLarge;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Uploads are an authenticated-only feature — there's a real user id to
  // scope Supabase Storage RLS to, unlike guest chat.
  if (!user) {
    return Response.json({ error: "Please log in to upload files." }, { status: 401 });
  }

  const rateLimit = checkUploadRateLimit(user.id);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "You've reached the upload limit. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid upload." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file provided." }, { status: 400 });
  }

  const kind = formData.get("kind") === "image" ? "image" : "file";

  if (kind === "image") {
    return handleImageUpload(supabase, user.id, file);
  }
  return handleFileUpload(supabase, user.id, file);
}

export async function DELETE(request: Request) {
  const tooLarge = rejectIfTooLarge(request);
  if (tooLarge) return tooLarge;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Please log in." }, { status: 401 });
  }

  let body: { storagePath?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.storagePath !== "string") {
    return Response.json({ error: "Invalid storagePath." }, { status: 400 });
  }

  // Defense in depth alongside RLS — never rely on RLS alone: only ever
  // allow deleting an object under this user's own prefix.
  if (!body.storagePath.startsWith(`${user.id}/`)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const { error: deleteError } = await supabase.storage.from(BUCKET).remove([body.storagePath]);

  if (deleteError) {
    console.error("[attachments] Supabase Storage delete failed:", deleteError);
    return Response.json({ error: "Couldn't remove the file." }, { status: 500 });
  }

  return Response.json({ ok: true });
}
