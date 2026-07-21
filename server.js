// Warranty Ticket Reviewer
// A small Express app: paste a warranty repair-order / ticket, and Claude
// reviews it against Ford warranty documentation standards — completeness
// (the 3 Cs), rejection-risk flags, a plain-English summary, and a
// claim-ready rewrite. Behind an access-code login.
//
// Required environment variables:
//   ANTHROPIC_API_KEY - your Anthropic API key (powers the review)
//   ACCESS_CODE       - the password users must enter
// Optional:
//   PORT              - set automatically by Render
//   MOCK=1            - return a canned review instead of calling the API (testing)

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Image compression (optional). Uploaded photos are often ~30MB straight off a
// phone; we only need enough detail to spot major issues, so we shrink them
// before sending to the API and before saving to History. If sharp is somehow
// unavailable at runtime, we degrade gracefully and store the originals rather
// than crashing.
let SHARP = null;
try { SHARP = require("sharp"); }
catch (e) { console.error("sharp not available - images will be stored uncompressed:", e.message); }
// Pure-JS HEIC/HEIF decoder. iPhones shoot HEIC by default, and sharp's prebuilt
// binary cannot decode HEVC-based HEIC. heic-convert bundles libheif as WASM, so
// it works on any host regardless of system codecs. Loaded lazily/optionally.
let HEIC_CONVERT = null;
try { HEIC_CONVERT = require("heic-convert"); }
catch (e) { console.error("heic-convert not available - HEIC photos can't be converted:", e.message); }
const IMG_MAX_EDGE = 2000;        // longest side, px
const IMG_JPEG_QUALITY = 72;      // good enough to read a hard card / spot damage
const IMG_COMPRESS_THRESHOLD = 1_200_000; // only bother compressing files above ~1.2MB

