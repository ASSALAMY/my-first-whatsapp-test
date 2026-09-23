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
// Swap for Redis or a DB when you go past testing.
const seenMessages = new Set(); // dedupe Meta's webhook retries
const history = new Map(); // waId -> [{role, parts}]
const MAX_TURNS = 10;

// ---------------------------------------------------------------- Gemini model auto-detection
// Google periodically retires model names. Instead of hardcoding one, we ask
// the API what's actually available and pick the best free/fast chat model,
// then cache that choice for the life of this process. If GEMINI_MODEL is
// set in the environment, that overrides auto-detection entirely.
let resolvedModel = GEMINI_MODEL || null;
let modelResolvedAt = 0;
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000; // re-check every 6h in case of new releases

// Preference order: newest/cheapest "flash" style models first. This list is
// just a tie-breaker for when several models are simultaneously available;
// the actual availability check always comes from the live API response.
const PREFERRED_PATTERNS = [
  /^gemini-.*flash-lite$/,
  /^gemini-.*flash$/,
  /^gemini-.*pro$/,
];

async function resolveGeminiModel() {
  const fresh = resolvedModel && Date.now() - modelResolvedAt < MODEL_CACHE_MS;
  if (fresh) return resolvedModel;
  if (GEMINI_MODEL) return GEMINI_MODEL; // explicit override, never auto-changes

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { headers: { "x-goog-api-key": GEMINI_API_KEY } }
    );
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));

    const candidates = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((name) => /^gemini-/.test(name) && !/vision|embedding|tts|image|live/.test(name));

    let pick = null;
    for (const pattern of PREFERRED_PATTERNS) {
      pick = candidates.find((name) => pattern.test(name));
      if (pick) break;
    }
    pick = pick || candidates[0];

    if (!pick) throw new Error("no usable models returned by API");

    console.log(`[gemini] auto-selected model: ${pick}`);
    resolvedModel = pick;
    modelResolvedAt = Date.now();
    return pick;
  } catch (err) {
    console.error("[gemini] model auto-detection failed:", err.message);
    // Fall back to whatever last worked, or a reasonable stable guess.
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

  // Ack immediately — Meta gives you ~20s before it retries.
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return; // status update (delivered/read), not a message

    if (seenMessages.has(message.id)) return;
    seenMessages.add(message.id);
    if (seenMessages.size > 1000) seenMessages.clear();

    const from = message.from; // user's number in international format
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

// ---------------------------------------------------------------- Gemini
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
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function askGemini(waId, userText) {
  const turns = history.get(waId) || [];
  turns.push({ role: "user", parts: [{ text: userText }] });
  const payloadTurns = turns.slice(-MAX_TURNS * 2);

  try {
    let model = await resolveGeminiModel();
    let { ok, status, data } = await callGemini(model, payloadTurns);

    // Model we cached just got retired mid-flight — force a fresh lookup once.
    if (!ok && status === 404 && !GEMINI_MODEL) {
      console.warn(`[gemini] cached model "${model}" is gone, re-resolving...`);
      modelResolvedAt = 0;
      resolvedModel = null;
      model = await resolveGeminiModel();
      ({ ok, status, data } = await callGemini(model, payloadTurns));
    }

    if (!ok) {
      console.error("[gemini] error:", status, JSON.stringify(data));
      if (status === 429) return "I'm rate limited right now. Try again in a minute.";
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
