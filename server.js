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
    "complaint": "claim-ready Complaint line based only on facts present in the ticket",
    "cause": "claim-ready Cause statement",
    "correction": "claim-ready Correction statement"
  },
  "questions": ["anything the tech/advisor should answer or add before submitting, as short direct questions"]
}

Rules:
- Judge only from what is written. Never invent test results, part numbers, times, or diagnostic steps that are not in the ticket - if the rewrite needs a fact that is missing, put a bracketed placeholder like [ADD PUNCH TIME] and list it in "questions".
- "Found bad, replaced"-style causes, missing diagnosis, wear/maintenance items claimed as warranty, aftermarket-part involvement, time far over the labor op, and story inconsistencies are the classic rejection triggers - call them out.
- Be direct and practical, like a warranty admin who wants the claim to get PAID, not a lecture.
- Never question or flag the calendar dates on the ticket as implausible or "in the future" - assume the ticket's dates are current. Only flag dates for internal inconsistency (e.g. date out before date in, disclosure before repair).
- If the pasted text is not a warranty ticket at all, say so in "summary", set score to 0 and verdict to "high_risk", and leave the arrays sensible but short.
- If images or PDFs of the physical repair-order HARD CARD are attached: the hard copy is the OFFICIAL record of the repair (per 1.2.01). Read them carefully and cross-check against the typed ticket. Verify: time punches present (start AND finish for each actual-time repair, per 1.3.04); add-on repairs initialed by service management on the same line with "ADD" in the labor op column (per 1.2.04); required signatures/authorizations present (customer signature or management authorization for dealer vehicles - rubber stamps not acceptable); handwritten tech comments and test results; and that the hard card matches the typed story (mileage, dates, parts, hours). Add completeness entries for "Hard card: time punches", "Hard card: signatures/authorizations", and "Hard card vs ticket consistency". Flag ANY discrepancy between hard card and typed claim as serious or critical - hard-card mismatches are classic audit findings. If an attached file is unreadable or isn't a repair order, say so in a completeness note.` +
  (FORD_REFERENCE
    ? `\n\nYou also have the dealership's distilled Ford Warranty & Policy Manual reference below. Apply these ACTUAL Ford rules when reviewing: check coverage periods against the vehicle's age/mileage, flag missing prior approvals, missing required test readings, time-limit problems, and exclusions. When a finding is based on a specific rule, cite the manual section number (e.g. "per 1.3.04") in the note or detail so the advisor can look it up.\n\n=== FORD WARRANTY & POLICY REFERENCE ===\n` + FORD_REFERENCE
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

async function reviewTicket(ticket, recallInfo, files) {
  if (MOCK) return MOCK_REVIEW;
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
      system: SYSTEM_PROMPT,
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
  return JSON.parse(text.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "45mb" }));
app.use(express.urlencoded({ extended: false }));

const LOGIN_PAGE = fs.readFileSync(path.join(__dirname, "public", "login.html"), "utf8");

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
  if (req.path === "/" && req.method === "GET") {
    return res.send(LOGIN_PAGE.replace("<!--MSG-->", ""));
  }
  return res.status(401).json({ error: "not logged in" });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/review", async (req, res) => {
  const ticket = String(req.body.ticket || "").trim();
  if (!ticket) return res.status(400).json({ error: "Paste a ticket first." });
  if (ticket.length > 60000) return res.status(400).json({ error: "That ticket is too long — trim it down." });
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  try {
    const vin = extractVin(ticket);
    const recallInfo = vin ? await lookupRecalls(vin) : null;
    const review = await reviewTicket(ticket, recallInfo, files);
    res.json({ review, recallInfo });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("Warranty Ticket Reviewer listening on port " + PORT));