// Compress one image buffer: auto-orient, cap the longest edge, re-encode as
// JPEG. Returns the smaller of {compressed, original}. Never throws.
async function compressImageBuffer(buf, type) {
  if (!SHARP || !buf || buf.length < IMG_COMPRESS_THRESHOLD) return { buf, type };
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) return { buf, type };
  try {
    const out = await SHARP(buf, { failOn: "none" })
      .rotate() // honor EXIF orientation before we strip metadata
      .resize({ width: IMG_MAX_EDGE, height: IMG_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: IMG_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    if (out && out.length && out.length < buf.length) return { buf: out, type: "image/jpeg" };
  } catch (e) { console.error("Image compress failed, keeping original:", e.message); }
  return { buf, type };
}

// The image formats the reviewer API can read directly. Anything else has to be
// converted to one of these (or reported as unreadable) before we send it.
const API_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Detect Apple HEIC/HEIF (what iPhones produce by default). We check the MIME
// type, the filename, AND the ISO-BMFF magic bytes, because browsers often send
// HEIC with an empty or wrong type.
function looksHeic(buf, type, name) {
  const t = String(type || "").toLowerCase();
  if (t.includes("heic") || t.includes("heif")) return true;
  const n = String(name || "").toLowerCase();
  if (/\.(heic|heif)$/.test(n)) return true;
  if (buf && buf.length > 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12).toLowerCase();
    if (["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return true;
  }
  return false;
}

// HEIC/HEIF -> JPEG using the pure-JS decoder. Returns a Buffer or null on failure.
async function heicToJpeg(buf) {
  if (!HEIC_CONVERT) return null;
  try {
    const out = await HEIC_CONVERT({ buffer: buf, format: "JPEG", quality: 0.9 });
    const b = Buffer.from(out);
    return (b && b.length) ? b : null;
  } catch (e) { console.error("HEIC->JPEG failed:", e.message); return null; }
}

// Convert any sharp-decodable image (tiff, bmp, avif, etc.) to JPEG. Null on failure.
async function sharpToJpeg(buf) {
  if (!SHARP) return null;
  try {
    const out = await SHARP(buf, { failOn: "none" })
      .rotate()
      .resize({ width: IMG_MAX_EDGE, height: IMG_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: IMG_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return (out && out.length) ? out : null;
  } catch (e) { console.error("Image->JPEG failed:", e.message); return null; }
}

// Friendly message when we truly can't read an uploaded image, so nothing is ever
// silently dropped from a review.
function unreadableMsg(names) {
  const one = names.length === 1;
  return "We couldn't read " + (one ? "this photo" : "these photos") + ": " + names.join(", ") +
    ". Please upload " + (one ? "it" : "them") + " as a JPG, PNG, or PDF. " +
    "(On iPhone: Settings → Camera → Formats → “Most Compatible,” or just take a screenshot of the photo and upload that.)";
}

// Prepare an uploaded-files array: convert iPhone HEIC (and other odd image
// formats) to JPEG so the reviewer can actually read them, then shrink oversized
// photos. PDFs and non-image attachments pass through untouched. Returns the
// processed files plus the names of any image we genuinely could not read.
async function prepareFiles(files) {
  if (!Array.isArray(files) || !files.length) return { files: files || [], unreadable: [] };
  const out = [];
  const unreadable = [];
  for (const f of files) {
    let type = String((f && f.type) || "");
    let name = String((f && f.name) || "photo");
    const data = String((f && f.data) || "");
    if (!data) { out.push(f); continue; }
    let buf;
    try { buf = Buffer.from(data, "base64"); } catch { out.push(f); continue; }

    if (looksHeic(buf, type, name)) {
      const jpg = await heicToJpeg(buf);
      if (!jpg) { unreadable.push(name); continue; }
      buf = jpg; type = "image/jpeg";
      name = name.replace(/\.(heic|heif)$/i, "") + ".jpg";
    } else if (type.startsWith("image/") && !API_IMAGE_TYPES.includes(type)) {
      // An image in a format the reviewer can't read (tiff, bmp, avif, ...).
      const jpg = await sharpToJpeg(buf);
      if (!jpg) { unreadable.push(name); continue; }
      buf = jpg; type = "image/jpeg";
      name = name.replace(/\.[a-z0-9]+$/i, "") + ".jpg";
    }

    const r = await compressImageBuffer(buf, type);
    if (r.buf === buf && r.type === type) {
      out.push({ name, type, data: buf.toString("base64") });
    } else {
      let nm = name;
      if (r.type === "image/jpeg") nm = nm.replace(/\.(png|webp|heic|heif|jpe?g|gif)$/i, "") + ".jpg";
      out.push({ name: nm, type: r.type, data: r.buf.toString("base64") });
    }
  }
  return { files: out, unreadable };
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ACCESS_CODE = process.env.ACCESS_CODE;
const PORT = process.env.PORT || 3000;
const MOCK = process.env.MOCK === "1";

if (!ACCESS_CODE || (!ANTHROPIC_API_KEY && !MOCK)) {
  console.error("Missing required environment variables. Set ANTHROPIC_API_KEY and ACCESS_CODE.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth: a signed cookie proves the visitor entered the access code once.
// ---------------------------------------------------------------------------
const AUTH_SECRET = crypto.createHash("sha256").update("wtr-v1|" + ACCESS_CODE).digest();
const AUTH_TOKEN = crypto.createHmac("sha256", AUTH_SECRET).update("authed").digest("hex");

// --- Multi-tenant auth: per-user passwords (scrypt) + signed session cookie ---
function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  try {
    const dk = crypto.scryptSync(String(pw), salt, 32);
    const h = Buffer.from(hash, "hex");
    return dk.length === h.length && crypto.timingSafeEqual(dk, h);
  } catch { return false; }
}
const SESSION_SECRET = crypto.createHmac("sha256", AUTH_SECRET).update("session-v1").digest();
function signSession(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(p).digest("base64url");
  return p + "." + sig;
}
function readSession(token) {
  if (!token || token.indexOf(".") < 0) return null;
  const i = token.indexOf(".");
  const p = token.slice(0, i), sig = token.slice(i + 1);
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(p).digest("base64url");
  try {
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    return JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch { return null; }
}
function cookieVal(req, name) {
  const cookies = (req.headers.cookie || "").split(";").map((c) => c.trim());
  const t = cookies.find((c) => c.startsWith(name + "="));
  return t ? t.slice(name.length + 1) : null;
}

// ---------------------------------------------------------------------------
// Multi-factor authentication (TOTP, RFC 6238). Works with Microsoft
// Authenticator, Google Authenticator, Authy, 1Password — any standard app.
// Required for everyone. Break-glass: set MFA_DISABLED=1 in the environment to
// turn enforcement off (so the owner can never be permanently locked out).
// All crypto is stdlib (no external dependency) and validated against the
// RFC 6238 published test vectors.
// ---------------------------------------------------------------------------
const MFA_ISSUER = "ClaimProof";
const MFA_REQUIRED = !process.env.MFA_DISABLED;
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]; bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretBuf, counter, digits) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac("sha1", secretBuf).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (bin % Math.pow(10, digits)).toString().padStart(digits, "0");
}
function totpVerify(secretB32, token, opts) {
  opts = opts || {};
  const step = opts.step || 30, digits = opts.digits || 6, window = opts.window == null ? 1 : opts.window;
  const t = String(token || "").replace(/\D/g, "");
  if (t.length !== digits) return false;
  let secretBuf;
  try { secretBuf = base32Decode(secretB32); } catch { return false; }
  if (!secretBuf.length) return false;
  const counter = Math.floor((Date.now() / 1000) / step);
  for (let w = -window; w <= window; w++) {
    const exp = hotp(secretBuf, counter + w, digits);
    if (exp.length === t.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(t))) return true;
  }
  return false;
}
function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
function otpauthURI(secretB32, label) {
  const acct = encodeURIComponent(label || "user");
  const iss = encodeURIComponent(MFA_ISSUER);
  return `otpauth://totp/${iss}:${acct}?secret=${secretB32}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}
function genBackupCodes(n) {
  const codes = [];
  for (let i = 0; i < (n || 10); i++) codes.push(crypto.randomBytes(5).toString("hex"));
  return codes; // 10 hex chars each
}
function hashBackup(code) {
  return crypto.createHash("sha256").update("bk|" + String(code).toLowerCase().replace(/\s/g, "")).digest("hex");
}
// Short-lived (10 min) signed MFA challenge token; reuses the session signer.
function signMfa(obj) { return signSession(obj); }
function readMfa(token) {
  const o = readSession(token);
  if (!o || !o.iat || Date.now() - o.iat > 10 * 60 * 1000) return null;
  return o;
}

const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return false;
  }
  rec.count += 1;
  return rec.count > 20;
}

// ---------------------------------------------------------------------------
// Optional distilled Ford Warranty & Policy reference. Loaded from (in order):
// REFERENCE_FILE env var, Render secret file, or a local ford_reference.md.
// Kept OUT of the public repo — deploy it as a Render Secret File.
// ---------------------------------------------------------------------------
let FORD_REFERENCE = "";
for (const p of [
  process.env.REFERENCE_FILE,
  "/etc/secrets/ford_reference.md",
  path.join(__dirname, "ford_reference.md"),
].filter(Boolean)) {
  try {
    if (fs.existsSync(p)) {
      FORD_REFERENCE = fs.readFileSync(p, "utf8");
      console.log("Loaded Ford W&P reference from " + p + " (" + FORD_REFERENCE.length + " chars)");
      break;
    }
  } catch {}
}
if (!FORD_REFERENCE) console.log("No Ford W&P reference file found - reviewing with general knowledge only.");

// ---------------------------------------------------------------------------
// Optional distilled Ford OWS Claiming reference (how a claim must be entered /
// coded / submitted in OWS). Loaded from (in order): OWS_REFERENCE_FILE env var,
// Render secret file, or a local ows_reference.md. Kept OUT of the public repo —
// deploy it as a Render Secret File.
// ---------------------------------------------------------------------------
let OWS_REFERENCE = "";
for (const p of [
  process.env.OWS_REFERENCE_FILE,
  "/etc/secrets/ows_reference.md",
  path.join(__dirname, "ows_reference.md"),
].filter(Boolean)) {
  try {
    if (fs.existsSync(p)) {
      OWS_REFERENCE = fs.readFileSync(p, "utf8");
      console.log("Loaded OWS claiming reference from " + p + " (" + OWS_REFERENCE.length + " chars)");
      break;
    }
  } catch {}
}
if (!OWS_REFERENCE) console.log("No OWS claiming reference file found.");

// ---------------------------------------------------------------------------
// Optional distilled Ford/Lincoln Protect (ESP) claiming reference. Only used
// when the claim type is ESP / service contract. Loaded from (in order):
// ESP_REFERENCE_FILE env var, Render secret file, or a local esp_reference.md.
// Kept OUT of the public repo — deploy it as a Render Secret File.
// ---------------------------------------------------------------------------
let ESP_REFERENCE = "";
for (const p of [
  process.env.ESP_REFERENCE_FILE,
  "/etc/secrets/esp_reference.md",
  path.join(__dirname, "esp_reference.md"),
].filter(Boolean)) {
  try {
    if (fs.existsSync(p)) {
      ESP_REFERENCE = fs.readFileSync(p, "utf8");
      console.log("Loaded ESP (Ford/Lincoln Protect) reference from " + p + " (" + ESP_REFERENCE.length + " chars)");
      break;
    }
  } catch {}
}
if (!ESP_REFERENCE) console.log("No ESP claiming reference file found.");

// Claim-type rulebook: what the reviewer applies on top of the base prompt.
// Note: ESP is OWS Claim Type 11 with Sub-Code ESP (Type 71 is competitive-make);
// SPW is its own Type 21. Standard NVLW and ESP share code 11 but different rules,
// so they carry distinct internal keys ("11" vs "11-ESP").
const CLAIM_TYPES = {
  "11":     { label: "11 — Standard vehicle warranty (NVLW)" },
  "11-ESP": { label: "11 — ESP / service contract (Sub-Code ESP)" },
  "21":     { label: "21 — Service Part Warranty (SPW)" },
  "31":     { label: "31 — FSA / Recall" },
};
function claimTypeAddendum(claimType) {
  const ct = String(claimType || "");
  if (ct === "11-ESP") {
    return "\n\n=== CLAIM TYPE: 11 (Sub-Code ESP) — ESP / SERVICE CONTRACT (Ford Protect / Lincoln Protect) ===\n" +
      "This is a Ford Protect / Lincoln Protect service-contract (ESP) claim — OWS Claim Type 11, Sub-Code ESP (competitive-make is Type 71/ESC). It is NOT the base New Vehicle Limited Warranty. Coverage, the deductible, prior-approval thresholds, the submission window, parts-markup caps, and rental/loaner rules are governed by the CONTRACT and the ESP manual below, applied ON TOP OF the base rules. Actively check: which plan is in force (PremiumCARE / ExtraCARE / BaseCARE / PowertrainCARE / Powertrain Wrap / EV / Maintenance / CPO / Blue Advantage, etc.) and whether the repaired component is actually covered under THAT plan and tier; that the contract is in force by time, miles AND engine hours and is not cancelled; that the correct deductible is applied; that prior approval was obtained where the ESP dollar thresholds require it; and the correct sub-code. Treat a missing/incorrect deductible, an uncovered component, an out-of-force contract, or a missing ESP prior approval as CRITICAL. Cite ESP manual pages (e.g. \"per ESP 11:24\")." +
      (ESP_REFERENCE ? "\n\n=== FORD/LINCOLN PROTECT (ESP) CLAIMING REFERENCE ===\n" + ESP_REFERENCE : "");
  }
  if (ct === "21") {
    return "\n\n=== CLAIM TYPE: 21 — SERVICE PART WARRANTY (SPW) ===\n" +
      "This claim is for a Ford / Motorcraft / Omnicraft service or replacement part the dealership installed, under Service Part Warranty (not the NVLW, not an ESP contract). ASSUME the advisor has ALREADY verified, before running this tool, that the part is within its SPW coverage period (generally 24 months / unlimited miles for customer-paid parts, or 12 months / 12,000 miles for warranty-installed parts). Therefore: do NOT flag or deduct for the coverage period, the elapsed odometer, or the install date, and do NOT treat any of them as missing. 'Elapsed odometer' is a derived value, never a required entry field - do not look for it. If an Original RO / Invoice # or SPW Install Date is provided in the fields, note it as documented; if either is blank, do NOT deduct. SPW PRIOR APPROVAL: prior approval is documented whenever an SPWA authorization number is present - EITHER in the 'SPW PRIOR APPROVAL # (SPWA)' field at the top of the ticket, OR anywhere in the Complaint/Cause/Correction story or the additional detail. An SPWA number is any token that starts with the letters 'SPWA' followed by digits (with or without a space, '#', or dash - e.g. 'SPWA12345', 'SPWA #12345', 'SPWA-12345', 'prior approval SPWA 12345'). If ANY such SPWA number appears anywhere in this ticket, mark prior approval SATISFIED and do NOT flag, mention in risks, or deduct for missing prior approval - the approval process was followed. Only raise a prior-approval concern at all when ALL of these are true: the causal base part number starts with 6 (engine), 7 (transmission) or 9 (fuel system), AND the repair exceeds $1,000, AND NO SPWA number appears anywhere in the ticket. For EVERY other system (brakes, suspension, steering, electrical, body, HVAC, etc.) do NOT flag, mention, or deduct for prior approval regardless. A replacement part carries only the remaining warranty of the part it replaced (it never restarts).";
  }
  if (ct === "31") {
    return "\n\n=== CLAIM TYPE: 31 — FIELD SERVICE ACTION (RECALL / CSP / FSA) ===\n" +
      "This is a Field Service Action (recall / customer satisfaction program / FSA) claim. It MUST be claimed as the FSA — never coded as ordinary warranty. Actively check: the FSA/campaign is OPEN on THIS VIN per OASIS; the correct campaign number and FSA option code are used; parts and labor match the FSA/TSB instructions exactly; any related (collateral) damage is on a SEPARATE repair line and usually needs SSSC prior approval; and recall labor is not padded with unrelated actual time. Apply the recall/FSA claiming rules from the OWS reference. Treat coding a recall as warranty, a closed/again-claimed campaign, or a wrong option code as CRITICAL.";
  }
  return "\n\n=== CLAIM TYPE: 11 — STANDARD VEHICLE WARRANTY (NVLW) ===\n" +
    "This claim is under the New Vehicle Limited Warranty. Coverage is governed by the vehicle's warranty periods in the W&P reference — verify the concern is within coverage by age/mileage and is a defect (not wear, maintenance, or abuse). Apply the standard warranty documentation and OWS claiming rules.";
}

// ---------------------------------------------------------------------------
// The review prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an experienced Ford dealership warranty administrator reviewing warranty repair-order documentation BEFORE the claim is submitted. You know Ford's warranty documentation expectations cold: the 3 Cs (Concern/Complaint, Cause, Correction), causal part identification, labor operations, actual/punch time, diagnostic path with test results (including OASIS/PTS checks and pinpoint tests where relevant), mileage and dates, VIN, prior-approval thresholds, and the classic audit red flags.

Review the ticket text the user provides and respond with ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:

{
  "summary": "2-4 sentence plain-English recap of what this ticket says happened",
  "score": <0-100 integer, overall claim-readiness>,
  "verdict": "ready" | "needs_work" | "high_risk",
  "completeness": [
    {"item": "Complaint (customer concern)", "status": "ok" | "missing" | "unclear", "note": "one short sentence"},
    ... one entry per documentation element: Complaint, Cause, Correction, Causal part, Labor op / time, Diagnostic steps & test results, VIN / vehicle info, Mileage & dates, and anything else relevant to THIS ticket
  ],
  "risks": [
    {"severity": "critical" | "serious" | "warning", "flag": "short title", "detail": "why this could get the claim rejected or flagged in an audit, and what to do about it"}
  ],
  "rewrite": {
    "complaint": "claim-ready Complaint line based only on facts present in the ticket, IN ALL CAPS",
    "cause": "claim-ready Cause statement, IN ALL CAPS",
    "correction": "claim-ready Correction statement, IN ALL CAPS"
  },
  "questions": ["anything the tech/advisor should answer or add before submitting, as short direct questions"]
}

Rules:
- Judge only from what is written. Never invent test results, part numbers, times, or diagnostic steps that are not in the ticket - if the rewrite needs a fact that is missing, put a bracketed placeholder like [ADD PUNCH TIME] and list it in "questions".
- The repair order supplies these as SEPARATE DOCUMENTED FIELDS, listed at the top of the ticket: Repair Order #, Line, VIN, Mileage In, Mileage Out, and Causal Part # (and, for SPW claims, Original RO/Invoice #, SPW Install Date, and SPW Prior Approval # (SPWA)). When a value is present in one of these fields, that element is DOCUMENTED - mark its completeness item "ok" and do NOT deduct or flag it just because it is not repeated in the Complaint/Cause/Correction narrative. Per Ford, these must be documented on the RO, not written into the 3C story. Only flag such an item if its field is actually blank, or internally inconsistent (e.g. Mileage Out lower than Mileage In, or a Causal Part # that plainly contradicts the stated cause). A Causal Part # of "NPF" means no-problem-found - evaluate it under the NPF rules, not as a missing causal part.
- Do NOT create a risk or deduct points for RECALLS or NHTSA campaigns. Any recall/campaign list is model-level, informational only, and shown to the advisor separately - it must NEVER lower the score and must NOT appear in "risks". At most, if the actual repair on this ticket is obviously an open recall being coded as ordinary warranty, note it once in "questions" (never in "risks", never affecting the score).
- LABOR OPERATIONS are ENTIRELY OFF-LIMITS. Do NOT flag, deduct, comment on, or ask about labor operations in ANY way - not their format, validity, SLTS/actual-time selection, overlap, hours, NOR their absence or documentation. You do not have Ford's labor-operation catalog, and verifying labor ops is the warranty administrator's and technician's job. Never write "labor operation", "labor op", "SLTS", "punch time", or anything about missing/invalid/overlapping labor ops in "risks", "completeness", or "questions", and never let labor operations affect the score. Do not add a completeness item for labor ops at all.
- Do NOT police the two-digit CONDITION CODE or the customer concern code the tech entered, and never assert what a specific numeric code "means" unless you are certain from the reference. Condition code 42 = "does not operate properly" (it is NOT a tire-only code). Do not deduct for the condition-code value the tech chose.
- Do NOT flag the CAUSAL PART # as an invalid, wrong, or bad-format part number, and do not judge whether it is a "valid Ford part number." Accept the causal part number the tech entered as documented; only question it if it plainly names a completely different system than the stated cause.
- "Found bad, replaced"-style causes, missing diagnosis, aftermarket-part involvement, and story inconsistencies are the classic rejection triggers - call them out.
- WEAR IS NOT AUTOMATICALLY EXCLUDED. Under the bumper-to-bumper New Vehicle Limited Warranty, a component that fails or wears out PREMATURELY within the coverage period because of a defect in materials or workmanship IS covered - Ford pays these as premature/abnormal wear caused by a defect, and under bumper-to-bumper virtually every part is covered when the failure is a manufacturer defect. Only a short, specific set of TRUE maintenance / normal-wear items are actually excluded: brake pads/linings and other friction material worn by normal use, wiper blades/inserts, engine/cabin air and oil filters, fluids and lubricants, spark plugs and other scheduled-maintenance items, clutch friction discs worn by use, wheel alignment/balancing, and tires (covered by the tire manufacturer). For one of THOSE true maintenance items claimed as warranty, DO flag it (that is a real exclusion). But for ANY OTHER component (steering, suspension, drivetrain, engine internals, electrical, etc.), the part IS covered when the failure is a defect - so:
  * NEVER classify it as an excluded "wear item," never use a phrase like "wear item claimed as warranty," and never treat the wear itself as a reason the claim will be rejected.
  * NEVER mark it "critical" and never set verdict "high_risk" merely because the cause uses "worn out"/"wear" language on a covered part. Premature wear of a covered component is not a claim-killer.
  * The ONLY legitimate concern with a bare "found worn, replaced" write-up on a covered part is wording: the cause should name the specific defect and state the wear was premature/abnormal for the age and mileage. Surface that as coaching, NOT as a rejection - put it in "questions" (preferred), or at most as a single "warning"-severity risk phrased as "strengthen the cause: identify the defect and note the wear was premature," never "serious" or "critical."
  * Always carry the premature-defect framing into the rewrite (e.g. "STEERING TIE ROD ENDS FAILED PREMATURELY AT [MILEAGE], WELL BEFORE EXPECTED SERVICE LIFE, DUE TO A DEFECT..."), so the claim reads the way Ford expects.
  A thin-but-coverable wear write-up on a covered part should land around "needs_work" with a fixable-wording note - not "high_risk."
- Be direct and practical, like a warranty admin who wants the claim to get PAID, not a lecture.
- Never question or flag the calendar dates on the ticket as implausible or "in the future" - assume the ticket's dates are current. Only flag dates for internal inconsistency (e.g. date out before date in, disclosure before repair).
- If the pasted text is not a warranty ticket at all, say so in "summary", set score to 0 and verdict to "high_risk", and leave the arrays sensible but short.
- A physical repair-order HARD CARD (or any attached image/PDF) is OPTIONAL supporting information, NOT a requirement. Ford only requests original documentation on a small share of claims, chosen at Ford's discretion at random. Therefore, when NO hard card or file is attached: do NOT add any hard-card completeness item, do NOT create any risk, and do NOT deduct a single point for the absence of a hard card or documentation. Never write "hard card not provided", "no hard card attached", "documentation missing", or anything similar in "risks" or "completeness", and never let the absence lower the score. Instead, add exactly ONE brief, non-scoring reminder to the "questions" array (a recommendation, not a deficiency): recommend verifying on the physical hard card that all required signatures are in the correct lines (customer signature and any management authorization), that any add-on repairs are coded correctly on the hard card, and that customer signatures appear on the appropriate lines. This is advisory only and must not affect the score.
- ONLY when a hard card or file IS actually attached: the hard copy is the OFFICIAL record of the repair (per 1.2.01). Read it and cross-check against the typed ticket. Verify required signatures/authorizations are in the correct lines (customer signature or management authorization for dealer vehicles), that add-on repairs are coded/initialed correctly, and that the hard card matches the typed story (mileage, dates, parts). Add completeness entries only in this case, and flag a genuine discrepancy between an attached hard card and the typed claim as serious. If an attached file is unreadable or isn't a repair order, say so in a completeness note. Do NOT do labor-operation or punch-time math (labor operations are off-limits as stated above).` +
  (FORD_REFERENCE
    ? `\n\nYou also have the dealership's distilled Ford Warranty & Policy Manual reference below. Apply these ACTUAL Ford rules when reviewing: check coverage periods against the vehicle's age/mileage, flag missing prior approvals, missing required test readings, time-limit problems, and exclusions. When a finding is based on a specific rule, cite the manual section number (e.g. "per 1.3.04") in the note or detail so the advisor can look it up.\n\n=== FORD WARRANTY & POLICY REFERENCE ===\n` + FORD_REFERENCE
    : "") +
  (OWS_REFERENCE
    ? `\n\nYou ALSO have the dealership's distilled Ford OWS (Online Warranty System) Claiming reference below — the rules for how a claim must be coded and submitted in OWS. Use it to check claim-readiness: the causal part and its 2-char condition code, the customer concern code, required comments (3 Cs in the comment fields), standard vs actual time claiming, exception/self-approval codes, required attachments, sublet (OSP/OSL) entry, and the commodity-specific rules (battery tester codes, paint material, tires, etc.). When a finding is based on an OWS rule, cite the OWS section (e.g. "per OWS §4 causal part") so the advisor can look it up. Flag OWS-specific rejection triggers from its "Common Rejection / Return Triggers" list.\n\n=== FORD OWS CLAIMING REFERENCE ===\n` + OWS_REFERENCE
    : "");

// ---------------------------------------------------------------------------
// Per-store rule switches. Each rule's `def` matches the base prompt behavior
// above, so a store with no customizations is graded exactly as today. When a
// store is set to a rule's NON-default state, that rule's `override` text is
// appended to THAT store's system prompt only (and folded into its cache key),
// so one dealership's changes never affect another's grading. `disclaimer:true`
// marks a change that WEAKENS grading — the owner must acknowledge before it saves.
// ---------------------------------------------------------------------------
const RULES = [
  { key: "wearCoaching", label: "Premature-wear documentation coaching", def: true, disclaimer: true,
    desc: "Coaches the tech to name the defect and state the wear was premature when a covered part is written up as just \"worn.\"",
    override: "OVERRIDE FOR THIS STORE: Do NOT coach or flag premature-wear wording. If a covered component is described as \"worn out\" without naming a specific defect, accept it as documented - do not add the premature-wear question, note, or any wear-related risk." },
  { key: "diagnosisFlagging", label: "Missing-diagnosis / \"found bad, replaced\" flagging", def: true, disclaimer: true,
    desc: "Flags causes that lack a diagnostic path (e.g. \"found bad, replaced\").",
    override: "OVERRIDE FOR THIS STORE: Do NOT flag missing diagnosis or \"found bad, replaced\"-style causes. Accept the stated cause as documented without requiring a diagnostic path or test results." },
  { key: "threeCs", label: "Require the 3 Cs (Complaint / Cause / Correction)", def: true, disclaimer: true,
    desc: "Flags a missing, thin, or weak Complaint, Cause, or Correction.",
    override: "OVERRIDE FOR THIS STORE: Do NOT flag or deduct for a missing, thin, or weak Complaint, Cause, or Correction, and do not require the 3 Cs to be complete." },
  { key: "npfHandling", label: "No-Problem-Found (NPF) scrutiny", def: true, disclaimer: true,
    desc: "Applies extra scrutiny to no-problem-found claims.",
    override: "OVERRIDE FOR THIS STORE: Do NOT apply extra scrutiny to no-problem-found (NPF) claims; treat an NPF causal part and cause as acceptable without additional documentation." },
  { key: "coverageChecks", label: "Coverage-period & prior-approval checks", def: true, disclaimer: true,
    desc: "Flags coverage-period problems and missing prior approvals.",
    override: "OVERRIDE FOR THIS STORE: Do NOT flag coverage-period problems or missing prior approvals of any kind; assume coverage and any required approvals are satisfied." },
  { key: "laborOps", label: "Labor-operation review", def: false, disclaimer: false,
    desc: "Off by default. When on, ClaimProof may flag obvious labor-operation problems.",
    override: "OVERRIDE FOR THIS STORE: You MAY review labor operations. Ignore any instruction that labor operations are off-limits; when clearly warranted, note obvious labor-operation mismatches, missing labor ops, or actual-time-vs-labor-op problems in \"questions\" (never above \"warning\" severity)." },
  { key: "hardCardRequired", label: "Require a hard card on every claim", def: false, disclaimer: false,
    desc: "Off by default (hard card optional). When on, a missing hard card is flagged.",
    override: "OVERRIDE FOR THIS STORE: A physical hard card is REQUIRED. If no hard-card image/PDF is attached, add a completeness item \"Hard card\" with status \"missing\" and a single \"warning\"-severity risk that the hard card must be attached before submission (never above \"warning\")." },
  { key: "conditionCode", label: "Condition-code / concern-code policing", def: false, disclaimer: false,
    desc: "Off by default. When on, ClaimProof may question the two-digit codes entered.",
    override: "OVERRIDE FOR THIS STORE: You MAY question the two-digit condition code or customer concern code when it clearly contradicts the stated cause; note it in \"questions.\"" },
  { key: "causalPartFormat", label: "Causal-part-number format checking", def: false, disclaimer: false,
    desc: "Off by default. When on, ClaimProof may flag an implausible causal part number.",
    override: "OVERRIDE FOR THIS STORE: You MAY question a causal part number that is clearly malformed or implausible for the stated repair; note it in \"questions.\"" },
  { key: "recallFlagging", label: "Recall / FSA flagging", def: false, disclaimer: false,
    desc: "Informational only by default. When on, an open recall coded as warranty is flagged as a risk.",
    override: "OVERRIDE FOR THIS STORE: If the repair on the ticket is plainly an open recall/FSA being coded as ordinary warranty, you MAY raise it as a \"serious\" risk (not only a question)." },
];
const RULES_BY_KEY = Object.fromEntries(RULES.map((r) => [r.key, r]));
function storeRuleState(store, r) {
  const c = store && store.ruleConfig;
  return (c && Object.prototype.hasOwnProperty.call(c, r.key)) ? !!c[r.key] : r.def;
}
function buildRuleOverrides(store) {
  const parts = [];
  for (const r of RULES) {
    if (storeRuleState(store, r) !== r.def) parts.push("- " + r.override);
  }
  if (!parts.length) return "";
  return "\n\n=== STORE-SPECIFIC RULE OVERRIDES (authoritative — apply on top of everything above) ===\n" + parts.join("\n");
}

const MOCK_REVIEW = {
  summary: "Customer brought the vehicle in for a coolant leak. Tech found a cracked degas bottle, replaced it, and pressure-tested the system. Overall the story is believable but the documentation is thin.",
  score: 62,
  verdict: "needs_work",
  completeness: [
    { item: "Complaint (customer concern)", status: "ok", note: "Coolant leak concern is stated." },
    { item: "Cause", status: "unclear", note: "\"Found cracked\" - no diagnostic path showing how it was isolated." },
    { item: "Correction", status: "ok", note: "Replacement and pressure test documented." },
    { item: "Causal part", status: "missing", note: "No part number listed for the degas bottle." },
    { item: "Labor op / time", status: "missing", note: "No labor operation or punch time on the ticket." },
    { item: "VIN / vehicle info", status: "ok", note: "VIN present." },
    { item: "Mileage & dates", status: "missing", note: "No mileage recorded." }
  ],
  risks: [
    { severity: "serious", flag: "No punch time", detail: "Claims without actual time are a top audit flag. Add clock-in/out for the repair." },
    { severity: "warning", flag: "Thin diagnosis", detail: "Add the pressure-test result that pointed to the degas bottle." }
  ],
  rewrite: {
    complaint: "Customer states coolant level drops and smells coolant after driving.",
    cause: "Pressure tested cooling system at [ADD PSI/RESULT]; isolated external leak to degas bottle - found crack at seam.",
    correction: "Replaced degas bottle [ADD PART NUMBER], refilled coolant to spec, pressure tested system - no leaks found. [ADD PUNCH TIME]"
  },
  questions: ["What was the pressure-test spec and result?", "What is the causal part number?", "What was the actual punch time?"]
};

// ---------------------------------------------------------------------------
// VIN extraction + NHTSA recall lookup (only runs when a VIN is in the ticket)
// ---------------------------------------------------------------------------
function extractVin(text) {
  const matches = String(text).toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || [];
  for (const m of matches) {
    if (/[A-HJ-NPR-Z]/.test(m) && /[0-9]/.test(m)) return m; // must mix letters+digits
  }
  return null;
}

async function fetchJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function lookupRecalls(vin) {
  const d = await decodeVin(vin);
  if (!d.ok) return { vin, error: d.error || "Could not decode this VIN." };
  const { year, make, model } = d;
  let list = [];
  try {
    const rec = await fetchJson(
      "https://api.nhtsa.gov/recalls/recallsByVehicle?make=" + encodeURIComponent(make) +
      "&model=" + encodeURIComponent(model) + "&modelYear=" + encodeURIComponent(year)
    );
    list = (rec?.results || []).map((x) => ({
      campaign: x.NHTSACampaignNumber || "",
      date: x.ReportReceivedDate || "",
      component: x.Component || "",
      summary: String(x.Summary || "").slice(0, 400),
      remedy: String(x.Remedy || "").slice(0, 300),
    }));
  } catch (e) {
    return { vin, year, make, model, vehicleLabel: d.label, error: "VIN decoded but recall lookup failed: " + e.message };
  }
  return { vin, year, make, model, vehicleLabel: d.label, recalls: list };
}

function recallContext(info) {
  if (!info || info.error || !info.recalls) return "";
  let s = "\n\n=== NHTSA RECALL LOOKUP (automatic) ===\nVIN " + info.vin + " decoded as " +
    info.year + " " + info.make + " " + info.model + ". NHTSA lists " + info.recalls.length +
    " recall campaign(s) for this year/make/model:\n";
  for (const r of info.recalls.slice(0, 25)) {
    s += "- " + r.campaign + " (" + r.date + ") " + r.component + ": " + r.summary + "\n";
  }
  s += "\nREFERENCE ONLY - DO NOT SCORE: These are model-level campaigns from NHTSA (not VIN-specific open recalls), shown to the advisor separately for reference. Do NOT create a risk about them and do NOT deduct any points for recalls. Ignore them when scoring unless the actual repair on THIS ticket is plainly an open recall being coded as ordinary warranty, in which case note it once in \"questions\" only.";
  return s;
}

// Attached hard-card files -> Claude API content blocks
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
function fileBlocks(files) {
  const blocks = [];
  for (const f of (files || []).slice(0, 4)) {
    const type = String(f.type || "");
    const data = String(f.data || "");
    if (!data || data.length > 14_000_000) continue; // ~10MB decoded cap per file
    if (IMAGE_TYPES.includes(type)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: type, data } });
    } else if (type === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// History: every review/appeal is saved to a JSON file so it can be searched.
// Uses /data (Render persistent disk) when present, else ./data locally.
// ---------------------------------------------------------------------------
const HISTORY_DIR = process.env.HISTORY_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const HISTORY_FILE = path.join(HISTORY_DIR, "history.json");
// Uploaded documents are saved as real files here (one folder per record), so the
// history.json stays small and the FULL submission — hard cards, PDFs, photos —
// is retained on the persistent disk and can be re-downloaded from History.
const HISTORY_FILES_DIR = path.join(HISTORY_DIR, "history-files");

// ---------------------------------------------------------------------------
// VIN decoding (NHTSA vPIC — free, no key, no partnership). Cached forever
// since a VIN never changes. Powers the "Decode VIN" button everywhere a VIN
// is entered, and the vehicle it returns is the handoff a repair-data
// integration (e.g. ProDemand) would key off of.
// ---------------------------------------------------------------------------
const VIN_CACHE_FILE = path.join(HISTORY_DIR, "vin_cache.json");
let VIN_CACHE = {};
try { if (fs.existsSync(VIN_CACHE_FILE)) VIN_CACHE = JSON.parse(fs.readFileSync(VIN_CACHE_FILE, "utf8")) || {}; } catch (e) { console.error("vin cache load:", e.message); }
function saveVinCache() { try { fs.writeFileSync(VIN_CACHE_FILE, JSON.stringify(VIN_CACHE)); } catch (e) {} }
const VIN_TRANS = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,"0":0,"1":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9 };
const VIN_WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
function vinFormatValid(vin) { return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin); }
function vinCheckDigitOk(vin) {
  if (!vinFormatValid(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) { const c = vin[i]; if (!(c in VIN_TRANS)) return false; sum += VIN_TRANS[c] * VIN_WEIGHTS[i]; }
  const r = sum % 11; const cd = r === 10 ? "X" : String(r);
  return vin[8] === cd;
}
function vinLabel(o) {
  const base = [o.year, o.make, o.model].filter(Boolean).join(" ");
  const eng = o.displacement ? (o.displacement + "L" + (o.engineCyl ? " " + o.engineCyl + "-cyl" : "")) : (o.engineCyl ? o.engineCyl + "-cyl" : "");
  const extra = [eng, o.trim || o.series, o.body].filter(Boolean).join(" · ");
  return extra ? base + " · " + extra : base;
}
async function decodeVin(vinRaw) {
  const vin = String(vinRaw || "").toUpperCase().replace(/\s+/g, "");
  if (!vinFormatValid(vin)) return { ok: false, reason: "invalid", error: "That isn't a valid 17-character VIN." };
  if (VIN_CACHE[vin]) return VIN_CACHE[vin];
  let dec;
  try {
    dec = await fetchJson("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/" + encodeURIComponent(vin) + "?format=json");
  } catch (e) {
    return { ok: false, reason: "service", error: "The VIN decoder is unavailable right now." };
  }
  const v = (dec && dec.Results && dec.Results[0]) || {};
  const year = v.ModelYear, make = v.Make, model = v.Model;
  if (!year || !make || !model) return { ok: false, reason: "notfound", error: "Couldn't decode this VIN — double-check the characters." };
  const disp = v.DisplacementL ? Math.round(parseFloat(v.DisplacementL) * 10) / 10 : "";
  const out = {
    ok: true, vin, valid: vinCheckDigitOk(vin),
    year, make, model, trim: v.Trim || "", series: v.Series || "", body: v.BodyClass || "",
    engineCyl: v.EngineCylinders || "", displacement: (disp || disp === 0) && !Number.isNaN(disp) ? disp : "",
    fuel: v.FuelTypePrimary || "", drive: v.DriveType || "",
  };
  out.vehicle = [out.year, out.make, out.model].filter(Boolean).join(" ");
  out.label = vinLabel(out);
  VIN_CACHE[vin] = out; saveVinCache();
  return out;
}

let HISTORY = [];
try {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_FILES_DIR, { recursive: true });
  if (fs.existsSync(HISTORY_FILE)) HISTORY = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  console.log("History: " + HISTORY.length + " record(s) loaded from " + HISTORY_FILE);
} catch (e) {
  console.error("History load failed:", e.message);
}

function saveHistory() {
  try {
    if (HISTORY.length > 5000) HISTORY = HISTORY.slice(-5000); // cap
    const tmp = HISTORY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(HISTORY));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    console.error("History save failed:", e.message);
  }
}

// Repair Story usage log. Kept in its OWN file so customer-pay Story data stays
// walled off from warranty history — the reporting tool reads it separately.
const STORY_USAGE_FILE = path.join(HISTORY_DIR, "story_usage.json");
let STORY_USAGE = [];
try {
  if (fs.existsSync(STORY_USAGE_FILE)) STORY_USAGE = JSON.parse(fs.readFileSync(STORY_USAGE_FILE, "utf8"));
} catch (e) { console.error("Story usage load failed:", e.message); }
function saveStoryUsage() {
  try {
    if (STORY_USAGE.length > 5000) STORY_USAGE = STORY_USAGE.slice(-5000);
    const tmp = STORY_USAGE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(STORY_USAGE));
    fs.renameSync(tmp, STORY_USAGE_FILE);
  } catch (e) { console.error("Story usage save failed:", e.message); }
}
function logStoryUsage(rec) {
  rec.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  rec.ts = new Date().toISOString();
  STORY_USAGE.push(rec);
  saveStoryUsage();
}

