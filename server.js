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
- If the pasted text is not a warranty ticket at all, say so in "summary", set score to 0 and verdict to "high_risk", and leave the arrays sensible but short.`;

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

async function reviewTicket(ticket) {
  if (MOCK) return MOCK_REVIEW;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Review this warranty ticket:\n\n" + ticket }],
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
app.use(express.json({ limit: "200kb" }));
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
  try {
    const review = await reviewTicket(ticket);
    res.json({ review });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("Warranty Ticket Reviewer listening on port " + PORT));
