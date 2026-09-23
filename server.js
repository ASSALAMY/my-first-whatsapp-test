import express from "express";
import crypto from "crypto";

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

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

  // WhatsApp Graph API version
  GRAPH_VERSION = "v21.0",

  // Gemini system prompt
  SYSTEM_PROMPT =
    "You are a helpful WhatsApp assistant. Keep replies short and friendly, under 600 characters. Plain text only, no markdown.",
} = process.env;

// Check required environment variables
for (const key of [
  "VERIFY_TOKEN",
  "WHATSAPP_TOKEN",
  "PHONE_NUMBER_ID",
  "GEMINI_API_KEY",
]) {
  if (!process.env[key]) {
    console.warn(`[warn] Missing environment variable: ${key}`);
  }
}

// ============================================================
// CONVERSATION STATE
// ============================================================

// In-memory storage.
// Note: Render restarts can clear this.
// For production, Redis or a database is recommended.

const seenMessages = new Set();

const history = new Map();

const MAX_TURNS = 10;

// ============================================================
// GEMINI AUTOMATIC MODEL SELECTION
// ============================================================

// The server automatically discovers available Gemini models.
// You do NOT need GEMINI_MODEL in Render.

let resolvedModel = null;

let modelResolvedAt = 0;

// Re-check Google's available models every 6 hours.
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

// Preferred model types.
// Flash-Lite -> Flash -> Pro
const PREFERRED_PATTERNS = [
  /^gemini-3\.5-flash-lite$/i,
  /^gemini-3\.5-flash$/i,
  /^gemini-3\.6-flash$/i,
  /^gemini-3\.7-flash$/i,
  /^gemini-3\.8-flash$/i,
  /^gemini-3-flash-preview$/i,
  /^gemini-2\.5-flash$/i,
  /^gemini-.*flash-lite$/i,
  /^gemini-.*flash$/i,
  /^gemini-.*pro$/i,
];
];

// ============================================================
// FIND AVAILABLE GEMINI MODEL
// ============================================================

async function resolveGeminiModel() {
  // Use the cached model if it is still valid.
  if (
    resolvedModel &&
    Date.now() - modelResolvedAt < MODEL_CACHE_MS
  ) {
    return resolvedModel;
  }

  try {
    console.log("[gemini] Checking available Gemini models...");

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models",
      {
        method: "GET",
        headers: {
          "x-goog-api-key": GEMINI_API_KEY,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        `Gemini model list failed: ${JSON.stringify(data)}`
      );
    }

    // Get models that support generateContent.
    const candidates = (data.models || [])
      .filter((model) =>
        model.supportedGenerationMethods?.includes(
          "generateContent"
        )
      )
      .map((model) =>
        model.name.replace(/^models\//, "")
      )
      .filter(
        (name) =>
          /^gemini-/i.test(name) &&
          !/embedding|vision|tts|image|live/i.test(name)
      );

    if (!candidates.length) {
      throw new Error(
        "Google returned no usable Gemini generateContent models."
      );
    }

    console.log(
      "[gemini] Available models:",
      candidates.join(", ")
    );

    // Try our preferred model types.
    let selectedModel = null;

    for (const pattern of PREFERRED_PATTERNS) {
      selectedModel = candidates.find((name) =>
        pattern.test(name)
      );

      if (selectedModel) {
        break;
      }
    }

    // If no preferred model is found,
    // use the first available compatible model.
    selectedModel = selectedModel || candidates[0];

    resolvedModel = selectedModel;

    modelResolvedAt = Date.now();

    console.log(
      `[gemini] Automatically selected model: ${selectedModel}`
    );

    return selectedModel;
  } catch (error) {
    console.error(
      "[gemini] Automatic model detection failed:",
      error.message
    );

    // If a previous model worked, continue using it.
    if (resolvedModel) {
      console.log(
        `[gemini] Continuing with previous model: ${resolvedModel}`
      );

      return resolvedModel;
    }

    // No model available.
    throw new Error(
      "Unable to automatically select a Gemini model."
    );
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (_req, res) => {
  res.status(200).send("WhatsApp Gemini Bot is running.");
});

// ============================================================
// WHATSAPP WEBHOOK VERIFICATION
// ============================================================

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];

  const token = req.query["hub.verify_token"];

  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    console.log("[webhook] Verification successful.");

    return res.status(200).send(challenge);
  }

  console.warn("[webhook] Verification failed.");

  return res.sendStatus(403);
});

// ============================================================
// WHATSAPP INCOMING MESSAGES
// ============================================================

app.post("/webhook", async (req, res) => {
  // Verify Meta signature.
  if (!verifySignature(req)) {
    console.warn("[webhook] Invalid Meta signature.");

    return res.sendStatus(401);
  }

  // Immediately acknowledge Meta.
  // This helps prevent webhook retries.
  res.sendStatus(200);

  try {
    const value =
      req.body?.entry?.[0]?.changes?.[0]?.value;

    const message = value?.messages?.[0];

    // Ignore delivery/read/status events.
    if (!message) {
      return;
    }

    // Prevent duplicate processing.
    if (seenMessages.has(message.id)) {
      return;
    }

    seenMessages.add(message.id);

    // Prevent unlimited memory growth.
    if (seenMessages.size > 1000) {
      seenMessages.clear();
    }

    const from = message.from;

    const profileName =
      value?.contacts?.[0]?.profile?.name ||
      "there";

    // ========================================================
    // GET MESSAGE TEXT
    // ========================================================

    let text;

    if (message.type === "text") {
      text = message.text.body;
    } else if (message.type === "interactive") {
      text =
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title;
    } else {
      await sendText(
        from,
        `I can only read text messages right now. You sent: ${message.type}`
      );

      return;
    }

    if (!text || !text.trim()) {
      return;
    }

    console.log(
      `[msg] ${profileName} <${from}>: ${text}`
    );

    // Mark WhatsApp message as read.
    await markAsRead(message.id);

    // ========================================================
    // RESET COMMAND
    // ========================================================

    if (
      text.trim().toLowerCase() === "/reset"
    ) {
      history.delete(from);

      await sendText(
        from,
        "Conversation reset. ✅"
      );

      return;
    }

    // ========================================================
    // ASK GEMINI
    // ========================================================

    const reply = await askGemini(
      from,
      text
    );

    // ========================================================
    // SEND REPLY TO WHATSAPP
    // ========================================================

    await sendText(from, reply);
  } catch (error) {
    console.error(
      "[webhook] Handler error:",
      error
    );
  }
});