// --- Support inbox: help requests are saved server-side (no email needed) and
// shown to the owner in the console, tagged with the store and user. ----------
const SUPPORT_FILE = path.join(HISTORY_DIR, "support.json");
let SUPPORT = [];
try {
  if (fs.existsSync(SUPPORT_FILE)) SUPPORT = JSON.parse(fs.readFileSync(SUPPORT_FILE, "utf8"));
} catch (e) { console.error("Support inbox load failed:", e.message); }
function saveSupport() {
  try {
    if (SUPPORT.length > 3000) SUPPORT = SUPPORT.slice(0, 3000);
    const tmp = SUPPORT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(SUPPORT, null, 2));
    fs.renameSync(tmp, SUPPORT_FILE);
  } catch (e) { console.error("Support inbox save failed:", e.message); }
}
function addSupport(rec) { SUPPORT.unshift(rec); saveSupport(); }

// --- Live status: MEASURED, not scraped. We used to read the AI providers'
// public status pages, but those flag partial or unrelated incidents and cry
// wolf — showing red while the API we actually use works fine. Instead we now
// ping each provider's API directly from the server every minute and report only
// what WE can really reach: a lightweight authenticated GET /v1/models confirms
// the service is up and our key works, with no token cost. Cached 60s. ----------
let STATUS_CACHE = { at: 0, data: null };
async function pingOnce(url, headers) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    const r = await fetch(url, { method: "GET", headers, signal: ctl.signal });
    clearTimeout(timer);
    if (r.ok) return "operational";          // reachable and our key works
    if (r.status === 429) return "degraded";  // up, just rate-limited
    return "outage";                          // 5xx or 4xx — can't actually use it
  } catch (e) {
    return "outage";                          // network error / timeout — unreachable
  }
}
// One quick retry before declaring a provider down, so a single blip inside the
// 60s cache window doesn't paint a false outage.
async function pingProvider(url, headers) {
  const first = await pingOnce(url, headers);
  return first === "outage" ? await pingOnce(url, headers) : first;
}
// Vendor-free note text keyed off level only. The end user never sees which
// third-party services power the app.
function statusNote(level) {
  return level === "operational" ? "Running normally."
    : level === "degraded" ? "Running slower than usual — reviews may take a little longer."
    : level === "maintenance" ? "Brief scheduled maintenance in progress."
    : level === "outage" ? "Currently experiencing a disruption. We're on it."
    : "Live status check is temporarily unavailable.";
}
function rankLevel(l) { return { operational: 0, maintenance: 1, degraded: 2, unknown: 2, outage: 3 }[l] || 0; }
function worseOf(a, b) { return rankLevel(a) >= rankLevel(b) ? a : b; }
function bestOf(a, b) { return rankLevel(a) <= rankLevel(b) ? a : b; }
async function getSystemStatus() {
  if (STATUS_CACHE.data && Date.now() - STATUS_CACHE.at < 60000) return STATUS_CACHE.data;
  // Ping the actual APIs the app uses — only the providers we hold a key for.
  const [anthropic, openai] = await Promise.all([
    ANTHROPIC_API_KEY ? pingProvider("https://api.anthropic.com/v1/models", { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }) : Promise.resolve(null),
    OPENAI_API_KEY ? pingProvider("https://api.openai.com/v1/models", { authorization: "Bearer " + OPENAI_API_KEY }) : Promise.resolve(null),
  ]);
  // Hosting: you just loaded this page from the server, so the site is reachable.
  const serviceLevel = "operational";
  // Reviews, appeals, and Story drafting fail over across every configured
  // provider, so this capability is healthy if ANY provider is actually reachable
  // (best-of across the ones we could reach). It is only down if we can reach NONE.
  const reviewProviders = [anthropic, openai].filter((l) => l != null);
  const reviewLevel = reviewProviders.length ? reviewProviders.reduce((best, l) => bestOf(best, l)) : "unknown";
  // The optional Story fact-check runs only on the backup provider. Being
  // unreachable just pauses the optional polish, so its user impact tops out at
  // "degraded" — never an outage of anything the dealership depends on.
  const factCheckRaw = openai == null ? "unknown" : openai;
  const factCheckLevel = rankLevel(factCheckRaw) > rankLevel("degraded") ? "degraded" : factCheckRaw;
  const components = [
    { key: "service", critical: true, name: "ClaimProof service", detail: "The website, your reviews, history, and reports.", level: serviceLevel, note: "You're connected, so the service is online." },
    { key: "reviews", critical: true, name: "Warranty review engine", detail: "Reviews, appeals, and Repair Story drafting.", level: reviewLevel, note: reviewLevel === "operational" ? "Running normally, with automatic backup protection." : statusNote(reviewLevel) },
    { key: "story", critical: false, name: "Repair Story fact-check", detail: "Optional second-pass polish on Repair Stories.", level: factCheckLevel, note: factCheckLevel === "operational" ? "Running normally." : "Optional polish is paused right now — your reviews and write-ups are unaffected." },
  ];
  // The headline reflects only capabilities the dealership actually depends on;
  // an optional, non-blocking feature never trips a service-disruption banner.
  const worst = components.filter((c) => c.critical !== false).reduce((w, c) => worseOf(w, c.level), "operational");
  const data = { checkedAt: new Date().toISOString(), overall: worst, components };
  STATUS_CACHE = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------
// Per-store learning. The reviewer remembers the recurring documentation
// problems it has flagged for each store, feeds a short summary of them into
// that store's future reviews (so it catches repeats and can point them out),
// and surfaces them on an Insights page. STRICTLY per store: a store only ever
// learns from its own history; nothing is pooled or shared across stores.
// ---------------------------------------------------------------------------
const STORE_MEMORY_FILE = path.join(HISTORY_DIR, "store_memory.json");
let STORE_MEMORY = {}; // storeId -> { patterns: [...], updatedAt }
try {
  if (fs.existsSync(STORE_MEMORY_FILE)) STORE_MEMORY = JSON.parse(fs.readFileSync(STORE_MEMORY_FILE, "utf8"));
} catch (e) { console.error("Store memory load failed:", e.message); }
function saveStoreMemory() {
  try {
    const tmp = STORE_MEMORY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(STORE_MEMORY));
    fs.renameSync(tmp, STORE_MEMORY_FILE);
  } catch (e) { console.error("Store memory save failed:", e.message); }
}
const SEV_RANK = { warning: 1, serious: 2, critical: 3 };
// Normalize a free-text flag/item into a grouping key so the same recurring
// problem lands in the same bucket even when the wording varies slightly.
function normKey(s) {
  return String(s || "").toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[0-9]+/g, "#")
    .replace(/[^a-z#]+/g, " ")
    .trim().replace(/\s+/g, " ").slice(0, 80);
}
// Pull the recurring-issue signals out of one review's result.
function extractIssues(result) {
  const out = [];
  if (!result || typeof result !== "object") return out;
  for (const c of (Array.isArray(result.completeness) ? result.completeness : [])) {
    const status = String((c && c.status) || "").toLowerCase();
    if (status !== "missing" && status !== "unclear") continue;
    const item = String((c && c.item) || "").trim();
    if (!item) continue;
    out.push({
      key: "missing:" + normKey(item),
      label: item + (status === "unclear" ? " — documented unclearly" : " — missing or blank"),
      severity: status === "missing" ? "serious" : "warning", kind: "completeness",
    });
  }
  for (const r of (Array.isArray(result.risks) ? result.risks : [])) {
    const flag = String((r && r.flag) || "").trim();
    if (!flag) continue;
    out.push({ key: "risk:" + normKey(flag), label: flag, severity: String((r && r.severity) || "warning").toLowerCase(), kind: "risk" });
  }
  return out;
}
// Merge one review's issues into a store's memory (no save; caller saves).
function applyIssues(storeId, result, ts) {
  const issues = extractIssues(result);
  if (!storeId || !issues.length) return;
  const mem = STORE_MEMORY[storeId] || (STORE_MEMORY[storeId] = { patterns: [], updatedAt: null });
  const now = ts || new Date().toISOString();
  for (const is of issues) {
    let p = mem.patterns.find((x) => x.key === is.key);
    if (!p) { p = { key: is.key, label: is.label, kind: is.kind, severity: is.severity, count: 0, firstTs: now, lastTs: now, status: "active", confirms: 0 }; mem.patterns.push(p); }
    p.count += 1;
    if (String(now) > String(p.lastTs || "")) p.lastTs = now;
    if ((SEV_RANK[is.severity] || 0) > (SEV_RANK[p.severity] || 0)) p.severity = is.severity;
    if (is.kind === "risk" && is.label && is.label.length > (p.label || "").length) p.label = is.label;
  }
  mem.updatedAt = now;
}
function learnFromReview(storeId, result, ts) {
  try { applyIssues(storeId, result, ts); saveStoreMemory(); } catch (e) { console.error("learnFromReview failed:", e.message); }
}
// Count of review records a store has (so Insights can say "learned from N").
function storeReviewCount(storeId) {
  let n = 0;
  for (const r of HISTORY) if (r && r.type === "review" && r.storeId === storeId) n++;
  return n;
}
// The prompt snippet injected into a store's reviews. Only patterns that have
// actually recurred (count>=2) and are not muted; ranked, capped at 8.
function storeMemoryPromptSnippet(storeId) {
  const mem = STORE_MEMORY[storeId];
  if (!mem || !Array.isArray(mem.patterns)) return "";
  const top = mem.patterns
    .filter((p) => p.status !== "muted" && p.count >= 2)
    .sort((a, b) => (b.count - a.count) || String(b.lastTs || "").localeCompare(String(a.lastTs || "")))
    .slice(0, 8);
  if (!top.length) return "";
  const lines = top.map((p) => "- " + p.label + " (flagged " + p.count + "× in this store's past tickets)").join("\n");
  return "\n\nTHIS STORE'S RECURRING DOCUMENTATION ISSUES (learned from ITS OWN past reviews). Use this ONLY to check the current ticket more carefully — do NOT invent facts from it, and do NOT flag an item unless it genuinely applies to THIS ticket. For any item below that DOES apply here, call it out as you normally would and, where natural, note in the \"detail\" that it is a recurring issue for this store so the advisor can build the habit of fixing it. If an item does not apply to this ticket, ignore it silently.\n" + lines;
}
// Seed every store's memory from the full review history — used the first time
// so the feature works from day one on existing data.
function rebuildStoreMemory() {
  STORE_MEMORY = {};
  const revs = HISTORY.filter((r) => r && r.type === "review" && r.storeId && r.result);
  revs.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  for (const r of revs) applyIssues(r.storeId, r.result, r.ts);
  saveStoreMemory();
  return revs.length;
}
if (!fs.existsSync(STORE_MEMORY_FILE)) {
  try { const n = rebuildStoreMemory(); console.log("Store memory seeded from " + n + " past review(s)."); }
  catch (e) { console.error("Store memory seed failed:", e.message); }
}

const EXT_BY_TYPE = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
  "image/webp": ".webp", "application/pdf": ".pdf",
};
// Write a submission's attachments to disk under the record's own folder and
// return lightweight metadata ({name,type,size,key}) to store on the record.
function persistHistoryFiles(id, files) {
  const meta = [];
  if (!Array.isArray(files) || !files.length) return meta;
  try {
    const dir = path.join(HISTORY_FILES_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    let idx = 0;
    for (const f of files.slice(0, 4)) {
      const type = String((f && f.type) || "");
      const data = String((f && f.data) || "");
      if (!data) continue;
      let buf;
      try { buf = Buffer.from(data, "base64"); } catch { continue; }
      if (!buf.length || buf.length > 15_000_000) continue; // ~15MB cap per file
      const key = idx + (EXT_BY_TYPE[type] || ".bin");
      fs.writeFileSync(path.join(dir, key), buf);
      meta.push({
        name: String((f && f.name) || ("attachment-" + (idx + 1))).slice(0, 200),
        type, size: buf.length, key,
      });
      idx++;
    }
  } catch (e) { console.error("History file save failed:", e.message); }
  return meta;
}
function removeHistoryFiles(id) {
  try { fs.rmSync(path.join(HISTORY_FILES_DIR, id), { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Multi-tenant model: STORES (dealerships) and USERS (advisors). Each store is
// walled off - a user only ever sees their own store's history and files.
// Persisted next to the history on the private disk.
// ---------------------------------------------------------------------------
const STORES_FILE = path.join(HISTORY_DIR, "stores.json");
const USERS_FILE = path.join(HISTORY_DIR, "users.json");
const STORE_LOGOS_DIR = path.join(HISTORY_DIR, "store-logos");
try { fs.mkdirSync(STORE_LOGOS_DIR, { recursive: true }); } catch {}
let STORES = [], USERS = [];
try { if (fs.existsSync(STORES_FILE)) STORES = JSON.parse(fs.readFileSync(STORES_FILE, "utf8")) || []; } catch (e) { console.error("stores load:", e.message); }
try { if (fs.existsSync(USERS_FILE)) USERS = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) || []; } catch (e) { console.error("users load:", e.message); }
function saveStores() { try { fs.writeFileSync(STORES_FILE, JSON.stringify(STORES, null, 2)); } catch (e) { console.error("stores save:", e.message); } }
function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(USERS, null, 2)); } catch (e) { console.error("users save:", e.message); } }
function genId(p) { return p + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"); }
function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "store"; }
function storeById(id) { return STORES.find((s) => s.id === id) || null; }
function storeBySlug(slug) { return STORES.find((s) => s.slug === slug) || null; }
function userByEmail(email) { const e = String(email || "").trim().toLowerCase(); return USERS.find((u) => u.email === e) || null; }
function userById(id) { return USERS.find((u) => u.id === id) || null; }
function createStore({ name, city, slug, active = true, plan = "pilot" }) {
  let s = slugify(slug || name), base = s, n = 2;
  while (storeBySlug(s)) { s = base + "-" + n; n++; }
  const store = { id: genId("st_"), name: String(name || "").trim() || "Store", city: String(city || "").trim(), slug: s, logoKey: null, logoType: "image/png", logoVer: 0, active: !!active, plan, features: { story: true, warranty: false }, createdAt: new Date().toISOString() };
  STORES.push(store); saveStores(); return store;
}
// Which product tiers a store is entitled to. Unset (grandfathered) = both on.
function storeFeatures(s) {
  const f = (s && s.features) || {};
  return { story: f.story !== false, warranty: f.warranty !== false };
}
function createUser({ storeId, email, password, name, role = "advisor", active = true }) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !password) throw new Error("email and password are required");
  if (userByEmail(e)) throw new Error("A user with that email already exists");
  const { salt, hash } = hashPassword(password);
  const user = { id: genId("us_"), storeId, email: e, name: String(name || "").trim(), role, salt, hash, active: !!active, createdAt: new Date().toISOString() };
  USERS.push(user); saveUsers(); return user;
}

// One-time seed: convert the existing single-tenant install into a default
// store + owner account, and stamp any pre-existing history to that store so
// nothing already saved is lost or leaked between stores.
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || "codywhitefacefordservice@gmail.com").trim().toLowerCase();
let DEFAULT_STORE_ID = (STORES[0] && STORES[0].id) || null;
if (!STORES.length) {
  const store = createStore({ name: "Whiteface Ford", city: "Hereford, Texas", slug: "whiteface", active: true, plan: "owner" });
  store.logoKey = "builtin"; store.features = { story: true, warranty: true }; saveStores();
  DEFAULT_STORE_ID = store.id;
  try { createUser({ storeId: store.id, email: OWNER_EMAIL, password: ACCESS_CODE, name: "Owner", role: "owner" }); }
  catch (e) { console.error("seed owner failed:", e.message); }
  let migrated = 0;
  for (const r of HISTORY) { if (!r.storeId) { r.storeId = store.id; migrated++; } }
  if (migrated) saveHistory();
  console.log("Seeded default store '" + store.name + "' (owner " + OWNER_EMAIL + "), migrated " + migrated + " history record(s).");
}
// Grandfather any store that predates tiers to full access (so nothing that
// already worked suddenly disappears); new stores start entry-tier only.
{
  let ch = false;
  for (const s of STORES) { if (!s.features) { s.features = { story: true, warranty: true }; ch = true; } }
  if (ch) saveStores();
}

// Resolve the logged-in {user, store} from the request, or null.
function sessionCtx(req) {
  const s = readSession(cookieVal(req, "wtr_sess"));
  if (s && s.uid && s.sid) {
    const user = userById(s.uid), store = storeById(s.sid);
    if (user && store && user.active && user.storeId === store.id) return { user, store, sess: s };
  }
  // Grace path: an existing valid legacy access-code cookie keeps working as the
  // default-store owner, so the current install is never locked out on upgrade.
  // (This session carries no MFA marker, so the MFA layer will still challenge it.)
  const legacy = cookieVal(req, "wtr_auth");
  if (legacy && legacy.length === AUTH_TOKEN.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(AUTH_TOKEN))) {
        const store = storeById(DEFAULT_STORE_ID), owner = userByEmail(OWNER_EMAIL);
        if (store && owner) return { user: owner, store, sess: { uid: owner.id, sid: store.id, legacy: true } };
      }
    } catch {}
  }
  return null;
}
function requireOwner(req, res, next) {
  if (req.ctx && req.ctx.user && req.ctx.user.role === "owner") return next();
  return res.status(403).json({ error: "forbidden" });
}

// ---------------------------------------------------------------------------
// Deterministic result cache.
// The AI, even at temperature 0, can find a different number of gaps/risks on
// repeat runs of the SAME ticket, which would make the score jump around. That
// breaks training. So we hash the exact input (ticket text + attached files)
// and, once a ticket has been reviewed, we always return that first stored
// result verbatim for any identical resubmission. Same input -> same score,
// guaranteed. Bump RUBRIC_VERSION whenever the scoring logic, weights, or
// system prompt change so previously cached results are invalidated.
// ---------------------------------------------------------------------------
const RUBRIC_VERSION = "2026-07-16.12";
const REVIEW_CACHE_FILE = path.join(HISTORY_DIR, "review_cache.json");
const REVIEW_CACHE_CAP = 3000;
let REVIEW_CACHE = {};
try {
  if (fs.existsSync(REVIEW_CACHE_FILE)) REVIEW_CACHE = JSON.parse(fs.readFileSync(REVIEW_CACHE_FILE, "utf8")) || {};
  console.log("Review cache: " + Object.keys(REVIEW_CACHE).length + " entr(ies) loaded (rubric " + RUBRIC_VERSION + ")");
} catch (e) {
  console.error("Review cache load failed:", e.message);
  REVIEW_CACHE = {};
}
function saveReviewCache() {
  try {
    const keys = Object.keys(REVIEW_CACHE);
    if (keys.length > REVIEW_CACHE_CAP) {
      keys.sort((a, b) => (REVIEW_CACHE[a].ts || 0) - (REVIEW_CACHE[b].ts || 0));
      for (const k of keys.slice(0, keys.length - REVIEW_CACHE_CAP)) delete REVIEW_CACHE[k];
    }
    const tmp = REVIEW_CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(REVIEW_CACHE));
    fs.renameSync(tmp, REVIEW_CACHE_FILE);
  } catch (e) {
    console.error("Review cache save failed:", e.message);
  }
}
function filesSignature(files) {
  const arr = (Array.isArray(files) ? files : []).slice(0, 4).map((f) => ({
    type: String(f.type || ""),
    data: String(f.data || ""),
  }));
  return crypto.createHash("sha256").update(JSON.stringify(arr)).digest("hex");
}
// A stable fingerprint of one submission. Whitespace is normalized so that a
// re-paste with different trailing spaces/line endings still counts as "the
// same ticket".
function normalizeText(t) {
  return String(t || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").trim();
}
function reviewCacheKey(kind, ticket, files, extra) {
  return crypto
    .createHash("sha256")
    .update(
      RUBRIC_VERSION + "|" + kind + "|" +
      normalizeText(ticket) + "|" +
      normalizeText(extra) + "|" +
      filesSignature(files)
    )
    .digest("hex");
}

function extractRo(text) {
  const m = String(text).match(/\bR\.?O\.?\s*[#:\-]?\s*([0-9]{4,10})\b/i);
  return m ? m[1] : "";
}

function addHistory(rec) {
  rec.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  rec.ts = new Date().toISOString();
  // Retain the submission's uploaded documents alongside the record.
  if (rec.pendingFiles) {
    rec.files = persistHistoryFiles(rec.id, rec.pendingFiles);
    delete rec.pendingFiles;
  }
  HISTORY.push(rec);
  saveHistory();
  return rec.id;
}

// --- Smart search -----------------------------------------------------------
const BLOBS = new Map(); // record id -> lowercase deep-text blob
function recordBlob(r) {
  let b = BLOBS.get(r.id);
  if (!b) {
    try {
      b = JSON.stringify([r.ro, r.vin, r.vehicle, r.summary, r.ticket, r.rejection, r.result, r.recallInfo,
        r.causalPart, causalBase(r.causalPart), (r.outcome && [r.outcome.status, r.outcome.reason, r.outcome.notes])]).toLowerCase();
    } catch { b = ""; }
    BLOBS.set(r.id, b);
  }
  return b;
}

function parseDateToken(v, endOfDay) {
  const s = String(v || "").toLowerCase().trim();
  const now = new Date();
  const day = 24 * 3600 * 1000;
  if (s === "today") { const d = new Date(now.toDateString()); return endOfDay ? d.getTime() + day - 1 : d.getTime(); }
  if (s === "yesterday") { const d = new Date(now.toDateString()); return (endOfDay ? d.getTime() - 1 : d.getTime() - day); }
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const mi = months.findIndex((m) => m.startsWith(s) && s.length >= 3);
  if (mi >= 0) {
    const y = now.getFullYear() - (mi > now.getMonth() ? 1 : 0);
    const start = new Date(y, mi, 1).getTime();
    return endOfDay ? new Date(y, mi + 1, 1).getTime() - 1 : start;
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // YYYY-MM-DD
  if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); return endOfDay ? d.getTime() + day - 1 : d.getTime(); }
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/); // M/D or M/D/YYYY
  if (m) {
    let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y += 2000;
    const d = new Date(y, +m[1] - 1, +m[2]);
    if (!m[3] && d.getTime() > now.getTime() + day) d.setFullYear(y - 1);
    return endOfDay ? d.getTime() + day - 1 : d.getTime();
  }
  return null;
}

function parseQuery(q) {
  const out = { terms: [], phrases: [], ro: null, vin: null, type: null, verdict: null, from: null, to: null, scoreOps: [], bare: [] };
  let s = String(q || "");
  s = s.replace(/"([^"]+)"/g, (_, p) => { out.phrases.push(p.toLowerCase()); return " "; });
  for (const tokRaw of s.split(/\s+/).filter(Boolean)) {
    const tok = tokRaw.toLowerCase();
    let m;
    if ((m = tok.match(/^score\s*(>=|<=|>|<|=)\s*(\d{1,3})$/) )) { out.scoreOps.push({ op: m[1], val: +m[2] }); continue; }
    if ((m = tok.match(/^(ro|vin|type|verdict|from|to|after|before|since|on)[:=](.+)$/))) {
      const [, k, v] = m;
      if (k === "ro") out.ro = v.replace(/\D/g, "");
      else if (k === "vin") out.vin = v.toUpperCase();
      else if (k === "type") out.type = v.startsWith("a") ? "appeal" : "review";
      else if (k === "verdict") out.verdict = v.replace(/-/g, "_");
      else if (k === "from" || k === "after" || k === "since") out.from = parseDateToken(v, false);
      else if (k === "to" || k === "before") out.to = parseDateToken(v, true);
      else if (k === "on") { out.from = parseDateToken(v, false); out.to = parseDateToken(v, true); }
      continue;
    }
    // bare-token smarts: pure digits look like an RO, 17-char alnum looks like a VIN
    if (/^\d{4,10}$/.test(tok)) out.bare.push({ kind: "ro", v: tok });
    else if (/^[a-hj-npr-z0-9]{17}$/i.test(tok) && /\d/.test(tok) && /[a-z]/i.test(tok)) out.bare.push({ kind: "vin", v: tok });
    out.terms.push(tok);
  }
  return out;
}

