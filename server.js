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

function isAuthed(req) {
  const cookies = (req.headers.cookie || "").split(";").map((c) => c.trim());
  const tok = cookies.find((c) => c.startsWith("wtr_auth="));
  if (!tok) return false;
  const val = tok.slice("wtr_auth=".length);
  try {
    return (
      val.length === AUTH_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(val), Buffer.from(AUTH_TOKEN))
    );
  } catch {
    return false;
  }
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
      "This claim is for a Ford / Motorcraft / Omnicraft service or replacement part the dealership installed — governed by Service Part Warranty, NOT the vehicle NVLW and NOT an ESP contract. Actively check: the part is a Ford-sold service part; SPW coverage is in force (12 months / 12,000 miles from the part's install date for warranty-installed parts; 24 months / unlimited for customer-paid parts); the required Install Date, Elapsed Odometer, and Original Repair Order / Invoice Number are present; the correct sub-code (SPW / SPNV / OTC); that a replacement part assumes only the REMAINING warranty of the part it replaces (it never restarts); and that SPW prior approval was obtained for assemblies whose causal base part starts with 6, 7 or 9 and repair cost exceeds $1,000. Apply the W&P Service Part Warranty rules and the OWS SPW/OTC claiming rules. Treat an out-of-force SPW period, a missing original-RO/invoice reference, or a missing SPW prior approval as CRITICAL.";
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
- "Found bad, replaced"-style causes, missing diagnosis, wear/maintenance items claimed as warranty, aftermarket-part involvement, time far over the labor op, and story inconsistencies are the classic rejection triggers - call them out.
- Be direct and practical, like a warranty admin who wants the claim to get PAID, not a lecture.
- Never question or flag the calendar dates on the ticket as implausible or "in the future" - assume the ticket's dates are current. Only flag dates for internal inconsistency (e.g. date out before date in, disclosure before repair).
- If the pasted text is not a warranty ticket at all, say so in "summary", set score to 0 and verdict to "high_risk", and leave the arrays sensible but short.
- If images or PDFs of the physical repair-order HARD CARD are attached: the hard copy is the OFFICIAL record of the repair (per 1.2.01). Read them carefully and cross-check against the typed ticket. Verify: time punches present (start AND finish for each actual-time repair, per 1.3.04); add-on repairs initialed by service management on the same line with "ADD" in the labor op column (per 1.2.04); required signatures/authorizations present (customer signature or management authorization for dealer vehicles - rubber stamps not acceptable); handwritten tech comments and test results; and that the hard card matches the typed story (mileage, dates, parts, hours). ALWAYS do the punch math explicitly: sum every ON-to-OFF interval on the card, state the total in the note (e.g. "punches total 1.4 hr"), and compare it to the hours claimed on the ticket - any difference is a discrepancy. Add completeness entries for "Hard card: time punches", "Hard card: signatures/authorizations", and "Hard card vs ticket consistency". Flag ANY discrepancy between hard card and typed claim as serious or critical - hard-card mismatches are classic audit findings. If an attached file is unreadable or isn't a repair order, say so in a completeness note.` +
  (FORD_REFERENCE
    ? `\n\nYou also have the dealership's distilled Ford Warranty & Policy Manual reference below. Apply these ACTUAL Ford rules when reviewing: check coverage periods against the vehicle's age/mileage, flag missing prior approvals, missing required test readings, time-limit problems, and exclusions. When a finding is based on a specific rule, cite the manual section number (e.g. "per 1.3.04") in the note or detail so the advisor can look it up.\n\n=== FORD WARRANTY & POLICY REFERENCE ===\n` + FORD_REFERENCE
    : "") +
  (OWS_REFERENCE
    ? `\n\nYou ALSO have the dealership's distilled Ford OWS (Online Warranty System) Claiming reference below — the rules for how a claim must be coded and submitted in OWS. Use it to check claim-readiness: the causal part and its 2-char condition code, the customer concern code, required comments (3 Cs in the comment fields), standard vs actual time claiming, exception/self-approval codes, required attachments, sublet (OSP/OSL) entry, and the commodity-specific rules (battery tester codes, paint material, tires, etc.). When a finding is based on an OWS rule, cite the OWS section (e.g. "per OWS §4 causal part") so the advisor can look it up. Flag OWS-specific rejection triggers from its "Common Rejection / Return Triggers" list.\n\n=== FORD OWS CLAIMING REFERENCE ===\n` + OWS_REFERENCE
    : "");

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
  try {
    const dec = await fetchJson(
      "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/" + encodeURIComponent(vin) + "?format=json"
    );
    const v = dec?.Results?.[0] || {};
    const year = v.ModelYear, make = v.Make, model = v.Model;
    if (!year || !make || !model) return { vin, error: "Could not decode this VIN." };
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
      return { vin, year, make, model, error: "VIN decoded but recall lookup failed: " + e.message };
    }
    return { vin, year, make, model, recalls: list };
  } catch (e) {
    return { vin, error: "NHTSA lookup failed: " + e.message };
  }
}

