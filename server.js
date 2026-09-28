import express from "express";
import crypto from "crypto";

const app = express();

// Keep the raw body so we can verify Meta's signature.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  APP_SECRET,
  GEMINI_API_KEY,
  GEMINI_MODEL, // optional: force a specific model, skipping auto-detection
  GRAPH_VERSION = "v21.0",
  SYSTEM_PROMPT = "You are a helpful WhatsApp assistant. Keep replies short and friendly, under 600 characters. Plain text only, no markdown.",
} = process.env;

for (const k of ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "GEMINI_API_KEY"]) {
  if (!process.env[k]) console.warn(`[warn] missing env var: ${k}`);
}

// ---------------------------------------------------------------- state
// In-memory only. Render restarts / sleeps will wipe this.
const seenMessages = new Set(); // dedupe Meta's webhook retries
const history = new Map(); // waId -> [{role, parts}]
const MAX_TURNS = 10;

// ---------------------------------------------------------------- Gemini model auto-detection
// Google retires model names regularly. We ask the API what's live, pick the
// best fast model, cache it, and keep a few ranked fallbacks for when the
// main one is overloaded (503). GEMINI_MODEL env var overrides all of this.
let resolvedModel = GEMINI_MODEL || null;
let fallbackModels = [];
let modelResolvedAt = 0;
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

const PREFERRED_PATTERNS = [
  /^gemini-.*flash-lite$/,
  /^gemini-.*flash$/,
  /^gemini-.*pro$/,
];

async function resolveGeminiModel() {
  if (GEMINI_MODEL) return GEMINI_MODEL;
  if (resolvedModel && Date.now() - modelResolvedAt < MODEL_CACHE_MS) return resolvedModel;

  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": GEMINI_API_KEY },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));

    const candidates = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /^gemini-/.test(n) && !/vision|embedding|tts|image|live/.test(n));

    // Rank by preference order, keep the rest as a last resort.
    const ranked = [];
    for (const pattern of PREFERRED_PATTERNS) {
      for (const n of candidates) if (pattern.test(n) && !ranked.includes(n)) ranked.push(n);
    }
    for (const n of candidates) if (!ranked.includes(n)) ranked.push(n);

    if (!ranked.length) throw new Error("no usable models returned by API");

    resolvedModel = ranked[0];
    fallbackModels = ranked.slice(1, 4);
    modelResolvedAt = Date.now();
    console.log(`[gemini] auto-selected model: ${resolvedModel} (fallbacks: ${fallbackModels.join(", ") || "none"})`);
    return resolvedModel;
  } catch (err) {
    console.error("[gemini] model auto-detection failed:", err.message);
    return resolvedModel || "gemini-flash-latest";
  }
}

// ---------------------------------------------------------------- health
app.get("/", (_req, res) => res.status(200).send("ok"));

// ---------------------------------------------------------------- webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[webhook] verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------------------------------------------------------------- incoming messages (POST)
app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) {
    console.warn("[webhook] bad signature");
    return res.sendStatus(401);
  }

  // Ack immediately — Meta retries if you take too long.
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return; // status update (delivered/read), not a message

    if (seenMessages.has(message.id)) return;
    seenMessages.add(message.id);
    if (seenMessages.size > 1000) seenMessages.clear();

    const from = message.from;
    const profileName = value?.contacts?.[0]?.profile?.name || "there";

    let text;
    if (message.type === "text") {
      text = message.text.body;
    } else if (message.type === "interactive") {
      text =
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title;
    } else {
      await sendText(from, `I can only read text messages right now (you sent: ${message.type}).`);
      return;
    }

    console.log(`[msg] ${profileName} <${from}>: ${text}`);

    await markAsRead(message.id);

    if (text.trim().toLowerCase() === "/reset") {
      history.delete(from);
      await sendText(from, "Conversation reset. ✅");
      return;
    }

    const reply = await askGemini(from, text);
    await sendText(from, reply);
  } catch (err) {
    console.error("[webhook] handler error:", err);
  }
});

// ---------------------------------------------------------------- Meta signature check
function verifySignature(req) {
  if (!APP_SECRET) return true; // skip if you haven't set it yet
  const header = req.get("x-hub-signature-256");
  if (!header || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- Gemini call
async function callGemini(model, turns) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: turns,
      generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
    }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askGemini(waId, userText) {
  const turns = history.get(waId) || [];
  turns.push({ role: "user", parts: [{ text: userText }] });
  const payloadTurns = turns.slice(-MAX_TURNS * 2);

  try {
    const primary = await resolveGeminiModel();
    // Try the main model twice (transient blips), then each fallback once.
    const attempts = [primary, primary, ...(GEMINI_MODEL ? [] : fallbackModels)];
    let ok = false, status = 0, data = null, reResolved = false;

    for (let i = 0; i < attempts.length; i++) {
      const model = attempts[i];
      ({ ok, status, data } = await callGemini(model, payloadTurns));
      if (ok) break;

      console.error(`[gemini] ${model} failed: ${status}`);

      // Model retired: re-detect once and try the fresh pick next.
      if (status === 404 && !GEMINI_MODEL && !reResolved) {
        reResolved = true;
        modelResolvedAt = 0;
        resolvedModel = null;
        attempts.splice(i + 1, 0, await resolveGeminiModel());
        continue;
      }
      // Overloaded / rate limited / server hiccup: pause, then move on.
      if ([429, 500, 503].includes(status)) {
        await sleep(1000 * (i + 1));
        continue;
      }
      break; // 400/403 etc. won't be fixed by retrying
    }

    if (!ok) {
      console.error("[gemini] all attempts failed:", status, JSON.stringify(data));
      if (status === 429) return "I'm rate limited right now. Try again in a minute.";
      if (status === 503) return "The AI is very busy right now. Please try again in a moment.";
      return "Sorry, I couldn't generate a reply. Try again?";
    }

    const reply =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join("") || "Hmm, I didn't get that. Can you rephrase?";

    turns.push({ role: "model", parts: [{ text: reply }] });
    history.set(waId, turns.slice(-MAX_TURNS * 2));

    return reply;
  } catch (err) {
    console.error("[gemini] fetch failed:", err);
    return "Something went wrong on my side. Try again shortly.";
  }
}

// ---------------------------------------------------------------- WhatsApp send
async function sendText(to, body) {
  // WhatsApp hard-caps text bodies at 4096 chars.
  const chunks = body.match(/[\s\S]{1,4000}/g) || [body];

  for (const chunk of chunks) {
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body: chunk },
        }),
      }
    );

    if (!r.ok) {
      console.error("[whatsapp] send failed:", r.status, await r.text());
    }
  }
}

async function markAsRead(messageId) {
  try {
    await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
        }),
      }
    );
  } catch {
    /* non-critical */
  }
}

app.listen(PORT, () => console.log(`listening on :${PORT}`));