function searchHistory(qstr, opts) {
  const q = parseQuery(qstr);
  // merge UI dropdown filters (opts) with typed filters
  if (opts.type) q.type = opts.type;
  if (opts.verdict) q.verdict = opts.verdict;
  if (opts.days) { q.from = Date.now() - opts.days * 24 * 3600 * 1000; q.to = null; }

  const base = HISTORY.filter((r) => {
    if (q.type && r.type !== q.type) return false;
    if (q.verdict && String(r.verdict || "") !== q.verdict) return false;
    const t = Date.parse(r.ts);
    if (q.from && t < q.from) return false;
    if (q.to && t > q.to) return false;
    if (q.ro && String(r.ro || "").indexOf(q.ro) === -1) return false;
    if (q.vin && String(r.vin || "").toUpperCase().indexOf(q.vin) === -1) return false;
    for (const so of q.scoreOps) {
      const sc = r.score;
      if (sc == null) return false;
      if (so.op === ">" && !(sc > so.val)) return false;
      if (so.op === "<" && !(sc < so.val)) return false;
      if (so.op === ">=" && !(sc >= so.val)) return false;
      if (so.op === "<=" && !(sc <= so.val)) return false;
      if (so.op === "=" && !(sc === so.val)) return false;
    }
    return true;
  });

  const needles = [...q.terms, ...q.phrases];
  function matchAndScore(list, requireAll) {
    const scored = [];
    for (const r of list) {
      const blob = recordBlob(r);
      const top = ((r.ro || "") + " " + (r.vin || "") + " " + (r.vehicle || "") + " " + (r.summary || "")).toLowerCase();
      let hit = 0, score = 0;
      for (const n of needles) {
        const inTop = top.includes(n);
        const inBlob = inTop || blob.includes(n);
        if (inBlob) hit++;
        score += inTop ? 12 : (inBlob ? 3 : 0);
      }
      // bare-token smarts boost
      for (const b of q.bare) {
        if (b.kind === "ro" && String(r.ro || "") === b.v) score += 100;
        if (b.kind === "vin" && String(r.vin || "").toLowerCase() === b.v.toLowerCase()) score += 100;
      }
      const ok = requireAll ? hit === needles.length : hit > 0;
      if (needles.length === 0 || ok) scored.push({ r, score });
    }
    scored.sort((a, b) => (b.score - a.score) || (Date.parse(b.r.ts) - Date.parse(a.r.ts)));
    return scored;
  }

  let scored = matchAndScore(base, true);
  let fallback = false;
  if (!scored.length && needles.length > 1) {
    scored = matchAndScore(base, false); // OR fallback: any word matches
    fallback = scored.length > 0;
  }
  return { matched: scored.length, records: scored.map((x) => x.r), fallback, needles };
}

// ---------------------------------------------------------------------------
// Repair-category classification for the History page. Each saved record is
// binned into one of 15 categories from its own text (complaint/cause/correction,
// summary, ticket) so history is browsable by system — works for old records too.
// CAT_DEFS is in PRIORITY order (first keyword hit wins); CATEGORY_META is the
// display order shown in the dropdown.
// ---------------------------------------------------------------------------
const CAT_DEFS = [
  { id: "paint", kw: ["paint","clearcoat","clear coat","repaint","refinish","blend panel","orange peel","overspray","primer","paint blister","paint bubble","peeling clear","paint chip","paint defect"] },
  { id: "transmission", kw: ["transmission","transaxle","torque converter","valve body","shift solenoid","shift flare","harsh shift","slipping","clutch","mechatronic"," cvt ","10r80","10r60","6f35","6f50","powershift","gear selector","shudder","limp mode","no reverse","tcm"] },
  { id: "cooling", kw: ["coolant","radiator","water pump","thermostat","overheat","cooling fan","heater core","degas","antifreeze","engine temp","coolant leak"] },
  { id: "fuel", kw: ["fuel","injector","fuel pump","fuel tank","fuel rail","fuel line","throttle body","intake manifold","exhaust manifold","manifold","evap","purge valve","canister","hpfp","high pressure pump","fuel filter","fuel sender","fuel level","carburetor","fuel gauge"] },
  { id: "wheels", kw: ["wheel bearing","hub bearing","wheel hub","brake drum"," drum ","wheel stud","lug nut","lug bolt","wheel seal","hub assembly","hub unit"] },
  { id: "brakes", kw: ["brake","caliper","rotor","brake pad","brake shoe","master cylinder","brake booster","abs module","abs pump","brake line","parking brake","wheel cylinder","brake fluid","brake hose"] },
  { id: "rear_axle", kw: ["rear axle","differential","axle shaft","axle seal","pinion","ring gear","carrier bearing"," diff ","limited slip","rear diff","axle bearing"] },
  { id: "exhaust_rearsusp", kw: ["exhaust","muffler","catalytic","cat converter","tailpipe","resonator"," dpf"," def "," scr ","leaf spring","rear shock","rear strut","rear spring","rear suspension","shackle","rear sway"] },
  { id: "front_susp", kw: ["steering","tie rod","control arm","ball joint","strut","sway bar","stabilizer","rack and pinion","power steering","alignment","cv axle","cv joint","spindle","idler arm","pitman","front shock","front spring","coil spring","steering column","steering gear","knuckle","shock absorber","suspension","pulls to","wander"] },
  { id: "engine", kw: ["engine","cylinder","piston","crankshaft","camshaft","timing chain","timing belt","head gasket","oil pump","oil pan","oil leak","valve cover","cam phaser","lifter","rocker","spark plug","ignition coil","engine mount","turbo","supercharger"," vct ","cylinder head","oil consumption","knock","misfire","compression"," pcv ","engine noise"] },
  { id: "accessories", kw: ["accessory","radio","sync ","apim","navigation","infotainment","backup camera","rear camera","sunroof","moonroof","running board","trailer","hitch","bedliner","spray-in","remote start","seat heater","heated seat","floor liner","tonneau","step bar"] },
  { id: "body", kw: ["body","door","hood","fender","bumper","quarter panel","weatherstrip","window regulator","glass","windshield","mirror","latch","hinge","molding","trim panel","water leak","wind noise","rattle","door handle","tailgate","liftgate","sun visor","fit and finish","misaligned"] },
  { id: "electrical", kw: ["electrical","battery","alternator","starter","wiring","harness"," fuse","relay","module","pcm","ecm","bcm"," gem ","sensor","connector","ground ","short circuit","open circuit","headlight","taillight","bulb"," lamp","lock actuator","window motor","wiper motor","blower motor","tpms","no crank","dead battery","parasitic draw","warning light"] },
  { id: "maintenance", kw: ["oil change","tire rotation","scheduled maintenance","scheduled service","multi-point","multipoint","cabin filter","air filter","fluid flush","brake flush","wiper blade","the works","maintenance"] },
];
const CATEGORY_META = [
  { id: "wheels", label: "Wheels, hubs & drums" },
  { id: "brakes", label: "Brakes" },
  { id: "front_susp", label: "Front suspension & steering" },
  { id: "rear_axle", label: "Rear axle" },
  { id: "exhaust_rearsusp", label: "Exhaust & rear suspension" },
  { id: "engine", label: "Engine" },
  { id: "transmission", label: "Transmission" },
  { id: "cooling", label: "Cooling system" },
  { id: "fuel", label: "Fuel system & manifolds" },
  { id: "electrical", label: "Electrical" },
  { id: "accessories", label: "Accessories" },
  { id: "body", label: "Body" },
  { id: "paint", label: "Paint" },
  { id: "maintenance", label: "Maintenance" },
  { id: "other", label: "Other" },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORY_META.map((c) => [c.id, c.label]));
const CATEGORY_IDS = CATEGORY_META.map((c) => c.id);
const CAT_CACHE = new Map();
function categoryText(r) {
  // Classify from what was actually reported and fixed (the structured ticket
  // fields and the claim-ready cause/correction) — NOT the AI's free-form
  // summary/risks, which may mention systems it explicitly ruled out.
  const parts = [r.ticket];
  const res = r.result || {};
  if (res && res.rewrite) parts.push(res.rewrite.complaint, res.rewrite.cause, res.rewrite.correction);
  if (r.rejection) parts.push(r.rejection);
  return " " + parts.filter(Boolean).join(" \n ").toLowerCase() + " ";
}
function categorizeRepair(r) {
  if (CAT_CACHE.has(r.id)) return CAT_CACHE.get(r.id);
  const text = categoryText(r);
  let cat = "other";
  for (const def of CAT_DEFS) { if (def.kw.some((k) => text.includes(k))) { cat = def.id; break; } }
  CAT_CACHE.set(r.id, cat);
  return cat;
}
// Score bands for the History filter. Bottom band is "Under 60" so no score
// falls through a gap (covers 0-59).
const SCORE_BANDS = [
  { id: "90", label: "90 & up", min: 90, max: 100 },
  { id: "80", label: "80-89", min: 80, max: 89 },
  { id: "70", label: "70-79", min: 70, max: 79 },
  { id: "60", label: "60-69", min: 60, max: 69 },
  { id: "lt60", label: "Under 60", min: 0, max: 59 },
];
const SCORE_BAND_BY_ID = Object.fromEntries(SCORE_BANDS.map((b) => [b.id, b]));
function scoreBandOf(score) {
  if (score == null) return null;
  for (const b of SCORE_BANDS) { if (score >= b.min && score <= b.max) return b.id; }
  return null;
}

// ---------------------------------------------------------------------------
// Appeal drafter prompt
// ---------------------------------------------------------------------------
const APPEAL_PROMPT = `You are a veteran Ford dealership warranty administrator who writes claim appeals that get PAID. The user gives you (1) the rejection, denial, or chargeback notice from Ford and (2) the original repair order / claim, plus optional images or PDFs of the paperwork.

Respond with ONLY a JSON object (no markdown fences) in exactly this shape:

{
  "analysis": {
    "code": "the rejection/return message or chargeback code you identified (e.g. P62, or the OWS return reason), or 'unclear'",
    "reason": "1-2 sentences: why Ford rejected or charged back this claim, in plain English",
    "strength": "strong" | "moderate" | "weak",
    "recommendation": "one honest sentence: file the appeal now / gather the listed evidence first / this appeal is unlikely to win and why",
    "deadline": "the applicable appeal deadline and channel per the W&P manual (appeals within 45 days; two OWS appeals then one web appeal; WPAC parts chargebacks appeal via the web appeal, NOT in OWS)"
  },
  "arguments": [
    {"point": "a specific argument for why the claim should be paid, grounded ONLY in facts present in the provided documents", "citation": "the W&P manual section that supports it, e.g. 1.3.04, or 'documentation' if it rests on the RO itself"}
  ],
  "evidence": ["each document/photo/printout the dealer should attach or have ready, as a short imperative item"],
  "letter": "the complete appeal text, ready to paste into the OWS appeal comments or web appeal form. Professional, factual, firm, concise (under ~350 words). Structure: what the claim was, why it was returned/charged back, point-by-point rebuttal with W&P citations, what is attached, and the specific request (pay the claim / reverse the chargeback). Use bracketed placeholders like [ATTACH ALIGNMENT PRINTOUT] or [DEALER P&A CODE] for anything not present in the provided documents - NEVER invent facts, dates, readings, or documents."
}

Rules:
- Be honest. If the denial is correct per the W&P manual (e.g. a true wear item, real missing punch time, genuine modification), say so in the recommendation, set strength to "weak", and make the letter argue only what is genuinely arguable - or state plainly that the better path is fixing the documentation gap where allowed.
- Never coach the user to misrepresent anything. Appeals must rest on facts in the documents.
- Identify the specific chargeback code family when possible: P61 not defective, P62 damaged, P63 wrong part, P64 disassembled/incomplete, P65 over-repair, P66 not received, P67 non-genuine.
- If the input does not look like a rejection/chargeback plus a claim, say so in analysis.reason and keep the rest minimal.` +
  (FORD_REFERENCE
    ? `\n\nApply the dealership's distilled Ford Warranty & Policy Manual reference below and cite section numbers in your arguments.\n\n=== FORD WARRANTY & POLICY REFERENCE ===\n` + FORD_REFERENCE
    : "") +
  (OWS_REFERENCE
    ? `\n\nYou also have the dealership's distilled Ford OWS Claiming reference below — cite its rules where the rejection concerns claim coding, causal part / condition code, comments, time claiming, exception codes, or sublet entry.\n\n=== FORD OWS CLAIMING REFERENCE ===\n` + OWS_REFERENCE
    : "");