function recallContext(info) {
  if (!info || info.error || !info.recalls) return "";
  let s = "\n\n=== NHTSA RECALL LOOKUP (automatic) ===\nVIN " + info.vin + " decoded as " +
    info.year + " " + info.make + " " + info.model + ". NHTSA lists " + info.recalls.length +
    " recall campaign(s) for this year/make/model:\n";
  for (const r of info.recalls.slice(0, 25)) {
    s += "- " + r.campaign + " (" + r.date + ") " + r.component + ": " + r.summary + "\n";
  }
  s += "\nIMPORTANT: These are model-level campaigns from NHTSA. Whether each recall is OPEN or already COMPLETED on this specific VIN must be verified on OASIS. When reviewing: (1) if the repair in this ticket matches a recall component/condition, flag it CRITICAL - it likely must be claimed as a RECALL (FSA), never coded as warranty (per 6.2.01); (2) remind the advisor to check OASIS for open recalls to complete during this visit. Mention the specific campaign numbers.";
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
let HISTORY = [];
try {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
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
const RUBRIC_VERSION = "2026-07-16.5";
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
      b = JSON.stringify([r.ro, r.vin, r.vehicle, r.summary, r.ticket, r.rejection, r.result, r.recallInfo]).toLowerCase();
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

async function draftAppeal(rejection, ticket, files) {
  const blocks = fileBlocks(files);
  const intro = blocks.length
    ? "Attached above: " + blocks.length + " file(s) of the claim paperwork.\n\n"
    : "";
  const content = [
    ...blocks,
    { type: "text", text: intro + "=== REJECTION / CHARGEBACK NOTICE ===\n" + rejection + "\n\n=== ORIGINAL REPAIR ORDER / CLAIM ===\n" + (ticket || "(not provided)") },
  ];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      temperature: 0,
      system: APPEAL_PROMPT,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "Anthropic API error " + r.status);
  let text = (data.content || []).map((c) => c.text || "").join("").trim();
  text = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI returned an unexpected format. Try again.");
  return JSON.parse(text.slice(start, end + 1));
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

async function reviewTicket(ticket, recallInfo, files, claimType) {
  if (MOCK) return finalizeReview(JSON.parse(JSON.stringify(MOCK_REVIEW)));
  const blocks = fileBlocks(files);
  const intro = blocks.length
    ? "Attached above: " + blocks.length + " file(s) showing the physical repair-order hard card (time punches, initials, signatures). Cross-check them against the typed ticket below.\n\n"
    : "";
  const content = [
    ...blocks,
    { type: "text", text: intro + "Review this warranty ticket:\n\n" + ticket + recallContext(recallInfo) },
  ];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      temperature: 0,
      system: SYSTEM_PROMPT + claimTypeAddendum(claimType),
      messages: [{ role: "user", content }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "Anthropic API error " + r.status);
  let text = (data.content || []).map((c) => c.text || "").join("").trim();
  // Strip accidental code fences and grab the JSON object
  text = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI returned an unexpected format. Try again.");
  return finalizeReview(JSON.parse(text.slice(start, end + 1)));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "45mb" }));
app.use(express.urlencoded({ extended: false }));

const LOGIN_PAGE = fs.readFileSync(path.join(__dirname, "public", "login.html"), "utf8");

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
  const code = String(req.body.code || "");
  const a = Buffer.from(code);
  const b = Buffer.from(ACCESS_CODE);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).send(LOGIN_PAGE.replace("<!--MSG-->", "That code isn't right — try again."));
  }
  res.setHeader(
    "Set-Cookie",
    `wtr_auth=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${180 * 24 * 3600}${process.env.RENDER ? "; Secure" : ""}`
  );
  res.redirect("/");
});

app.get("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "wtr_auth=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/");
});

app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if ((req.path === "/" || req.path === "/appeal" || req.path === "/history") && req.method === "GET") {
    return res.send(LOGIN_PAGE.replace("<!--MSG-->", ""));
  }
  return res.status(401).json({ error: "not logged in" });
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
  const files = Array.isArray(req.body.files) ? req.body.files : [];
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
      type: "appeal",
      ro: extractRo(rejection + " " + ticket),
      vin: extractVin(rejection + " " + ticket) || "",
      vehicle: "",
      score: null,
      verdict: appeal?.analysis?.strength || "",
      summary: appeal?.analysis?.reason || "",
      ticket, rejection,
      result: appeal,
    });
    res.json({ appeal });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Assemble the structured repair-order fields into the canonical ticket text