// ============================================================
// META SIGNATURE VERIFICATION
// ============================================================

function verifySignature(req) {
  // If APP_SECRET is not configured,
  // skip signature verification.
  if (!APP_SECRET) {
    return true;
  }

  const signature =
    req.get("x-hub-signature-256");

  if (!signature || !req.rawBody) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", APP_SECRET)
      .update(req.rawBody)
      .digest("hex");

  const receivedBuffer =
    Buffer.from(signature);

  const expectedBuffer =
    Buffer.from(expected);

  return (
    receivedBuffer.length ===
      expectedBuffer.length &&
    crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    )
  );
}

// ============================================================
// CALL GEMINI
// ============================================================

async function callGemini(
  model,
  turns
) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",

      "x-goog-api-key":
        GEMINI_API_KEY,
    },

    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: SYSTEM_PROMPT,
          },
        ],
      },

      contents: turns,

      generationConfig: {
        temperature: 0.7,

        maxOutputTokens: 500,
      },
    }),
  });

  const data = await response.json();

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

// ============================================================
// ASK GEMINI WITH CONVERSATION MEMORY
// ============================================================

async function askGemini(
  waId,
  userText
) {
  let turns =
    history.get(waId) || [];

  // Add user message.
  turns.push({
    role: "user",

    parts: [
      {
        text: userText,
      },
    ],
  });

  // Keep the conversation short.
  const payloadTurns =
    turns.slice(-MAX_TURNS * 2);

  try {
    // Automatically select Gemini model.
    let model =
      await resolveGeminiModel();

    console.log(
      `[gemini] Using model: ${model}`
    );

    // Call Gemini.
    let result =
      await callGemini(
        model,
        payloadTurns
      );

    // ========================================================
    // IF MODEL DISAPPEARS, FIND ANOTHER MODEL
    // ========================================================

    if (
      !result.ok &&
      (result.status === 404 ||
        result.status === 400)
    ) {
      console.warn(
        `[gemini] Model "${model}" failed. Searching for another available model...`
      );

      // Clear cached model.
      resolvedModel = null;

      modelResolvedAt = 0;

      // Find another model.
      model =
        await resolveGeminiModel();

      console.log(
        `[gemini] Retrying with model: ${model}`
      );

      result =
        await callGemini(
          model,
          payloadTurns
        );
    }

    // ========================================================
    // HANDLE GEMINI ERROR
    // ========================================================

    if (!result.ok) {
      console.error(
        "[gemini] API error:",
        result.status,
        JSON.stringify(result.data)
      );

      if (result.status === 429) {
        return "I'm rate limited right now. Please try again in a minute.";
      }

      if (result.status === 401) {
        return "The Gemini API key is invalid or has expired.";
      }

      if (result.status === 403) {
        return "The Gemini API key does not have permission to use this service.";
      }

      return "Sorry, I couldn't generate a reply right now. Please try again.";
    }

    // ========================================================
    // EXTRACT GEMINI RESPONSE
    // ========================================================

    const reply =
      result.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .filter(Boolean)
        .join("") ||
      "Hmm, I didn't get that. Can you rephrase?";

    // Save assistant response.
    turns.push({
      role: "model",

      parts: [
        {
          text: reply,
        },
      ],
    });

    // Keep only recent conversation.
    history.set(
      waId,
      turns.slice(-MAX_TURNS * 2)
    );

    return reply;
  } catch (error) {
    console.error(
      "[gemini] Request failed:",
      error
    );

    return "Something went wrong on my side. Please try again shortly.";
  }
}

// ============================================================
// SEND WHATSAPP TEXT MESSAGE
// ============================================================

async function sendText(
  to,
  body
) {
  // WhatsApp text limit is 4096 characters.
  // We use 4000 to stay safely below it.
  const chunks =
    body.match(/[\s\S]{1,4000}/g) ||
    [body];

  for (const chunk of chunks) {
    try {
      const response =
        await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${WHATSAPP_TOKEN}`,

              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              messaging_product:
                "whatsapp",

              recipient_type:
                "individual",

              to,

              type: "text",

              text: {
                preview_url: false,

                body: chunk,
              },
            }),
          }
        );

      if (!response.ok) {
        console.error(
          "[whatsapp] Send failed:",
          response.status,
          await response.text()
        );
      }
    } catch (error) {
      console.error(
        "[whatsapp] Send request failed:",
        error
      );
    }
  }
}

// ============================================================
// MARK WHATSAPP MESSAGE AS READ
// ============================================================

async function markAsRead(
  messageId
) {
  try {
    await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${WHATSAPP_TOKEN}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          messaging_product:
            "whatsapp",

          status: "read",

          message_id: messageId,
        }),
      }
    );
  } catch (error) {
    // Marking as read is not critical.
    console.warn(
      "[whatsapp] Could not mark message as read:",
      error.message
    );
  }
}

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `WhatsApp Gemini bot listening on port ${PORT}`
    );

    console.log(
      "[gemini] Automatic model selection is ENABLED."
    );
  }
);