// --- Resilient upstream AI calls ---------------------------------------------
// Warranty reviews, appeals, and Story drafting all ride on the same outside AI
// provider. A brief provider blip (rate-limit, overload, a 5xx, or a dropped
// connection) should never reach an advisor as a hard error, so every call to
// that provider goes through anthropicMessages(): it retries transient failures
// a few times with exponential backoff + jitter before giving up. Permanent
// errors (bad request, auth) are returned immediately so real bugs aren't masked.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
function retryBackoffMs(attempt) {
  const base = Math.min(8000, 500 * Math.pow(2, attempt)); // 0.5s, 1s, 2s, 4s, 8s
  return Math.round(base * (0.7 + Math.random() * 0.6));    // ±30% jitter
}
async function postJSONWithRetry(url, headers, bodyObj, opts) {
  const retries = (opts && opts.retries != null) ? opts.retries : 3;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(bodyObj) });
      // Success, or a permanent error, or out of retries -> hand back to caller.
      if (r.ok || !RETRYABLE_STATUS.has(r.status) || attempt === retries) return r;
      const ra = Number(r.headers.get("retry-after"));
      const wait = ra > 0 ? Math.min(ra * 1000, 15000) : retryBackoffMs(attempt);
      try { console.warn(`upstream ${r.status}; retry ${attempt + 1}/${retries} in ${wait}ms`); } catch (_) {}
      await sleep(wait);
    } catch (e) {
      // Network-level failure (dropped connection, DNS, timeout).
      lastErr = e;
      if (attempt === retries) throw e;
      const wait = retryBackoffMs(attempt);
      try { console.warn(`upstream network error (${e && e.message}); retry ${attempt + 1}/${retries} in ${wait}ms`); } catch (_) {}
      await sleep(wait);
    }
  }
  if (lastErr) throw lastErr;
}
async function anthropicMessages(body, opts) {
  return postJSONWithRetry("https://api.anthropic.com/v1/messages", {
    "content-type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  }, body, opts);
}
// Turn an upstream/provider error into a calm, advisor-friendly, vendor-free
// message. The raw technical text still goes to the server logs.
function friendlyAiError(e) {
  const status = e && e.status;
  const msg = String((e && e.message) || "");
  const transient = (status && RETRYABLE_STATUS.has(status))
    || /overload|rate.?limit|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|temporar|too many requests|503|502|529/i.test(msg);
  if (transient) {
    return "The review service is busy right now — this is usually brief. Give it a moment and try again; your entries are still here.";
  }
  if (/unexpected format/i.test(msg)) {
    return "The review came back in an unexpected format. Please try again.";
  }
  return "Something went wrong running that request. Please try again in a moment.";
}

// --- Multi-provider failover -------------------------------------------------
// The warranty review, appeal drafting, and Story drafting jobs all produce a
// JSON result from a system prompt + user content (text + optional images/PDFs).
// We run each job through an ordered list of AI providers: the primary first,
// and if it errors OR returns something unparseable, we automatically fail over
// to a backup provider that does the same job. Combined with the per-call retry
// above, a single provider having a bad day no longer means downtime for the
// dealership. Each adapter returns { text, blocks } so callers can pull plain
// text (reviews/appeals) or the block list (Story sources).
const OPENAI_REVIEW_MODEL = process.env.OPENAI_REVIEW_MODEL || "gpt-4o";

async function providerAnthropic(job) {
  const content = [...fileBlocks(job.files), { type: "text", text: job.text }];
  const build = (withTemp) => {
    const b = { model: job.anthropicModel || "claude-sonnet-4-5", max_tokens: job.maxTokens || 4000, system: job.system, messages: [{ role: "user", content }] };
    if (withTemp && job.temperature != null) b.temperature = job.temperature;
    if (job.anthropicTools) b.tools = job.anthropicTools;
    return b;
  };
  let r = await anthropicMessages(build(true));
  let data = await r.json();
  // Some newer models reject `temperature`; retry once without it before failing.
  if (!r.ok && job.temperature != null && /temperature/i.test(data?.error?.message || "")) {
    r = await anthropicMessages(build(false));
    data = await r.json();
  }
  if (!r.ok) { const e = new Error(data?.error?.message || "Primary AI error " + r.status); e.status = r.status; throw e; }
  const blocks = data.content || [];
  return { text: blocks.map((c) => (typeof c.text === "string" ? c.text : "")).join(""), blocks };
}

function openaiUserContent(text, files) {
  const parts = [{ type: "text", text }];
  let droppedPdf = 0;
  for (const f of (files || []).slice(0, 4)) {
    const type = String(f.type || ""), data = String(f.data || "");
    if (!data || data.length > 14_000_000) continue;
    if (IMAGE_TYPES.includes(type)) parts.push({ type: "image_url", image_url: { url: "data:" + type + ";base64," + data } });
    else if (type === "application/pdf") droppedPdf++;
  }
  if (droppedPdf) parts[0].text += "\n\n[NOTE: " + droppedPdf + " PDF attachment(s) could not be included in this backup pass; weigh the typed details carefully.]";
  return parts;
}

async function providerOpenAI(job) {
  const body = {
    model: OPENAI_REVIEW_MODEL,
    temperature: job.temperature != null ? job.temperature : 0,
    max_tokens: job.maxTokens || 4000,
    messages: [
      { role: "system", content: job.system },
      { role: "user", content: openaiUserContent(job.text, job.files) },
    ],
  };
  if (job.wantJson) body.response_format = { type: "json_object" };
  const r = await postJSONWithRetry("https://api.openai.com/v1/chat/completions",
    { "content-type": "application/json", authorization: "Bearer " + OPENAI_API_KEY }, body);
  const data = await r.json();
  if (!r.ok) { const e = new Error((data && data.error && data.error.message) || "Backup AI error " + r.status); e.status = r.status; throw e; }
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  return { text, blocks: [{ type: "text", text }] };
}

// Ordered provider preference for structured jobs. `enabled` is evaluated lazily
// so a key added later (or a future third provider) is picked up automatically.
const REVIEW_PROVIDERS = [
  { key: "anthropic", run: providerAnthropic, enabled: () => !!ANTHROPIC_API_KEY },
  { key: "openai", run: providerOpenAI, enabled: () => !!OPENAI_API_KEY },
];

// Shared JSON extractor: strip accidental code fences, take the outermost object.
function parseJsonObject(text) {
  const t = String(text || "").trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("The AI returned an unexpected format. Try again.");
  return JSON.parse(t.slice(s, e + 1));
}

// Run a structured job across providers, failing over on error OR unparseable
// output (parse runs inside the try, so a garbage response also fails over).
// Returns { parsed, provider, failedOver }. Throws only if EVERY enabled
// provider fails.
async function runStructured(job, label, parse) {
  const providers = REVIEW_PROVIDERS.filter((p) => p.enabled());
  if (!providers.length) throw new Error("No AI provider is configured.");
  let lastErr;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    try {
      const res = await p.run(job);
      const parsed = parse(res);
      if (i > 0) { try { console.warn(`[failover] "${label}" served by backup provider "${p.key}"`); } catch (_) {} }
      return { parsed, provider: p.key, failedOver: i > 0 };
    } catch (e) {
      lastErr = e;
      try { console.error(`[provider ${p.key}] "${label}" failed:`, e && e.status, e && e.message); } catch (_) {}
    }
  }
  throw lastErr || new Error("All AI providers are unavailable.");
}

async function draftAppeal(rejection, ticket, files) {
  const blocks = fileBlocks(files);
  const intro = blocks.length
    ? "Attached above: " + blocks.length + " file(s) of the claim paperwork.\n\n"
    : "";
  const job = {
    system: APPEAL_PROMPT,
    text: intro + "=== REJECTION / CHARGEBACK NOTICE ===\n" + rejection + "\n\n=== ORIGINAL REPAIR ORDER / CLAIM ===\n" + (ticket || "(not provided)"),
    files, maxTokens: 4000, temperature: 0, wantJson: true,
  };
  const { parsed } = await runStructured(job, "appeal draft", (res) => parseJsonObject(res.text));
  return parsed;
}

// RO style: the claim-ready write-up is always ALL CAPS
function upcaseRewrite(out) {
  if (out && out.rewrite) {
    for (const k of ["complaint", "cause", "correction"]) {
      if (out.rewrite[k]) out.rewrite[k] = String(out.rewrite[k]).toUpperCase();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic scoring. The AI returns findings (completeness + risks); the
// SCORE is computed here by a fixed rulebook so the same findings always
// produce the same number, and we can explain every point.
// ---------------------------------------------------------------------------
function itemWeight(name) {
  const n = String(name || "").toLowerCase();
  if (/causal|cause/.test(n)) return { missing: 12, unclear: 6 };
  if (/correction/.test(n)) return { missing: 10, unclear: 5 };
  if (/complaint|concern/.test(n)) return { missing: 8, unclear: 4 };
  if (/labor|punch|\btime\b/.test(n)) return { missing: 8, unclear: 4 };
  if (/diagnos|test/.test(n)) return { missing: 8, unclear: 4 };
  if (/hard card|signature|authoriz|consistency/.test(n)) return { missing: 8, unclear: 4 };
  if (/vin|vehicle/.test(n)) return { missing: 5, unclear: 2 };
  if (/mileage|date/.test(n)) return { missing: 5, unclear: 2 };
  return { missing: 6, unclear: 3 };
}
const RISK_WEIGHT = { critical: 15, serious: 8, warning: 3 };

function computeScore(review) {
  const items = Array.isArray(review.completeness) ? review.completeness : [];
  const risks = Array.isArray(review.risks) ? review.risks : [];
  const breakdown = [];
  let deductions = 0;

  for (const it of items) {
    const st = String(it.status || "").toLowerCase();
    if (st === "missing" || st === "unclear") {
      const w = itemWeight(it.item)[st];
      if (w) {
        deductions += w;
        breakdown.push({
          points: -w,
          severity: st === "missing" ? "missing" : "unclear",
          label: (st === "missing" ? "Missing: " : "Unclear: ") + it.item,
          fix: it.note || "Document this clearly on the repair order.",
        });
      }
    }
  }
  for (const rk of risks) {
    const sev = String(rk.severity || "warning").toLowerCase();
    const w = RISK_WEIGHT[sev] != null ? RISK_WEIGHT[sev] : 3;
    deductions += w;
    breakdown.push({
      points: -w,
      severity: sev,
      label: sev.toUpperCase() + " risk: " + (rk.flag || ""),
      fix: rk.detail || "",
    });
  }

  const score = Math.max(0, Math.min(100, 100 - deductions));
  const hasCritical = risks.some((r) => String(r.severity).toLowerCase() === "critical");
  const hasSerious = risks.some((r) => String(r.severity).toLowerCase() === "serious");
  let verdict;
  if (hasCritical) verdict = "high_risk";
  else if (score >= 80 && !hasSerious) verdict = "ready";
  else if (score >= 55) verdict = "needs_work";
  else verdict = "high_risk";

  breakdown.sort((a, b) => a.points - b.points); // biggest deductions first
  return { score, verdict, breakdown };
}

// Finalize an AI review: uppercase the write-up AND compute the deterministic score.
function finalizeReview(out) {
  upcaseRewrite(out);
  const s = computeScore(out);
  out.score = s.score;
  out.verdict = s.verdict;
  out.scoreBreakdown = s.breakdown;
  return out;
}

async function reviewTicket(ticket, recallInfo, files, claimType, rulesOverride) {
  if (MOCK) return finalizeReview(JSON.parse(JSON.stringify(MOCK_REVIEW)));
  const blocks = fileBlocks(files);
  const intro = blocks.length
    ? "Attached above: " + blocks.length + " file(s) showing the physical repair-order hard card (time punches, initials, signatures). Cross-check them against the typed ticket below.\n\n"
    : "";
  const job = {
    system: SYSTEM_PROMPT + claimTypeAddendum(claimType) + (rulesOverride || ""),
    text: intro + "Review this warranty ticket:\n\n" + ticket + recallContext(recallInfo),
    files, maxTokens: 4000, temperature: 0, wantJson: true,
  };
  const { parsed } = await runStructured(job, "warranty review", (res) => parseJsonObject(res.text));
  return finalizeReview(parsed);
}

// ---------------------------------------------------------------------------
// Repair Story Assistant (entry-level tool): turn a tech's rough notes into a
// dealer-grade repair story for a CUSTOMER-PAY repair. No warranty machinery -
// works for any make and any shop (dealer, independent, aftermarket).
// ---------------------------------------------------------------------------
// The Story prompt is assembled per request from the technician's chosen options.
// Everything that "strengthens" a story is OPT-IN, so the writer decides how much
// documentation to add and stays responsible for it — nothing is forced.
//   opts.search   -> look up the documented test procedure & spec online (adds cited sources)
//   opts.readings -> allow SUGGESTED failure readings (with [CONFIRM] markers) the writer verifies
function storySystem(opts) {
  opts = opts || {};
  let s = `You are a master service writer at a top franchise dealership. A technician — who may be non-technical or write in rough shorthand — gives you notes about a CUSTOMER-PAY repair (this is NOT a warranty claim). Turn their notes into clean, professional, dealer-grade repair documentation.

Return ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:
{
  "complaint": "the customer's concern, written cleanly and professionally - what they reported / why they came in",
  "cause": "what the technician found and diagnosed, written professionally and specifically but readable",
  "correction": "what was done to correct it: parts replaced or serviced, plus any verification or road test the tech mentioned",
  "customer": "a short, friendly, plain-English explanation for the customer (2-4 sentences) - what was wrong and what you did, no jargon or part numbers",
  "readings": [ { "label": "what is measured", "suggested": "a failure-consistent value to CONFIRM", "spec": "the in-spec value/range" } ],
  "tips": ["OPTIONAL: 1-3 short suggestions of details that would strengthen the write-up; empty array if none"]
}

Core rules:
- This is a CUSTOMER-PAY repair. Do NOT mention warranty, causal parts, condition codes, labor operations, prior approval, or any manufacturer claim rules. Keep it universal to any vehicle make and any shop.
- Be concise and honest. Professional polish is the goal; do not pad or overstate the work.`;

  if (opts.readings) {
    s += `

TESTING & READINGS (enabled by the writer):
- Write the cause and correction as a professional diagnosis: name the test performed, the specification the part is measured against, the reading obtained, and the conclusion that confirms the failure.
- If the technician gave a real reading, use it. If they did NOT, you MAY suggest a typical FAILURE-consistent value so the story reads professionally — but you MUST (a) list every suggested number in the "readings" array, and (b) write it in the story with a confirm marker in brackets, e.g. "measured [CONFIRM: 11.9 V] against spec 13.5-14.8 V". Never present a suggested number as if it were actually measured; the writer replaces these before submitting.`;
  } else {
    s += `

NO INVENTED NUMBERS (the writer chose a plain write-up):
- CRITICAL: Use ONLY the facts and numbers the technician actually wrote. Do NOT invent, suggest, estimate, or add ANY measurement, reading, test value, or numeric specification the technician did not provide. Do NOT add [CONFIRM] placeholders.
- The "readings" array MUST be empty. Write the cause and correction cleanly and professionally from exactly what the tech gave you. If a measurement or test would have strengthened it, you may note that as a suggestion in "tips" — but never place a number in the story that the technician did not write.`;
  }

  if (opts.search) {
    s += `

WEB LOOKUP (enabled by the writer):
- You have a web_search tool. Use it to look up the documented diagnostic procedure and the manufacturer / industry specification for the component, and base the procedure${opts.readings ? " and spec numbers" : ""} you describe on what you actually find.${opts.readings ? "" : " Because suggested numbers are turned off, do NOT insert specific numeric spec values into the story — describe the test qualitatively and let the cited sources carry the numbers."}`;
  } else {
    s += `

NO WEB LOOKUP:
- Do not use any tools. Write from the technician's notes and general professional knowledge. Do not add web citations.`;
  }

  s += `

IMPORTANT OUTPUT RULE: ${opts.search ? "You may use the search tool first, but your " : "Your "}FINAL message must be ONLY the JSON object above — no preamble, no commentary, no markdown fences. Just the raw JSON, starting with { and ending with }.`;
  return s;
}

// Collect the web sources behind a story. Pulls from BOTH (a) inline text
// citations and (b) web_search_tool_result blocks — the latter capture what was
// actually searched even when the model's final answer is a JSON blob that
// carries no citation annotations.
function collectStorySources(content) {
  const seen = new Set(), out = [];
  const add = (url, title) => {
    if (!url || seen.has(url) || out.length >= 8) return;
    seen.add(url);
    out.push({ url: String(url), title: String(title || url).slice(0, 160) });
  };
  for (const block of content || []) {
    if (!block) continue;
    // (a) inline citations attached to text blocks
    for (const c of block.citations || []) add(c && (c.url || c.source), c && (c.title || c.document_title));
    // (b) web_search_tool_result blocks: { content: [ { type:"web_search_result", url, title } ] }
    if (block.type === "web_search_tool_result") {
      const results = Array.isArray(block.content) ? block.content : [];
      for (const r of results) add(r && r.url, r && r.title);
    }
  }
  return out;
}

function normalizeStory(o, sources) {
  const readings = Array.isArray(o.readings) ? o.readings.slice(0, 8).map((r) => ({
    label: String((r && r.label) || "").slice(0, 200),
    suggested: String((r && r.suggested) || "").slice(0, 120),
    spec: String((r && r.spec) || "").slice(0, 200),
  })).filter((r) => r.label) : [];
  return {
    complaint: String(o.complaint || ""), cause: String(o.cause || ""), correction: String(o.correction || ""),
    customer: String(o.customer || ""),
    readings,
    tips: Array.isArray(o.tips) ? o.tips.slice(0, 3).map(String) : [],
    sources: Array.isArray(sources) ? sources : [],
  };
}

function parseStoryJSON(content) {
  let text = (content || []).map((c) => (typeof c.text === "string" ? c.text : "")).join("").trim();
  text = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("The AI returned an unexpected format. Try again.");
  return JSON.parse(text.slice(s, e + 1));
}

// The Story engine can run on its own model so we can point it at one that
// supports the web_search tool without touching the warranty reviewer.
const STORY_MODEL = process.env.STORY_MODEL || "claude-sonnet-4-5";
async function callStoryAPI(input, system, useSearch, withTemp = true) {
  const body = {
    model: STORY_MODEL, max_tokens: 3500,
    system, messages: [{ role: "user", content: input }],
  };
  // Newer models (Sonnet 5+) deprecated `temperature`; include it only when accepted.
  if (withTemp) body.temperature = 0.4;
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
  const r = await anthropicMessages(body);
  const data = await r.json();
  if (!r.ok) {
    const msg = data?.error?.message || "AI service error " + r.status;
    // If the model rejects `temperature`, retry once without it.
    if (withTemp && /temperature/i.test(msg)) return callStoryAPI(input, system, useSearch, false);
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return data;
}

// --- Second-pass refiner (ChatGPT / OpenAI) --------------------------------
// Story is a two-model pipeline: Claude drafts (with live web search + sources),
// then ChatGPT refines the writing AND fact-checks it. The refiner is OPTIONAL:
// if OPENAI_API_KEY is unset or the call fails for any reason, we return Claude's
// draft unchanged so Story never breaks.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_STORY_MODEL = process.env.OPENAI_STORY_MODEL || "gpt-4o";

async function callOpenAI(system, user) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + OPENAI_API_KEY },
    body: JSON.stringify({
      model: OPENAI_STORY_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || "OpenAI error " + r.status;
    const e = new Error(msg); e.status = r.status; throw e;
  }
  const txt = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  return JSON.parse(txt);
}

function openaiRefineSystem(opts) {
  opts = opts || {};
  let s = `You are a meticulous automotive service-writing EDITOR and FACT-CHECKER at a dealership. You receive (1) a technician's ORIGINAL notes for a CUSTOMER-PAY repair and (2) a DRAFT write-up produced from those notes by another writer. Improve ONLY the writing quality — clarity, professional tone, concision, grammar — WITHOUT changing the technical meaning and WITHOUT adding any new facts.

Return ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:
{
  "complaint": "the customer's concern, cleaned up",
  "cause": "what was found/diagnosed, professional and specific but readable",
  "correction": "what was done to correct it",
  "customer": "a short, friendly, plain-English explanation for the customer (2-4 sentences, no jargon or part numbers)",
  "tips": ["OPTIONAL 1-3 short suggestions to strengthen the write-up; empty array if none"]
}

Hard rules:
- You are a checker, NOT an author. Do NOT introduce any measurement, reading, test value, part number, or numeric specification that is not already present in the draft.
- Preserve the CUSTOMER-PAY framing: never add warranty, claim, causal-part, condition-code, labor-operation, or manufacturer-approval language.
- Keep "customer" plain-English and friendly, with no jargon or part numbers.`;
  if (opts.readings) {
    s += `
- The draft may contain confirm markers like "[CONFIRM: 11.9 V]". Keep every such marker EXACTLY as written — do not remove the brackets, change the number, or present a suggested value as an actual measurement.`;
  } else {
    s += `
- FACT-CHECK (the writer chose a plain write-up with NO invented numbers): if the draft contains ANY measurement, reading, or numeric specification that does not appear in the technician's ORIGINAL notes, REMOVE that number and rewrite the sentence qualitatively (e.g. "measured below specification"). The final text must contain no numbers the technician did not provide.`;
  }
  return s;
}

// Refine a Claude draft with ChatGPT. Keeps the draft's readings and sources
// (the refiner never invents numbers or citations); only the prose is improved.
async function refineStory(draft, input, opts) {
  if (!OPENAI_API_KEY || MOCK) return draft;
  try {
    const user = "TECHNICIAN'S ORIGINAL NOTES:\n" + input + "\n\nDRAFT TO REFINE (JSON):\n"
      + JSON.stringify({ complaint: draft.complaint, cause: draft.cause, correction: draft.correction, customer: draft.customer, tips: draft.tips });
    const o = await callOpenAI(openaiRefineSystem(opts), user);
    return {
      complaint: String(o.complaint || draft.complaint),
      cause: String(o.cause || draft.cause),
      correction: String(o.correction || draft.correction),
      customer: String(o.customer || draft.customer),
      readings: draft.readings,
      tips: Array.isArray(o.tips) ? o.tips.slice(0, 3).map(String) : draft.tips,
      sources: draft.sources,
      refined: true,
    };
  } catch (e) {
    try { console.error("Story refine (OpenAI) failed, using Claude draft:", e && e.message); } catch (_) {}
    return draft;
  }
}

async function storyWrite(input, opts) {
  opts = opts || {};
  if (MOCK) {
    const base = {
      complaint: "Customer states the battery warning light is on and the vehicle nearly stalled.",
      cause: opts.readings
        ? "Performed a charging-system test. Alternator output measured [CONFIRM: 11.9 V] at idle against a specification of 13.5-14.8 V, confirming the alternator has failed."
        : "Tested the charging system and found the alternator was not charging the battery. Confirmed the alternator had failed internally.",
      correction: "Replaced the alternator, cleaned the battery terminals, and road-tested; warning light off.",
      customer: "Your battery light was on because the part that keeps your battery charged had stopped working. We replaced it and confirmed the system is charging correctly.",
      readings: opts.readings ? [{ label: "Alternator charging output at idle", suggested: "11.9 V", spec: "13.5-14.8 V" }] : [],
      tips: [],
    };
    return normalizeStory(base, opts.search ? [{ url: "https://example.com/alternator-test", title: "Charging System Diagnosis" }] : []);
  }

  const system = storySystem(opts);
  // Draft with automatic failover. Preference order:
  //   1) primary AI with live web search (best — adds cited sources)
  //   2) primary AI without search (still a full draft)
  //   3) backup AI without search (keeps Story working during a primary outage)
  // Whichever lands first wins; the optional refine pass runs afterward.
  const attempts = [];
  if (opts.search) attempts.push(() => providerAnthropic({ system, text: input, maxTokens: 3500, temperature: 0.4, anthropicTools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] }));
  attempts.push(() => providerAnthropic({ system, text: input, maxTokens: 3500, temperature: 0.4 }));
  if (OPENAI_API_KEY) attempts.push(() => providerOpenAI({ system, text: input, maxTokens: 3500, temperature: 0.4, wantJson: true }));
  let draft = null, lastErr = null;
  for (const attempt of attempts) {
    try {
      const res = await attempt();
      draft = normalizeStory(parseStoryJSON(res.blocks), collectStorySources(res.blocks));
      break;
    } catch (e) {
      lastErr = e;
      try { console.error("Story draft attempt failed:", e && e.message); } catch (_) {}
    }
  }
  if (!draft) throw lastErr || new Error("The Story service is unavailable right now. Please try again in a moment.");
  // Optional second-pass refine & fact-check (returns the draft as-is on any failure).
  return await refineStory(draft, input, opts);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "45mb" }));
app.use(express.urlencoded({ extended: false }));

const LOGIN_PAGE = fs.readFileSync(path.join(__dirname, "public", "login.html"), "utf8");
const MFA_PAGE = fs.readFileSync(path.join(__dirname, "public", "mfa.html"), "utf8");

// ---------------------------------------------------------------------------
// Resources: the reference PDF manuals, stored on the persistent disk and
// served ONLY behind the access code (Ford copyrighted material — never public).
// Populated once via a token-gated upload; the admin token is derived from the
// access code, so no extra secret is needed.
// ---------------------------------------------------------------------------
const RESOURCES_DIR = path.join(HISTORY_DIR, "resources");
try { fs.mkdirSync(RESOURCES_DIR, { recursive: true }); } catch {}
const RESOURCE_ADMIN_TOKEN = crypto.createHmac("sha256", AUTH_SECRET).update("resource-admin").digest("hex");
const RESOURCES = [
  { key: "wp",  file: "Ford_Warranty_and_Policy_Manual.pdf",            title: "Warranty & Policy Manual",                   topic: "Warranty & Policy",            desc: "Ford's Warranty & Policy Manual (USA) — coverage periods, documentation standards, prior approval, time recording, and chargebacks." },
  { key: "ows", file: "OWS_Claiming_User_Guide.pdf",                    title: "OWS Claiming User Guide",                    topic: "Claim Submission (OWS)",       desc: "How to prepare, code, and submit a warranty claim in the Online Warranty System — required fields, causal parts, condition codes, exception codes." },
  { key: "esp", file: "Ford_Lincoln_Protect_Administration_Manual.pdf", title: "Ford/Lincoln Protect Administration Manual", topic: "Extended Service Plans (ESP)", desc: "ESP / service-contract plans — coverage, deductibles, prior approval, and ESP-specific claim rules." },
];
const RESOURCE_BY_KEY = Object.fromEntries(RESOURCES.map((r) => [r.key, r]));
function resourcePath(r) { return path.join(RESOURCES_DIR, r.file); }
function resourceMeta() {
  return RESOURCES.map((r) => {
    let bytes = 0, available = false;
    try { bytes = fs.statSync(resourcePath(r)).size; available = bytes > 0; } catch {}
    return { key: r.key, title: r.title, topic: r.topic, desc: r.desc, file: r.file, available, bytes };
  });
}

// Dealership logo, embedded so every page (incl. login) can show it without an extra file.
let LOGO_B64 = "";
try { LOGO_B64 = require("./logo.js"); } catch (e) { console.log("logo.js not found - logo disabled"); }
app.get("/logo.png", (_req, res) => {
  if (!LOGO_B64) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.end(Buffer.from(LOGO_B64, "base64"));
});

app.get("/healthz", (_req, res) => res.send("ok"));

app.post("/login", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  if (tooManyAttempts(String(ip))) {
    return res.status(429).send(LOGIN_PAGE.replace("<!--MSG-->", "Too many attempts. Try again in a few minutes."));
  }
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const legacyCode = String(req.body.code || "");
  let user = null;
  if (email && password) {
    const u = userByEmail(email);
    if (u && u.active && verifyPassword(password, u.salt, u.hash)) user = u;
  }
  // Legacy: the old bare access code still logs the owner into the default store.
  if (!user && legacyCode) {
    const a = Buffer.from(legacyCode), b = Buffer.from(ACCESS_CODE);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) user = userByEmail(OWNER_EMAIL);
  }
  if (!user) {
    return res.status(401).send(LOGIN_PAGE.replace("<!--MSG-->", "Email or password isn't right — try again."));
  }
  const store = storeById(user.storeId);
  if (!store) return res.status(403).send(LOGIN_PAGE.replace("<!--MSG-->", "Your store isn't set up yet. Contact your administrator."));
  if (!store.active && user.role !== "owner") {
    return res.status(403).send(LOGIN_PAGE.replace("<!--MSG-->", "This store's access is inactive. Contact your administrator."));
  }
  // Password is correct — but don't hand out a full session yet. Start the MFA
  // step (enroll on first login, otherwise verify). Session issues only after
  // the second factor passes. The break-glass env var skips this entirely.
  if (MFA_REQUIRED) return startMfaChallenge(res, user, store);
  issueSession(res, user, store);
  res.redirect("/");
});