// that both the AI reviewer and the deterministic cache key work from.
function assembleTicket(f) {
  const ctLabel = (CLAIM_TYPES[f.claimType] && CLAIM_TYPES[f.claimType].label) || f.claimType;
  const parts = [
    "CLAIM TYPE: " + ctLabel,
    "REPAIR ORDER #: " + f.ro + "    LINE: " + f.line,
    "VIN: " + f.vin + "    MILEAGE: " + f.mileage,
    "",
    "COMPLAINT: " + f.complaint,
    "CAUSE: " + f.cause,
    "CORRECTION: " + f.correction,
  ];
  if (f.detail) parts.push("", "ADDITIONAL REPAIR-ORDER DETAIL:", f.detail);
  return parts.join("\n").trim();
}

app.post("/api/review", async (req, res) => {
  const b = req.body || {};
  const f = {
    claimType: String(b.claimtype || b.claimType || "").trim(),
    ro: String(b.ro || "").trim(),
    line: String(b.line || "").trim(),
    vin: String(b.vin || "").trim().toUpperCase(),
    mileage: String(b.mileage || "").trim(),
    complaint: String(b.complaint || "").trim(),
    cause: String(b.cause || "").trim(),
    correction: String(b.correction || "").trim(),
    detail: String(b.detail || "").trim(),
  };
  const files = Array.isArray(b.files) ? b.files : [];

  let ticket, vinField;
  const legacy = String(b.ticket || "").trim();
  const usingFields = f.claimType || f.ro || f.line || f.vin || f.mileage || f.complaint || f.cause || f.correction;
  if (usingFields || !legacy) {
    // Structured mode: every listed field is required before a review runs.
    const missing = [];
    if (!f.claimType) missing.push("Claim Type");
    if (!f.ro) missing.push("Repair Order #");
    if (!f.line) missing.push("Line #");
    if (!f.vin) missing.push("VIN");
    if (!f.mileage) missing.push("Mileage");
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
    // Claim type is part of the cache key: the same repair on a different claim
    // type is a different review, so it must never collide in the cache.
    const key = reviewCacheKey("review", ticket, files, "ct:" + (f.claimType || ""));
    let review, recallInfo;
    const hit = REVIEW_CACHE[key];
    if (hit && hit.review) {
      // Identical ticket seen before -> return the exact same review + score.
      review = hit.review;
      recallInfo = hit.recallInfo || null;
    } else {
      recallInfo = vin ? await lookupRecalls(vin) : null;
      review = await reviewTicket(ticket, recallInfo, files, f.claimType);
      REVIEW_CACHE[key] = { review, recallInfo, ts: Date.now() };
      saveReviewCache();
    }
    addHistory({
      type: "review",
      claimType: f.claimType || "",
      claimLabel: (CLAIM_TYPES[f.claimType] && CLAIM_TYPES[f.claimType].label) || "",
      ro: f.ro || extractRo(ticket),
      line: f.line || "",
      mileage: f.mileage || "",
      vin: vin || "",
      vehicle: recallInfo && !recallInfo.error ? (recallInfo.year + " " + recallInfo.make + " " + recallInfo.model) : "",
      score: review?.score ?? null,
      verdict: review?.verdict || "",
      summary: review?.summary || "",
      ticket, rejection: "",
      result: review,
      recallInfo,
    });
    res.json({ review, recallInfo });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// History endpoints
app.get("/history", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "history.html"));
});

app.get("/api/history", (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const { matched, records, fallback, needles } = searchHistory(req.query.q, {
    type: req.query.type === "review" || req.query.type === "appeal" ? req.query.type : null,
    verdict: req.query.verdict ? String(req.query.verdict) : null,
    days: parseInt(req.query.days, 10) || null,
  });
  const list = records.slice(offset, offset + limit).map((r) => ({
    id: r.id, ts: r.ts, type: r.type, ro: r.ro, vin: r.vin, vehicle: r.vehicle,
    score: r.score, verdict: r.verdict, summary: String(r.summary || "").slice(0, 220),
  }));
  res.json({ total: HISTORY.length, matched, offset, fallback, needles, results: list });
});

app.get("/api/history/:id", (req, res) => {
  const rec = HISTORY.find((r) => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: "Not found" });
  res.json({ record: rec });
});

app.delete("/api/history/:id", (req, res) => {
  const i = HISTORY.findIndex((r) => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Not found" });
  HISTORY.splice(i, 1);
  saveHistory();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log("Warranty Ticket Reviewer listening on port " + PORT));
