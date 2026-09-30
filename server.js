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
// Google's own model-list endpoint isn't fully trustworthy: it can list a
// model as "supports generateContent" even after that model has actually
// been retired for this account (you only find out when the real call
// 404s). So instead of trusting the list to pick ONE model, we rank every
// candidate the list returns and try them in order at call time, skipping
// forward past 404s. GEMINI_MODEL env var overrides all of this.
let modelListCache = null; // ordered array of candidate model names
let modelListAt = 0;
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;
const deadModels = new Set(); // 404'd this run — never retry them again

function versionOf(name) {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

async function getModelCandidates() {
  if (GEMINI_MODEL) return [GEMINI_MODEL];
  if (modelListCache && Date.now() - modelListAt < MODEL_CACHE_MS) {
    return modelListCache.filter((n) => !deadModels.has(n));
  }

  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": GEMINI_API_KEY },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));

    const candidates = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /^gemini-/.test(n) && !/vision|embedding|tts|image|live/.test(n));

    // Prefer newer major versions first, then flash-lite > flash > pro
    // within the same version (cheapest/fastest first).
    const tierOf = (n) => (/flash-lite/.test(n) ? 0 : /flash/.test(n) ? 1 : /pro/.test(n) ? 2 : 3);
    candidates.sort((a, b) => versionOf(b) - versionOf(a) || tierOf(a) - tierOf(b));

    if (!candidates.length) throw new Error("no usable models returned by API");

    modelListCache = candidates;
    modelListAt = Date.now();
    console.log(`[gemini] model candidates: ${candidates.join(", ")}`);
    return candidates.filter((n) => !deadModels.has(n));
  } catch (err) {
    console.error("[gemini] model list fetch failed:", err.message);
    return (modelListCache || ["gemini-flash-latest"]).filter((n) => !deadModels.has(n));
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
// Node's default fetch will hang up to 5 minutes on a stalled connection
// before giving up. That's far too long for a chat reply, so every outbound
// call here gets an explicit, much shorter timeout via AbortSignal.
const GEMINI_TIMEOUT_MS = 15_000;
const WHATSAPP_TIMEOUT_MS = 10_000;

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
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
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
    const candidates = await getModelCandidates();
    let ok = false, status = 0, data = null, model = null;

    outer: for (model of candidates) {
      // Up to 2 tries per model, in case of a one-off blip.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          ({ ok, status, data } = await callGemini(model, payloadTurns));
        } catch (err) {
          // AbortSignal.timeout() throws rather than returning a status —
          // treat a stalled/hung connection the same as a 503 (retryable).
          ok = false;
          status = err.name === "TimeoutError" || err.name === "AbortError" ? 408 : 0;
          data = { error: err.message };
        }
        if (ok) break outer;

        console.error(`[gemini] ${model} failed: ${status}`);

        if (status === 404 && !GEMINI_MODEL) {
          deadModels.add(model); // never try this one again this run
          break; // move to next candidate immediately
        }
        if ([408, 429, 500, 503].includes(status) && attempt === 1) {
          await sleep(800); // brief pause, then one more try on the same model
          continue;
        }
        break; // exhausted retries on this model, or a non-retryable error
      }
    }

    if (!ok) {
      console.error("[gemini] all attempts failed:", status, JSON.stringify(data));
      if (status === 429) return "I'm rate limited right now. Try again in a minute.";
      if (status === 503 || status === 408) return "The AI is very busy right now. Please try again in a moment.";
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
    try {
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
          signal: AbortSignal.timeout(WHATSAPP_TIMEOUT_MS),
        }
      );

      if (!r.ok) {
        console.error("[whatsapp] send failed:", r.status, await r.text());
      }
    } catch (err) {
      console.error("[whatsapp] send request failed:", err.message);
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
        signal: AbortSignal.timeout(WHATSAPP_TIMEOUT_MS),
      }
    );
  } catch {
    /* non-critical */
  }
}

app.listen(PORT, () => console.log(`listening on :${PORT}`));