// Issue the real, MFA-satisfied session cookie (marker m:1) and clear any
// pending MFA-challenge cookie.
function issueSession(res, user, store) {
  const token = signSession({ uid: user.id, sid: store.id, iat: Date.now(), m: 1 });
  res.setHeader("Set-Cookie", [
    `wtr_sess=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${180 * 24 * 3600}${process.env.RENDER ? "; Secure" : ""}`,
    `wtr_mfa=; HttpOnly; Path=/; Max-Age=0`,
  ]);
}
// Begin an MFA challenge: set a short-lived signed cookie identifying the user
// (plus a pending TOTP secret if they haven't enrolled yet) and send them to
// the /mfa page.
function startMfaChallenge(res, user, store) {
  const enrolled = !!(user.mfa && user.mfa.enrolled);
  const payload = { uid: user.id, sid: store.id, iat: Date.now() };
  if (!enrolled) payload.sec = newTotpSecret();
  const tok = signMfa(payload);
  res.setHeader("Set-Cookie", `wtr_mfa=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${11 * 60}${process.env.RENDER ? "; Secure" : ""}`);
  res.redirect("/mfa");
}

app.get("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", [
    "wtr_sess=; HttpOnly; Path=/; Max-Age=0",
    "wtr_auth=; HttpOnly; Path=/; Max-Age=0",
    "wtr_mfa=; HttpOnly; Path=/; Max-Age=0",
  ]);
  res.redirect("/");
});

// Shared front-end branding + nav script for every app page. Applies the
// store's logo/name, injects the Story/Account/Console links, and HIDES the
// tools a store's plan doesn't include (server-side gating is the real guard).
const APPBRAND_JS = fs.readFileSync(path.join(__dirname, "public", "appbrand.js"), "utf8");
app.get("/appbrand.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(APPBRAND_JS);
});
// Shared "Decode VIN" widget (auto-wires any [data-vin-decode] button on a page).
const VIN_JS = fs.readFileSync(path.join(__dirname, "public", "vin.js"), "utf8");
app.get("/vin.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(VIN_JS);
});

// Serve a store's logo (public - logos are not sensitive). "builtin" = the
// bundled Whiteface logo; otherwise the store's uploaded file.
app.get("/store-logo/:sid", (req, res) => {
  const store = storeById(req.params.sid);
  if (store && store.logoKey === "builtin" && LOGO_B64) {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.end(Buffer.from(LOGO_B64, "base64"));
  }
  if (store && store.logoKey && store.logoKey !== "builtin") {
    const p = path.join(STORE_LOGOS_DIR, store.logoKey);
    if (fs.existsSync(p)) {
      res.setHeader("Content-Type", store.logoType || "image/png");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return fs.createReadStream(p).pipe(res);
    }
  }
  res.status(404).end();
});

// Admin-only upload to populate a resource PDF onto the disk. Token-gated so it
// does not require a login cookie; used once to load the manuals.
app.put("/resources/upload/:key", express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "60mb" }), (req, res) => {
  if (!RESOURCE_ADMIN_TOKEN || req.get("x-admin-token") !== RESOURCE_ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  const r = RESOURCE_BY_KEY[req.params.key];
  if (!r) return res.status(404).json({ error: "unknown resource key" });
  if (!req.body || !req.body.length) return res.status(400).json({ error: "empty body" });
  try { fs.writeFileSync(resourcePath(r), req.body); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, key: r.key, bytes: req.body.length });
});

// ---------------------------------------------------------------------------
// MFA challenge — these routes must be reachable AFTER password success but
// BEFORE a full session exists, so they sit ahead of the auth gate below.
// ---------------------------------------------------------------------------
const MFA_PAGES = ["/", "/appeal", "/history", "/resources", "/reports", "/console", "/account", "/story", "/status", "/support", "/insights"];
function mfaChallenge(req) {
  const tok = cookieVal(req, "wtr_mfa");
  const c = tok ? readMfa(tok) : null;
  if (!c || !c.uid) return null;
  const user = userById(c.uid), store = storeById(c.sid);
  if (!user || !store || !user.active) return null;
  return { c, user, store };
}
app.get("/mfa", (req, res) => {
  if (!MFA_REQUIRED) return res.redirect("/");
  if (!mfaChallenge(req)) return res.redirect("/");
  res.send(MFA_PAGE);
});
app.get("/api/mfa/state", (req, res) => {
  const ch = mfaChallenge(req);
  if (!ch) return res.status(401).json({ error: "expired", expired: true });
  const enrolled = !!(ch.user.mfa && ch.user.mfa.enrolled);
  if (enrolled) return res.json({ stage: "verify", email: ch.user.email });
  const secret = ch.c.sec;
  if (!secret) return res.status(401).json({ error: "expired", expired: true });
  res.json({ stage: "enroll", email: ch.user.email, issuer: MFA_ISSUER, secret, otpauth: otpauthURI(secret, ch.user.email) });
});
app.post("/api/mfa/verify", (req, res) => {
  const ch = mfaChallenge(req);
  if (!ch) return res.status(401).json({ error: "Your sign-in step timed out. Please sign in again.", expired: true });
  const code = String((req.body && req.body.code) || "").trim();
  const enrolled = !!(ch.user.mfa && ch.user.mfa.enrolled);
  if (enrolled) {
    let ok = totpVerify(ch.user.mfa.secret, code);
    let usedBackup = false;
    if (!ok && Array.isArray(ch.user.mfa.backup) && ch.user.mfa.backup.length) {
      const h = hashBackup(code);
      const idx = ch.user.mfa.backup.indexOf(h);
      if (idx >= 0) { ok = true; usedBackup = true; ch.user.mfa.backup.splice(idx, 1); saveUsers(); }
    }
    if (!ok) return res.status(401).json({ error: "That code isn't right. Check your authenticator app and try again — or use a backup code." });
    issueSession(res, ch.user, ch.store);
    return res.json({ ok: true, usedBackup, backupRemaining: Array.isArray(ch.user.mfa.backup) ? ch.user.mfa.backup.length : 0 });
  }
  // Enrollment: confirm the app is set up correctly by verifying one live code,
  // then persist the secret and hand back one-time backup codes (shown once).
  const secret = ch.c.sec;
  if (!secret) return res.status(401).json({ error: "Enrollment timed out. Please sign in again.", expired: true });
  if (!totpVerify(secret, code)) return res.status(401).json({ error: "That code isn't right yet. Wait for a fresh 6-digit code in your app and try again." });
  const backupPlain = genBackupCodes(10);
  ch.user.mfa = { enrolled: true, secret, backup: backupPlain.map(hashBackup), enrolledAt: new Date().toISOString() };
  saveUsers();
  issueSession(res, ch.user, ch.store);
  res.json({ ok: true, enrolled: true, backupCodes: backupPlain });
});

app.use((req, res, next) => {
  const ctx = sessionCtx(req);
  if (ctx) { req.ctx = ctx; return next(); }
  if (MFA_PAGES.includes(req.path) && req.method === "GET") {
    return res.send(LOGIN_PAGE.replace("<!--MSG-->", ""));
  }
  return res.status(401).json({ error: "not logged in" });
});

// MFA enforcement: a session is only fully trusted once the second factor was
// satisfied (marker m:1). Pre-MFA sessions and the legacy access-code grace
// path carry no marker, so they get pushed through enroll/verify before the
// app opens. Disabled entirely when MFA_DISABLED is set (break-glass).
app.use((req, res, next) => {
  if (!MFA_REQUIRED || !req.ctx) return next();
  if (req.ctx.sess && req.ctx.sess.m === 1) return next();
  if (!mfaChallenge(req)) {
    const enrolled = !!(req.ctx.user.mfa && req.ctx.user.mfa.enrolled);
    const payload = { uid: req.ctx.user.id, sid: req.ctx.store.id, iat: Date.now() };
    if (!enrolled) payload.sec = newTotpSecret();
    const tok = signMfa(payload);
    res.setHeader("Set-Cookie", `wtr_mfa=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${11 * 60}${process.env.RENDER ? "; Secure" : ""}`);
  }
  if (req.method === "GET" && MFA_PAGES.includes(req.path)) return res.redirect("/mfa");
  return res.status(401).json({ error: "mfa_required", mfa: true });
});

// --- Subscription-tier enforcement (server-side; cannot be bypassed by URL) --
// Each store only reaches the tools its plan includes. This is the real gate -
// hiding nav links is cosmetic; THIS is what stops anyone getting tools free.
function featureForPath(p) {
  if (p === "/story" || p === "/api/story") return "story";
  if (p === "/" || p === "/appeal" || p === "/history" || p === "/resources") return "warranty";
  if (p === "/insights" || p.indexOf("/api/insights") === 0) return "warranty";
  if (p === "/api/review" || p === "/api/appeal" || p === "/api/resources") return "warranty";
  if (p.indexOf("/api/history") === 0 || p.indexOf("/resources/file") === 0) return "warranty";
  // /reports and /api/reports are available on every tier; each store's entitlement
  // to specific datasets is enforced inside the report handlers (allowedDatasets).
  return null; // shared (account, me, owner, logos, etc.) - never gated
}
app.use((req, res, next) => {
  const feat = featureForPath(req.path);
  if (!feat || !req.ctx) return next();
  const f = storeFeatures(req.ctx.store);
  if (f[feat]) return next();
  const home = f.warranty ? "/" : (f.story ? "/story" : "/account");
  if (req.method === "GET" && req.path.indexOf("/api/") !== 0 && req.path.indexOf("/resources/file") !== 0) {
    if (req.path === home) return next();
    return res.redirect(home);
  }
  return res.status(403).json({ error: "This isn't included in your plan." });
});

// Session info for per-store branding (logo, name) on every page.
app.get("/api/me", (req, res) => {
  const { user, store } = req.ctx;
  res.json({
    user: { email: user.email, name: user.name, role: user.role },
    store: {
      id: store.id, name: store.name, city: store.city, slug: store.slug,
      active: store.active !== false,
      features: storeFeatures(store),
      logoUrl: "/store-logo/" + store.id + "?v=" + (store.logoVer || 0),
    },
  });
});

// --- Owner console API (seam for the Phase 2 admin UI; owner-only) ----------
app.get("/api/owner/stores", requireOwner, (_req, res) => {
  res.json({
    stores: STORES.map((s) => ({ id: s.id, name: s.name, city: s.city, slug: s.slug, active: s.active !== false, plan: s.plan, features: storeFeatures(s), hasLogo: !!s.logoKey, users: USERS.filter((u) => u.storeId === s.id).length })),
    users: USERS.map((u) => ({ id: u.id, storeId: u.storeId, email: u.email, name: u.name, role: u.role, active: u.active !== false, mfa: !!(u.mfa && u.mfa.enrolled) })),
  });
});
app.post("/api/owner/stores/:id/features", requireOwner, (req, res) => {
  const s = storeById(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown store" });
  const b = req.body || {};
  s.features = s.features || { story: true, warranty: false };
  if (typeof b.story === "boolean") s.features.story = b.story;
  if (typeof b.warranty === "boolean") s.features.warranty = b.warranty;
  saveStores();
  res.json({ ok: true, features: storeFeatures(s) });
});
app.post("/api/owner/stores", requireOwner, (req, res) => {
  const { name, city, slug } = req.body || {};
  if (!String(name || "").trim()) return res.status(400).json({ error: "Store name is required." });
  const s = createStore({ name, city, slug });
  res.json({ store: s });
});
app.post("/api/owner/stores/:id/active", requireOwner, (req, res) => {
  const s = storeById(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown store" });
  s.active = !!(req.body && req.body.active);
  saveStores();
  res.json({ ok: true, active: s.active });
});
app.put("/api/owner/stores/:id/logo", requireOwner, express.raw({ type: ["image/png", "image/jpeg", "image/webp", "application/octet-stream"], limit: "6mb" }), (req, res) => {
  const s = storeById(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown store" });
  if (!req.body || !req.body.length) return res.status(400).json({ error: "empty body" });
  const ct = String(req.get("content-type") || "");
  const ext = ct.includes("jpeg") ? ".jpg" : ct.includes("webp") ? ".webp" : ".png";
  const key = s.id + ext;
  try { fs.writeFileSync(path.join(STORE_LOGOS_DIR, key), req.body); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  s.logoKey = key; s.logoType = ct.includes("jpeg") ? "image/jpeg" : ct.includes("webp") ? "image/webp" : "image/png";
  s.logoVer = (s.logoVer || 0) + 1; saveStores();
  res.json({ ok: true, logoUrl: "/store-logo/" + s.id + "?v=" + s.logoVer });
});
app.post("/api/owner/users", requireOwner, (req, res) => {
  const { storeId, email, password, name, role } = req.body || {};
  if (!storeById(storeId)) return res.status(400).json({ error: "unknown store" });
  try {
    const u = createUser({ storeId, email, password, name, role: role === "admin" ? "admin" : "advisor" });
    res.json({ user: { id: u.id, email: u.email, storeId: u.storeId, role: u.role } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/owner/users/:id/active", requireOwner, (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: "unknown user" });
  if (u.role === "owner") return res.status(400).json({ error: "cannot deactivate the owner" });
  u.active = !!(req.body && req.body.active); saveUsers();
  res.json({ ok: true, active: u.active });
});

// Reset a user's MFA so they re-enroll on next sign-in (for a lost phone /
// locked-out user). Owner-only. Their old authenticator + backup codes stop
// working immediately.
app.post("/api/owner/users/:id/reset-mfa", requireOwner, (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: "unknown user" });
  u.mfa = null; saveUsers();
  res.json({ ok: true });
});

// Per-store grading rule switches (owner-only).
app.get("/api/owner/stores/:id/rules", requireOwner, (req, res) => {
  const s = storeById(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown store" });
  res.json({
    rules: RULES.map((r) => ({
      key: r.key, label: r.label, desc: r.desc, def: r.def, disclaimer: r.disclaimer,
      enabled: storeRuleState(s, r), deviates: storeRuleState(s, r) !== r.def,
    })),
  });
});
app.post("/api/owner/stores/:id/rules", requireOwner, (req, res) => {
  const s = storeById(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown store" });
  const b = req.body || {};
  const r = RULES_BY_KEY[b.key];
  if (!r) return res.status(400).json({ error: "unknown rule" });
  const next = !!b.enabled;
  const willDeviate = next !== r.def;
  // Weakening a safeguard needs the disclaimer acknowledged first.
  if (willDeviate && r.disclaimer && !b.ack) return res.status(400).json({ error: "acknowledgement required", needAck: true });
  s.ruleConfig = s.ruleConfig || {};
  if (next === r.def) delete s.ruleConfig[r.key]; else s.ruleConfig[r.key] = next;
  s.ruleAcks = s.ruleAcks || [];
  s.ruleAcks.push({ key: r.key, enabled: next, deviates: willDeviate, acknowledged: !!(willDeviate && r.disclaimer), by: req.ctx.user.email, at: new Date().toISOString() });
  if (s.ruleAcks.length > 500) s.ruleAcks = s.ruleAcks.slice(-500);
  saveStores();
  res.json({ ok: true, enabled: next, deviates: willDeviate });
});

app.get("/resources", (_req, res) => res.sendFile(path.join(__dirname, "public", "resources.html")));
app.get("/api/resources", (_req, res) => res.json({ resources: resourceMeta() }));

// --- Status page (available to every logged-in user, any tier) --------------
app.get("/status", (_req, res) => res.sendFile(path.join(__dirname, "public", "status.html")));
app.get("/api/status", async (_req, res) => {
  try { res.json(await getSystemStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Support inbox (any logged-in user submits; owner reads in the console) --
app.get("/support", (_req, res) => res.sendFile(path.join(__dirname, "public", "support.html")));
app.post("/api/support", (req, res) => {
  const b = req.body || {};
  const subject = String(b.subject || "").trim().slice(0, 200);
  const category = String(b.category || "").trim().slice(0, 40);
  const message = String(b.message || "").trim().slice(0, 5000);
  if (!message) return res.status(400).json({ error: "Please describe what you need help with." });
  addSupport({
    id: genId("sup_"), ts: new Date().toISOString(), status: "open",
    storeId: req.ctx.store.id, storeName: req.ctx.store.name || req.ctx.store.id,
    userId: req.ctx.user.id, userName: req.ctx.user.name || req.ctx.user.email, userEmail: req.ctx.user.email,
    category, subject, message,
  });
  res.json({ ok: true });
});
app.get("/api/support", requireOwner, (_req, res) => res.json({ items: SUPPORT }));
app.post("/api/support/:id/status", requireOwner, (req, res) => {
  const rec = SUPPORT.find((x) => x.id === req.params.id);
  if (!rec) return res.status(404).json({ error: "Not found." });
  rec.status = (req.body && req.body.status === "open") ? "open" : "resolved";
  rec.resolvedAt = rec.status === "resolved" ? new Date().toISOString() : null;
  saveSupport();
  res.json({ ok: true, status: rec.status });
});

// --- Per-store learning insights (warranty tier; strictly this store) -------
app.get("/insights", (_req, res) => res.sendFile(path.join(__dirname, "public", "insights.html")));
app.get("/api/insights", (req, res) => {
  const sid = req.ctx.store.id;
  const mem = STORE_MEMORY[sid] || { patterns: [], updatedAt: null };
  const patterns = (mem.patterns || []).slice()
    .sort((a, b) => (b.count - a.count) || String(b.lastTs || "").localeCompare(String(a.lastTs || "")));
  res.json({
    storeName: req.ctx.store.name || sid,
    reviewCount: storeReviewCount(sid),
    updatedAt: mem.updatedAt || null,
    activeInReviews: patterns.filter((p) => p.status !== "muted" && p.count >= 2).length,
    patterns: patterns.map((p) => ({
      key: p.key, label: p.label, kind: p.kind, severity: p.severity,
      count: p.count, lastTs: p.lastTs, firstTs: p.firstTs,
      status: p.status || "active", confirms: p.confirms || 0,
    })),
  });
});
app.post("/api/insights/:key/feedback", (req, res) => {
  const sid = req.ctx.store.id;
  const mem = STORE_MEMORY[sid];
  if (!mem) return res.status(404).json({ error: "No learning data yet." });
  const p = (mem.patterns || []).find((x) => x.key === req.params.key);
  if (!p) return res.status(404).json({ error: "Not found." });
  const action = (req.body && req.body.action) || "";
  if (action === "mute") p.status = "muted";
  else if (action === "unmute") p.status = "active";
  else if (action === "confirm") { p.status = "active"; p.confirms = (p.confirms || 0) + 1; }
  else return res.status(400).json({ error: "Unknown action." });
  saveStoreMemory();
  res.json({ ok: true, status: p.status, confirms: p.confirms || 0 });
});
app.get("/resources/file/:key", (req, res) => {
  const r = RESOURCE_BY_KEY[req.params.key];
  if (!r) return res.status(404).send("Not found");
  const p = resourcePath(r);
  if (!fs.existsSync(p)) return res.status(404).send("This manual hasn't been uploaded yet.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", (req.query.dl ? "attachment" : "inline") + '; filename="' + r.file + '"');
  fs.createReadStream(p).pipe(res);
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/appeal", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "appeal.html"));
});

app.post("/api/appeal", async (req, res) => {
  const rejection = String(req.body.rejection || "").trim();
  const ticket = String(req.body.ticket || "").trim();
  if (!rejection) return res.status(400).json({ error: "Paste the rejection or chargeback notice first." });
  if (rejection.length + ticket.length > 80000) return res.status(400).json({ error: "That's too long — trim it down." });
  const _prep = await prepareFiles(Array.isArray(req.body.files) ? req.body.files : []);
  if (_prep.unreadable.length) return res.status(400).json({ error: unreadableMsg(_prep.unreadable) });
  const files = _prep.files;
  try {
    const key = reviewCacheKey("appeal", ticket, files, rejection);
    let appeal;
    const hit = REVIEW_CACHE[key];
    if (hit && hit.appeal) {
      appeal = hit.appeal;
    } else {
      appeal = await draftAppeal(rejection, ticket, files);
      REVIEW_CACHE[key] = { appeal, ts: Date.now() };
      saveReviewCache();
    }
    addHistory({
      storeId: req.ctx.store.id,
      userId: req.ctx.user.id,
      userName: req.ctx.user.name || req.ctx.user.email,
      type: "appeal",
      ro: extractRo(rejection + " " + ticket),
      vin: String(req.body.vin || "").trim().toUpperCase() || extractVin(rejection + " " + ticket) || "",
      vehicle: String(req.body.vehicle || "").trim(),
      score: null,
      verdict: appeal?.analysis?.strength || "",
      summary: appeal?.analysis?.reason || "",
      ticket, rejection,
      result: appeal,
    });
    res.json({ appeal });
  } catch (e) {
    try { console.error("AI request failed:", e && e.status, e && e.message); } catch (_) {}
    res.status(502).json({ error: friendlyAiError(e), retryable: true });
  }
});

// Assemble the structured repair-order fields into the canonical ticket text
// that both the AI reviewer and the deterministic cache key work from.
function assembleTicket(f) {
  const ctLabel = (CLAIM_TYPES[f.claimType] && CLAIM_TYPES[f.claimType].label) || f.claimType;
  const parts = [
    "CLAIM TYPE: " + ctLabel,
    "REPAIR ORDER #: " + f.ro + "    LINE: " + f.line,
    "VIN: " + f.vin,
    "MILEAGE IN: " + f.mileage + "    MILEAGE OUT: " + f.mileageout,
    "CAUSAL PART #: " + f.causalpart,
  ];
  if (f.origro) parts.push("ORIGINAL RO / INVOICE #: " + f.origro);
  if (f.spwinstall) parts.push("SPW INSTALL DATE: " + f.spwinstall);
  if (f.spwapproval) parts.push("SPW PRIOR APPROVAL # (SPWA): " + f.spwapproval);
  parts.push(
    "",
    "COMPLAINT: " + f.complaint,
    "CAUSE: " + f.cause,
    "CORRECTION: " + f.correction
  );
  if (f.detail) parts.push("", "ADDITIONAL REPAIR-ORDER DETAIL:", f.detail);
  return parts.join("\n").trim();
}

// Rebuild the reviewer form fields from a saved record (for the History
// "Re-run" button). New records store `fields` directly; older records are
// parsed from the assembled ticket text plus whatever top-level fields exist.
function recordFields(r) {
  if (r.fields && typeof r.fields === "object") {
    const x = r.fields;
    return {
      claimtype: x.claimtype || "", ro: x.ro || "", line: x.line || "", vin: x.vin || "",
      mileage: x.mileage || "", mileageout: x.mileageout || "", causalpart: x.causalpart || "",
      origro: x.origro || "", spwinstall: x.spwinstall || "", spwapproval: x.spwapproval || "",
      complaint: x.complaint || "", cause: x.cause || "", correction: x.correction || "", detail: x.detail || "",
    };
  }
  const t = String(r.ticket || "");
  const pick = (re) => { const m = t.match(re); return m ? m[1].trim() : ""; };
  const out = {
    claimtype: r.claimType || "",
    ro: r.ro || pick(/REPAIR ORDER #:\s*([^\n]*?)(?:\s{2,}LINE:|\n|$)/i),
    line: r.line || pick(/(?:^|\s{2,})LINE:\s*([^\n]+)/i),
    vin: r.vin || pick(/\bVIN:\s*([A-Z0-9]+)/i),
    mileage: r.mileage || pick(/MILEAGE(?: IN)?:\s*([^\n]*?)(?:\s{2,}MILEAGE OUT:|\n|$)/i),
    mileageout: r.mileageOut || pick(/MILEAGE OUT:\s*([^\n]+)/i),
    causalpart: r.causalPart || pick(/CAUSAL PART #:\s*([^\n]+)/i),
    origro: pick(/ORIGINAL RO \/ INVOICE #:\s*([^\n]+)/i),
    spwinstall: pick(/SPW INSTALL DATE:\s*([^\n]+)/i),
    spwapproval: pick(/SPW PRIOR APPROVAL # \(SPWA\):\s*([^\n]+)/i),
    complaint: pick(/COMPLAINT:\s*([\s\S]*?)(?:\nCAUSE:|$)/i),
    cause: pick(/\nCAUSE:\s*([\s\S]*?)(?:\nCORRECTION:|$)/i),
    correction: pick(/\nCORRECTION:\s*([\s\S]*?)(?:\n\nADDITIONAL REPAIR-ORDER DETAIL:|$)/i),
    detail: pick(/ADDITIONAL REPAIR-ORDER DETAIL:\s*([\s\S]*)$/i),
  };
  // Legacy free-text ticket with no field labels: keep the text so it isn't lost.
  if (!out.complaint && !out.cause && !out.correction && t && !/COMPLAINT:/i.test(t)) out.detail = out.detail || t.trim();
  return out;
}

// Decode a VIN on demand (the "Decode VIN" button). Cached; never in a URL.
app.post("/api/vin", async (req, res) => {
  try { res.json(await decodeVin((req.body && req.body.vin) || "")); }
  catch (e) { res.status(500).json({ ok: false, reason: "service", error: "The VIN decoder is unavailable right now." }); }
});

app.post("/api/review", async (req, res) => {
  const b = req.body || {};
  const f = {
    claimType: String(b.claimtype || b.claimType || "").trim(),
    ro: String(b.ro || "").trim(),
    line: String(b.line || "").trim(),
    vin: String(b.vin || "").trim().toUpperCase(),
    mileage: String(b.mileage || "").trim(),
    mileageout: String(b.mileageout || "").trim(),
    causalpart: String(b.causalpart || "").trim().toUpperCase(),
    origro: String(b.origro || "").trim(),
    spwinstall: String(b.spwinstall || "").trim(),
    spwapproval: String(b.spwapproval || "").trim(),
    complaint: String(b.complaint || "").trim(),
    cause: String(b.cause || "").trim(),
    correction: String(b.correction || "").trim(),
    detail: String(b.detail || "").trim(),
  };
  // Shrink oversized photos up front so the SAME compressed image is what we
  // send to the API (avoids the API's ~5MB/image limit) and what we retain in
  // History — keeping storage small and the cache key consistent.
  const _prep = await prepareFiles(Array.isArray(b.files) ? b.files : []);
  if (_prep.unreadable.length) return res.status(400).json({ error: unreadableMsg(_prep.unreadable) });
  const files = _prep.files;

  let ticket, vinField;
  const legacy = String(b.ticket || "").trim();
  const usingFields = f.claimType || f.ro || f.line || f.vin || f.mileage || f.mileageout || f.causalpart || f.complaint || f.cause || f.correction;
  if (usingFields || !legacy) {
    // Structured mode: every listed field is required before a review runs.
    const missing = [];
    if (!f.claimType) missing.push("Claim Type");
    if (!f.ro) missing.push("Repair Order #");
    if (!f.line) missing.push("Line #");
    if (!f.vin) missing.push("VIN");
    if (!f.mileage) missing.push("Mileage In");
    if (!f.mileageout) missing.push("Mileage Out");
    if (!f.causalpart) missing.push("Causal Part #");
    if (!f.complaint) missing.push("Complaint");
    if (!f.cause) missing.push("Cause");
    if (!f.correction) missing.push("Correction");
    if (missing.length) return res.status(400).json({ error: "Please fill in all required fields before reviewing: " + missing.join(", ") + "." });
    if (!CLAIM_TYPES[f.claimType]) return res.status(400).json({ error: "Unknown claim type." });
    ticket = assembleTicket(f);
    vinField = f.vin;
  } else {
    // Legacy free-text ticket (kept for backward compatibility / API callers).
    ticket = legacy;
    vinField = extractVin(ticket);
  }
  if (ticket.length > 60000) return res.status(400).json({ error: "That ticket is too long — trim it down." });

  try {
    const vin = vinField || extractVin(ticket);
    // This store's rule customizations become part of the cache key AND the
    // prompt, so a store's tweaks re-score only its own tickets deterministically.
    // The store's own recurring-issue memory is appended so it both shapes the
    // prompt AND participates in the cache key (a store's learned patterns
    // re-score only its own tickets, deterministically).
    const rulesOverride = buildRuleOverrides(req.ctx.store) + storeMemoryPromptSnippet(req.ctx.store.id);
    // Claim type is part of the cache key: the same repair on a different claim
    // type is a different review, so it must never collide in the cache.
    const key = reviewCacheKey("review", ticket, files, "ct:" + (f.claimType || "") + "|r:" + rulesOverride);
    let review, recallInfo;
    const hit = REVIEW_CACHE[key];
    if (hit && hit.review) {
      // Identical ticket seen before -> return the exact same review + score.
      review = hit.review;
      recallInfo = hit.recallInfo || null;
    } else {
      recallInfo = vin ? await lookupRecalls(vin) : null;
      review = await reviewTicket(ticket, recallInfo, files, f.claimType, rulesOverride);
      REVIEW_CACHE[key] = { review, recallInfo, ts: Date.now() };
      saveReviewCache();
    }
    addHistory({
      storeId: req.ctx.store.id,
      userId: req.ctx.user.id,
      userName: req.ctx.user.name || req.ctx.user.email,
      type: "review",
      claimType: f.claimType || "",
      claimLabel: (CLAIM_TYPES[f.claimType] && CLAIM_TYPES[f.claimType].label) || "",
      ro: f.ro || extractRo(ticket),
      line: f.line || "",
      mileage: f.mileage || "",
      mileageOut: f.mileageout || "",
      causalPart: f.causalpart || "",
      vin: vin || "",
      vehicle: (recallInfo && !recallInfo.error)
        ? (recallInfo.vehicleLabel || [recallInfo.year, recallInfo.make, recallInfo.model].filter(Boolean).join(" "))
        : String(b.vehicle || "").trim(),
      score: review?.score ?? null,
      verdict: review?.verdict || "",
      summary: review?.summary || "",
      ticket, rejection: "",
      // Raw form inputs, kept so History can re-run the ticket into the reviewer.
      fields: {
        claimtype: f.claimType, ro: f.ro, line: f.line, vin: f.vin,
        mileage: f.mileage, mileageout: f.mileageout, causalpart: f.causalpart,
        origro: f.origro, spwinstall: f.spwinstall, spwapproval: f.spwapproval,
        complaint: f.complaint, cause: f.cause, correction: f.correction, detail: f.detail,
      },
      result: review,
      recallInfo,
      pendingFiles: files,
    });
    // Learn from this review so the store's memory sharpens over time.
    try { learnFromReview(req.ctx.store.id, review, new Date().toISOString()); } catch (_) {}
    res.json({ review, recallInfo });
  } catch (e) {
    try { console.error("AI request failed:", e && e.status, e && e.message); } catch (_) {}
    res.status(502).json({ error: friendlyAiError(e), retryable: true });
  }
});

// History endpoints
app.get("/history", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "history.html"));
});

// Owner console (Phase 2): manage stores, users, and logos. Owner-only.
app.get("/console", (req, res) => {
  if (!req.ctx || !req.ctx.user || req.ctx.user.role !== "owner") return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "console.html"));
});

// Repair Story Assistant (customer-pay repair write-ups; any signed-in user).
app.get("/story", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "story.html"));
});
app.post("/api/story", async (req, res) => {
  const b = req.body || {};
  const concern = String(b.concern || "").trim();
  const found = String(b.found || "").trim();
  const done = String(b.done || "").trim();
  const details = String(b.details || "").trim();
  const component = String(b.component || "").trim();
  const opts = { search: b.search === true, readings: b.readings === true };
  if (!concern || !found || !done) return res.status(400).json({ error: "Fill in the concern, what you found, and what you did." });
  const input = "TECHNICIAN NOTES for a customer-pay repair:\n\n"
    + (details ? "VEHICLE / DETAILS: " + details + "\n\n" : "")
    + (component ? "FAILED COMPONENT" + (opts.search ? " (look up its documented test procedure & spec)" : "") + ": " + component + "\n\n" : "")
    + "CUSTOMER CONCERN: " + concern + "\n\n"
    + "WHAT I FOUND: " + found + "\n\n"
    + "WHAT I DID: " + done;
  if (input.length > 12000) return res.status(400).json({ error: "That's a lot of text — trim it down a bit." });
  try {
    const story = await storyWrite(input, opts);
    try {
      logStoryUsage({
        storeId: req.ctx.store.id, userId: req.ctx.user.id,
        userName: req.ctx.user.name || req.ctx.user.email,
        component: component || "", search: !!opts.search, readings: !!opts.readings,
      });
    } catch (_) {}
    res.json({ story });
  } catch (e) {
    try { console.error("AI request failed:", e && e.status, e && e.message); } catch (_) {}
    res.status(502).json({ error: friendlyAiError(e), retryable: true });
  }
});

// ---------------------------------------------------------------------------
// Reporting engine — build any report over reviews, appeals, or Story usage,
// with filters, grouping/aggregation, and CSV / Excel / PDF export.
// Owner sees all stores (optional store filter); everyone else is locked to
// their own store, server-side. Part of the warranty tier (see featureForPath).
// ---------------------------------------------------------------------------
let XLSX_LIB = null; try { XLSX_LIB = require("xlsx"); } catch (_) {}
let PDFDoc = null; try { PDFDoc = require("pdfkit"); } catch (_) {}

function storeNameById(id) { const s = storeById(id); return s ? s.name : id; }
function parseNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function yesno(v) { return v ? "Yes" : "No"; }

// ---------------------------------------------------------------------------
// Claim outcome tracking. After a claim is submitted, the store logs what
// actually happened — approved, denied, adjusted, charged back. This closes the
// loop: it powers denial-rate reporting, dollars paid/lost, and shows which
// causal parts and advisors drive denials. Stored per review record as
// rec.outcome; a record with nothing logged is treated as "pending".
// ---------------------------------------------------------------------------
const OUTCOME_STATUSES = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved / paid" },
  { id: "denied", label: "Denied" },
  { id: "adjusted", label: "Adjusted / short-paid" },
  { id: "charged_back", label: "Charged back" },
  { id: "resubmitted", label: "Resubmitted" },
];
const OUTCOME_LABEL = Object.fromEntries(OUTCOME_STATUSES.map((o) => [o.id, o.label]));
function outcomeStatusOf(r) { return (r && r.outcome && r.outcome.status) || "pending"; }

// Ford part numbers are PREFIX-BASE-SUFFIX (e.g. FL3Z-9G756-A). The BASE
// (9G756) identifies the component regardless of application, and its first
// digit maps to a system (6 engine, 7 transmission, 9 fuel, ...), so reporting
// and search key off the base. Best-effort extractor, tolerant of formats.
function causalBase(pn) {
  const s = String(pn || "").toUpperCase().trim();
  if (!s) return "";
  if (s.indexOf("NPF") === 0) return "NPF";
  const t = s.split(/[^A-Z0-9]+/).filter(Boolean);
  if (t.length >= 3) return t[1];
  if (t.length === 2) return /^[A-Z]{1,2}$/.test(t[1]) ? t[0] : t[1];
  const m = (t[0] || "").match(/^([A-Z0-9]{3,4}Z)([0-9][A-Z0-9]*?)([A-Z]*)$/);
  return m ? m[2] : (t[0] || "");
}

const REPORT_DATASETS = {
  reviews: {
    label: "Warranty reviews",
    columns: [
      { key: "ts", label: "Date", type: "date" },
      { key: "storeName", label: "Store", type: "string" },
      { key: "userName", label: "Advisor", type: "string" },
      { key: "ro", label: "RO #", type: "string" },
      { key: "line", label: "Line", type: "string" },
      { key: "claimLabel", label: "Claim type", type: "string" },
      { key: "vin", label: "VIN", type: "string" },
      { key: "vehicle", label: "Vehicle", type: "string" },
      { key: "mileage", label: "Mileage", type: "number" },
      { key: "causalPart", label: "Causal part", type: "string" },
      { key: "causalBase", label: "Causal base", type: "string" },
      { key: "score", label: "Score", type: "number" },
      { key: "verdict", label: "Verdict", type: "string" },
      { key: "outcomeStatus", label: "Outcome", type: "string" },
      { key: "decidedAt", label: "Outcome date", type: "date" },
      { key: "claimAmount", label: "Claim $", type: "number" },
      { key: "paidAmount", label: "Paid $", type: "number" },
      { key: "chargebackAmount", label: "Chargeback $", type: "number" },
      { key: "netAmount", label: "Net $", type: "number" },
      { key: "denialReason", label: "Denial reason", type: "string" },
      { key: "summary", label: "Summary", type: "string" },
    ],
    getRows: (scope) => HISTORY.filter((r) => r.type === "review" && scope.storeIds.has(r.storeId)).map((r) => {
      const o = r.outcome || {};
      const paid = parseNum(o.paidAmount), cb = parseNum(o.chargebackAmount);
      const net = (paid == null && cb == null) ? null : (paid || 0) - (cb || 0);
      return {
        _id: r.id,
        ts: r.ts || "", storeName: storeNameById(r.storeId), userName: r.userName || "", ro: r.ro || "", line: r.line || "",
        claimLabel: r.claimLabel || r.claimType || "", vin: r.vin || "", vehicle: r.vehicle || "",
        mileage: parseNum(r.mileage), causalPart: r.causalPart || "", causalBase: causalBase(r.causalPart),
        score: (r.score == null ? null : r.score), verdict: r.verdict || "",
        outcomeStatus: OUTCOME_LABEL[outcomeStatusOf(r)], decidedAt: o.decidedAt || "",
        claimAmount: parseNum(o.claimAmount), paidAmount: paid, chargebackAmount: cb, netAmount: net,
        denialReason: o.reason || "", summary: r.summary || "",
      };
    }),
  },
  appeals: {
    label: "Appeals",
    columns: [
      { key: "ts", label: "Date", type: "date" },
      { key: "storeName", label: "Store", type: "string" },
      { key: "userName", label: "Advisor", type: "string" },
      { key: "ro", label: "RO #", type: "string" },
      { key: "vin", label: "VIN", type: "string" },
      { key: "verdict", label: "Strength", type: "string" },
      { key: "summary", label: "Reason", type: "string" },
    ],
    getRows: (scope) => HISTORY.filter((r) => r.type === "appeal" && scope.storeIds.has(r.storeId)).map((r) => ({
      _id: r.id,
      ts: r.ts || "", storeName: storeNameById(r.storeId), userName: r.userName || "", ro: r.ro || "",
      vin: r.vin || "", verdict: r.verdict || "", summary: r.summary || "",
    })),
  },
  stories: {
    label: "Repair Story usage",
    columns: [
      { key: "ts", label: "Date", type: "date" },
      { key: "storeName", label: "Store", type: "string" },
      { key: "userName", label: "Advisor", type: "string" },
      { key: "component", label: "Component", type: "string" },
      { key: "search", label: "Web lookup", type: "string" },
      { key: "readings", label: "Suggested readings", type: "string" },
    ],
    getRows: (scope) => STORY_USAGE.filter((r) => scope.storeIds.has(r.storeId)).map((r) => ({
      ts: r.ts || "", storeName: storeNameById(r.storeId), userName: r.userName || "",
      component: r.component || "", search: yesno(r.search), readings: yesno(r.readings),
    })),
  },
};

function reportPresets() {
  const d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return [
    { id: "rev_by_claim", label: "Reviews — count & avg score by claim type", query: { dataset: "reviews", groupBy: ["claimLabel"], agg: [{ fn: "count" }, { fn: "avg", field: "score" }], sort: { field: "count", dir: "desc" } } },
    { id: "rev_by_advisor", label: "Reviews — by advisor", query: { dataset: "reviews", groupBy: ["userName"], agg: [{ fn: "count" }, { fn: "avg", field: "score" }], sort: { field: "count", dir: "desc" } } },
    { id: "rev_low", label: "Reviews — low scores (under 70)", query: { dataset: "reviews", filters: [{ field: "score", op: "lt", value: "70" }], sort: { field: "score", dir: "asc" } } },
    { id: "rev_detail_30", label: "Reviews — detail, last 30 days", query: { dataset: "reviews", from: d, sort: { field: "ts", dir: "desc" } } },
    { id: "out_breakdown", label: "Outcomes — breakdown by result", query: { dataset: "reviews", groupBy: ["outcomeStatus"], agg: [{ fn: "count" }], sort: { field: "count", dir: "desc" } } },
    { id: "out_denied_part", label: "Denials — by causal part base", query: { dataset: "reviews", filters: [{ field: "outcomeStatus", op: "eq", value: "Denied" }], groupBy: ["causalBase"], agg: [{ fn: "count" }], sort: { field: "count", dir: "desc" } } },
    { id: "out_denied_adv", label: "Denials — by advisor", query: { dataset: "reviews", filters: [{ field: "outcomeStatus", op: "eq", value: "Denied" }], groupBy: ["userName"], agg: [{ fn: "count" }], sort: { field: "count", dir: "desc" } } },
    { id: "out_chargebacks", label: "Chargebacks — detail", query: { dataset: "reviews", filters: [{ field: "outcomeStatus", op: "eq", value: "Charged back" }], sort: { field: "ts", dir: "desc" } } },
    { id: "out_pending", label: "Outcomes — pending (need logging)", query: { dataset: "reviews", filters: [{ field: "outcomeStatus", op: "eq", value: "Pending" }], sort: { field: "ts", dir: "desc" } } },
    { id: "out_paid_claim", label: "Dollars paid — by claim type", query: { dataset: "reviews", groupBy: ["claimLabel"], agg: [{ fn: "count" }, { fn: "sum", field: "paidAmount" }], sort: { field: "sum_paidAmount", dir: "desc" } } },
    { id: "out_score_result", label: "Avg score by outcome", query: { dataset: "reviews", groupBy: ["outcomeStatus"], agg: [{ fn: "count" }, { fn: "avg", field: "score" }], sort: { field: "count", dir: "desc" } } },
    { id: "app_by_strength", label: "Appeals — count by strength", query: { dataset: "appeals", groupBy: ["verdict"], agg: [{ fn: "count" }], sort: { field: "count", dir: "desc" } } },
    { id: "story_by_advisor", label: "Story usage — by advisor", query: { dataset: "stories", groupBy: ["userName"], agg: [{ fn: "count" }], sort: { field: "count", dir: "desc" } } },
    { id: "story_detail", label: "Story usage — detail", query: { dataset: "stories", sort: { field: "ts", dir: "desc" } } },
  ];
}

function reportScope(req, requestedStoreId) {
  const isOwner = req.ctx.user.role === "owner";
  let storeIds;
  if (isOwner) {
    storeIds = (requestedStoreId && storeById(requestedStoreId)) ? new Set([requestedStoreId]) : new Set(STORES.map((s) => s.id));
  } else {
    storeIds = new Set([req.ctx.store.id]);
  }
  return { isOwner, storeIds };
}

function fmtCell(v, type) {
  if (v == null || v === "") return "";
  if (type === "date") return String(v).slice(0, 10);
  return String(v);
}
function cmpVals(a, b) {
  const an = (a == null || a === ""), bn = (b == null || b === "");
  if (an && bn) return 0; if (an) return -1; if (bn) return 1;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}
function applyFilter(val, op, target, type) {
  if (op === "empty") return val == null || val === "";
  if (op === "notempty") return !(val == null || val === "");
  if (type === "number") {
    const a = parseNum(val), b = parseNum(target);
    if (a == null || b == null) return op === "ne";
    switch (op) { case "eq": return a === b; case "ne": return a !== b; case "gt": return a > b; case "lt": return a < b; case "gte": return a >= b; case "lte": return a <= b; default: return true; }
  }
  const s = String(val == null ? "" : val).toLowerCase(), t = String(target == null ? "" : target).toLowerCase();
  switch (op) {
    case "eq": return s === t; case "ne": return s !== t; case "contains": return s.indexOf(t) !== -1;
    case "gt": return s > t; case "lt": return s < t; case "gte": return s >= t; case "lte": return s <= t;
    default: return true;
  }
}
function normalizeAggs(agg, cols) {
  const list = Array.isArray(agg) && agg.length ? agg : [{ fn: "count" }];
  const out = [];
  for (const a of list) {
    const fn = ["count", "avg", "sum", "min", "max"].includes(a.fn) ? a.fn : "count";
    if (fn === "count") { out.push({ key: "count", label: "Count", fn }); continue; }
    const col = cols.find((c) => c.key === a.field);
    if (!col) continue;
    out.push({ key: fn + "_" + a.field, label: fn.charAt(0).toUpperCase() + fn.slice(1) + " " + col.label, fn, field: a.field });
  }
  if (!out.length) out.push({ key: "count", label: "Count", fn: "count" });
  return out;
}
function computeAgg(a, items) {
  if (a.fn === "count") return items.length;
  const nums = items.map((i) => parseNum(i[a.field])).filter((n) => n != null);
  if (!nums.length) return null;
  if (a.fn === "sum") return nums.reduce((x, y) => x + y, 0);
  if (a.fn === "avg") return Math.round((nums.reduce((x, y) => x + y, 0) / nums.length) * 10) / 10;
  if (a.fn === "min") return Math.min(...nums);
  if (a.fn === "max") return Math.max(...nums);
  return null;
}

function runReport(q, scope) {
  q = q || {};
  const dsKey = REPORT_DATASETS[q.dataset] ? q.dataset : "reviews";
  const ds = REPORT_DATASETS[dsKey];
  const cols = ds.columns;
  let rows = ds.getRows(scope);
  if (q.from) rows = rows.filter((r) => r.ts && r.ts.slice(0, 10) >= q.from);
  if (q.to) rows = rows.filter((r) => r.ts && r.ts.slice(0, 10) <= q.to);
  for (const f of (Array.isArray(q.filters) ? q.filters : [])) {
    const col = cols.find((c) => c.key === f.field); if (!col) continue;
    rows = rows.filter((r) => applyFilter(r[f.field], f.op || "contains", f.value, col.type));
  }
  const groupBy = (Array.isArray(q.groupBy) ? q.groupBy : []).filter((k) => cols.some((c) => c.key === k));
  let outCols, outRows, outIds = null;
  if (groupBy.length) {
    const aggs = normalizeAggs(q.agg, cols);
    const groups = new Map();
    for (const r of rows) {
      const gk = groupBy.map((k) => fmtCell(r[k], (cols.find((c) => c.key === k) || {}).type)).join(" | ");
      if (!groups.has(gk)) groups.set(gk, { keyvals: groupBy.map((k) => r[k]), items: [] });
      groups.get(gk).items.push(r);
    }
    outCols = groupBy.map((k) => { const c = cols.find((x) => x.key === k); return { key: k, label: c.label, type: c.type }; })
      .concat(aggs.map((a) => ({ key: a.key, label: a.label, type: "number" })));
    outRows = [...groups.values()].map((g) => g.keyvals.concat(aggs.map((a) => computeAgg(a, g.items))));
  } else {
    const selKeys = (Array.isArray(q.columns) && q.columns.length) ? q.columns.filter((k) => cols.some((c) => c.key === k)) : cols.map((c) => c.key);
    outCols = selKeys.map((k) => { const c = cols.find((x) => x.key === k); return { key: k, label: c.label, type: c.type }; });
    outRows = rows.map((r) => selKeys.map((k) => r[k]));
    // Carry each row's originating record id so the UI can deep-link an RO to its
    // saved submission (and its uploaded documents). Detail mode only.
    outIds = rows.map((r) => r._id || null);
  }
  if (q.sort && q.sort.field) {
    const ci = outCols.findIndex((c) => c.key === q.sort.field);
    if (ci >= 0) {
      const dir = q.sort.dir === "desc" ? -1 : 1;
      const order = outRows.map((_, i) => i).sort((a, b) => cmpVals(outRows[a][ci], outRows[b][ci]) * dir);
      outRows = order.map((i) => outRows[i]);
      if (outIds) outIds = order.map((i) => outIds[i]);
    }
  }
  const total = outRows.length;
  const limit = Math.min(Math.max(1, Number(q.limit) || 5000), 10000);
  const truncated = total > limit;
  if (truncated) { outRows = outRows.slice(0, limit); if (outIds) outIds = outIds.slice(0, limit); }
  return { dataset: dsKey, datasetLabel: ds.label, columns: outCols, rows: outRows, rowIds: (outIds && outIds.some((x) => x)) ? outIds : undefined, total, truncated };
}

// --- Exporters --------------------------------------------------------------
function reportToCSV(rep) {
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = rep.columns.map((c) => esc(c.label)).join(",");
  const body = rep.rows.map((row) => row.map((v, i) => esc(fmtCell(v, rep.columns[i].type))).join(","));
  return "﻿" + [head].concat(body).join("\r\n");
}
function reportToXLSX(rep, title) {
  if (!XLSX_LIB) throw new Error("Excel export is not available on this server.");
  const aoa = [rep.columns.map((c) => c.label)];
  for (const row of rep.rows) {
    aoa.push(row.map((v, i) => {
      const t = rep.columns[i].type;
      if (t === "number") { const n = parseNum(v); return n == null ? "" : n; }
      return fmtCell(v, t);
    }));
  }
  const ws = XLSX_LIB.utils.aoa_to_sheet(aoa);
  ws["!cols"] = rep.columns.map((c) => ({ wch: Math.min(45, Math.max(10, c.label.length + 4)) }));
  const wb = XLSX_LIB.utils.book_new();
  XLSX_LIB.utils.book_append_sheet(wb, ws, "Report");
  return XLSX_LIB.write(wb, { type: "buffer", bookType: "xlsx" });
}
function reportToPDF(rep, title, subtitle) {
  if (!PDFDoc) return Promise.reject(new Error("PDF export is not available on this server."));
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDoc({ size: "LETTER", layout: "landscape", margin: 36 });
      const chunks = []; doc.on("data", (d) => chunks.push(d)); doc.on("end", () => resolve(Buffer.concat(chunks)));
      const left = 36, right = doc.page.width - 36, usable = right - left;
      doc.fillColor("#003478").fontSize(16).font("Helvetica-Bold").text(title || "Report", left, 30);
      doc.fillColor("#4a5568").fontSize(9).font("Helvetica").text(subtitle || "", left, 52);
      let y = 74;
      const weights = rep.columns.map((c) => Math.max(c.label.length, 8));
      const wsum = weights.reduce((a, b) => a + b, 0);
      let widths = weights.map((w) => Math.max(42, Math.round((w / wsum) * usable)));
      const wtot = widths.reduce((a, b) => a + b, 0);
      widths = widths.map((w) => Math.floor(w * usable / wtot));
      const rowH = 16, headH = 18;
      const drawHeader = () => {
        doc.rect(left, y, usable, headH).fill("#003478");
        doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold");
        let x = left;
        rep.columns.forEach((c, i) => { doc.text(String(c.label), x + 3, y + 5, { width: widths[i] - 6, height: headH, ellipsis: true, lineBreak: false }); x += widths[i]; });
        y += headH;
      };
      drawHeader();
      doc.font("Helvetica").fontSize(8);
      rep.rows.forEach((row, ri) => {
        if (y + rowH > doc.page.height - 30) { doc.addPage(); y = 40; drawHeader(); doc.font("Helvetica").fontSize(8); }
        if (ri % 2 === 1) { doc.rect(left, y, usable, rowH).fill("#f2f5fa"); }
        doc.fillColor("#0e1726");
        let x = left;
        row.forEach((v, i) => { doc.text(fmtCell(v, rep.columns[i].type), x + 3, y + 4, { width: widths[i] - 6, height: rowH, ellipsis: true, lineBreak: false }); x += widths[i]; });
        y += rowH;
      });
      doc.fillColor("#8a94a6").fontSize(7).text((rep.truncated ? "Showing first " + rep.rows.length + " of " + rep.total + " rows. " : "Total rows: " + rep.total + ". ") + "Generated by ClaimProof.", left, doc.page.height - 26);
      doc.end();
    } catch (e) { reject(e); }
  });
}

function reportFilename(rep, ext) {
  const day = new Date().toISOString().slice(0, 10);
  return "report-" + rep.dataset + "-" + day + "." + ext;
}

// Reporting is available on EVERY tier, but a store may only report on the data
// it pays for: reviews & appeals ride on the warranty tool, stories on the Story
// tool. This is enforced server-side, so the datasets a store can't see are never
// exposed in meta and are rejected on run/export.
function allowedDatasets(store) {
  const f = storeFeatures(store);
  const out = [];
  if (f.warranty) out.push("reviews", "appeals");
  if (f.story) out.push("stories");
  return out;
}

app.get("/reports", (req, res) => {
  if (!allowedDatasets(req.ctx.store).length) return res.redirect("/account");
  res.sendFile(path.join(__dirname, "public", "reports.html"));
});

app.get("/api/reports/meta", (req, res) => {
  const isOwner = req.ctx.user.role === "owner";
  const allow = allowedDatasets(req.ctx.store);
  const datasets = {};
  for (const k of allow) datasets[k] = { label: REPORT_DATASETS[k].label, columns: REPORT_DATASETS[k].columns };
  res.json({
    isOwner,
    stores: isOwner ? STORES.map((s) => ({ id: s.id, name: s.name })) : [],
    datasets,
    presets: reportPresets().filter((p) => allow.includes(p.query.dataset)),
    excel: !!XLSX_LIB, pdf: !!PDFDoc,
  });
});

app.post("/api/reports/run", (req, res) => {
  try {
    const q = req.body || {};
    if (!allowedDatasets(req.ctx.store).includes(q.dataset)) return res.status(403).json({ error: "That report isn't included in your plan." });
    const scope = reportScope(req, q.storeId);
    res.json(runReport(q, scope));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/reports/export", async (req, res) => {
  try {
    const b = req.body || {};
    const fmt = String(b.format || "csv").toLowerCase();
    if (!allowedDatasets(req.ctx.store).includes((b.query || {}).dataset)) return res.status(403).json({ error: "That report isn't included in your plan." });
    const scope = reportScope(req, (b.query || {}).storeId);
    const rep = runReport(b.query || {}, scope);
    const title = String(b.title || rep.datasetLabel || "Report").slice(0, 120);
    const sub = "Generated " + new Date().toISOString().slice(0, 16).replace("T", " ") + "  •  " + rep.total + " row(s)";
    if (fmt === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="' + reportFilename(rep, "csv") + '"');
      return res.send(reportToCSV(rep));
    }
    if (fmt === "xlsx" || fmt === "xls" || fmt === "excel") {
      const buf = reportToXLSX(rep, title);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="' + reportFilename(rep, "xlsx") + '"');
      return res.send(buf);
    }
    if (fmt === "pdf") {
      const buf = await reportToPDF(rep, title, sub);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="' + reportFilename(rep, "pdf") + '"');
      return res.send(buf);
    }
    res.status(400).json({ error: "Unknown export format." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Account page + self-service password change (any signed-in user).
app.get("/account", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "account.html"));
});
app.post("/api/change-password", (req, res) => {
  const u = userById(req.ctx.user.id);
  if (!u) return res.status(404).json({ error: "user not found" });
  const cur = String((req.body && req.body.current) || "");
  const nxt = String((req.body && req.body.next) || "");
  if (nxt.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
  if (!verifyPassword(cur, u.salt, u.hash)) return res.status(400).json({ error: "Current password isn't right." });
  const { salt, hash } = hashPassword(nxt);
  u.salt = salt; u.hash = hash; saveUsers();
  res.json({ ok: true });
});

app.get("/api/history", (req, res) => {
  const sid = req.ctx.store.id;
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const search = searchHistory(req.query.q, {
    type: req.query.type === "review" || req.query.type === "appeal" ? req.query.type : null,
    verdict: req.query.verdict ? String(req.query.verdict) : null,
    days: parseInt(req.query.days, 10) || null,
  });
  const { fallback, needles } = search;
  // Isolation: a store only ever sees its own records.
  const records = search.records.filter((r) => r.storeId === sid);
  const band = SCORE_BAND_BY_ID[req.query.band] || null;
  const cat = CATEGORY_IDS.includes(req.query.cat) ? req.query.cat : null;
  const oc = OUTCOME_LABEL[req.query.outcome] ? req.query.outcome : null;
  const inBand = (r) => (band ? r.score != null && r.score >= band.min && r.score <= band.max : true);
  const inCat = (r) => (cat ? categorizeRepair(r) === cat : true);
  const inOutcome = (r) => (oc ? outcomeStatusOf(r) === oc : true);

  // Faceted counts: category counts respect the active band (and vice-versa) so
  // each dropdown shows how many records that choice would surface right now.
  const categoryCounts = {}; for (const id of CATEGORY_IDS) categoryCounts[id] = 0;
  const bandCounts = {}; for (const b of SCORE_BANDS) bandCounts[b.id] = 0;
  const outcomeCounts = {}; for (const o of OUTCOME_STATUSES) outcomeCounts[o.id] = 0;
  for (const r of records) {
    if (inBand(r) && inOutcome(r)) categoryCounts[categorizeRepair(r)]++;
    if (inCat(r) && inOutcome(r)) { const bb = scoreBandOf(r.score); if (bb) bandCounts[bb]++; }
    if (inBand(r) && inCat(r)) outcomeCounts[outcomeStatusOf(r)]++;
  }

  const filtered = records.filter((r) => inBand(r) && inCat(r) && inOutcome(r));
  const list = filtered.slice(offset, offset + limit).map((r) => {
    const c = categorizeRepair(r);
    const os = outcomeStatusOf(r);
    return {
      id: r.id, ts: r.ts, type: r.type, ro: r.ro, vin: r.vin, vehicle: r.vehicle,
      score: r.score, verdict: r.verdict, summary: String(r.summary || "").slice(0, 220),
      category: c, categoryLabel: CATEGORY_LABEL[c], claimLabel: r.claimLabel || "",
      causalPart: r.causalPart || "", outcome: os, outcomeLabel: OUTCOME_LABEL[os],
    };
  });
  const storeTotal = HISTORY.reduce((n, r) => n + (r.storeId === sid ? 1 : 0), 0);
  res.json({
    total: storeTotal, matched: filtered.length, offset, fallback, needles, results: list,
    categoryCounts, bandCounts, outcomeCounts, categories: CATEGORY_META, bands: SCORE_BANDS,
    outcomes: OUTCOME_STATUSES,
  });
});

app.get("/api/history/:id", (req, res) => {
  const rec = HISTORY.find((r) => r.id === req.params.id);
  if (!rec || rec.storeId !== req.ctx.store.id) return res.status(404).json({ error: "Not found" });
  res.json({ record: rec, fields: recordFields(rec) });
});

// Log / update what actually happened to a submitted claim (store-scoped).
app.post("/api/history/:id/outcome", (req, res) => {
  const rec = HISTORY.find((r) => r.id === req.params.id);
  if (!rec || rec.storeId !== req.ctx.store.id) return res.status(404).json({ error: "Not found" });
  if (rec.type !== "review") return res.status(400).json({ error: "Outcomes apply to reviews only." });
  const b = req.body || {};
  const status = OUTCOME_LABEL[b.status] ? b.status : "pending";
  const money = (v) => { const n = parseNum(v); return n == null ? null : n; };
  const prev = rec.outcome || {};
  if (status === "pending" && !b.reason && !b.notes && money(b.claimAmount) == null && money(b.paidAmount) == null && money(b.chargebackAmount) == null) {
    delete rec.outcome; // fully clearing an outcome back to unlogged
  } else {
    rec.outcome = {
      status,
      claimAmount: money(b.claimAmount),
      paidAmount: money(b.paidAmount),
      chargebackAmount: money(b.chargebackAmount),
      reason: String(b.reason || "").trim().slice(0, 500),
      notes: String(b.notes || "").trim().slice(0, 2000),
      decidedAt: status === "pending" ? "" : (String(b.decidedAt || "").trim().slice(0, 10) || prev.decidedAt || new Date().toISOString().slice(0, 10)),
      updatedAt: new Date().toISOString(),
      updatedBy: req.ctx.user.name || req.ctx.user.email,
    };
  }
  BLOBS.delete(rec.id);
  saveHistory();
  res.json({ ok: true, outcome: rec.outcome || { status: "pending" } });
});

// Serve a retained attachment for a saved submission (inline, or ?dl=1 to download).
app.get("/api/history/:id/file/:key", (req, res) => {
  const rec = HISTORY.find((r) => r.id === req.params.id);
  if (!rec || rec.storeId !== req.ctx.store.id || !Array.isArray(rec.files)) return res.status(404).json({ error: "Not found" });
  const meta = rec.files.find((f) => f.key === req.params.key);
  if (!meta) return res.status(404).json({ error: "Not found" });
  const dir = path.join(HISTORY_FILES_DIR, rec.id);
  const fp = path.join(dir, meta.key);
  if (!fp.startsWith(dir + path.sep) || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  res.setHeader("Content-Type", meta.type || "application/octet-stream");
  const disp = req.query.dl ? "attachment" : "inline";
  res.setHeader("Content-Disposition", disp + '; filename="' + String(meta.name).replace(/[^\w.\- ]+/g, "_") + '"');
  fs.createReadStream(fp).pipe(res);
});

app.delete("/api/history/:id", (req, res) => {
  const i = HISTORY.findIndex((r) => r.id === req.params.id && r.storeId === req.ctx.store.id);
  if (i === -1) return res.status(404).json({ error: "Not found" });
  removeHistoryFiles(req.params.id);
  HISTORY.splice(i, 1);
  saveHistory();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log("Warranty Ticket Reviewer listening on port " + PORT));
