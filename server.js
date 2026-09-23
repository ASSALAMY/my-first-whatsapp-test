import express from "express";
import crypto from "crypto";

const app = express();

// ============================================================
// EXPRESS / RAW BODY
// ============================================================

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ============================================================
// ENVIRONMENT VARIABLES
// ============================================================

const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  APP_SECRET,
  GEMINI_API_KEY,
  GRAPH_VERSION = "v21.0",
  SYSTEM_PROMPT =
    "You are a helpful WhatsApp assistant. Keep replies short and friendly, under 600 characters. Plain text only, no markdown.",
} = process.env;

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
// MEMORY
// ============================================================

const seenMessages = new Set();
const history = new Map();

const MAX_TURNS = 10;

// ============================================================
// GEMINI MODEL AUTOMATIC SELECTION
// ============================================================

let resolvedModel = null;
let modelResolvedAt = 0;

const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

// Newer models are preferred.
// The server will actually TEST the model before selecting it.
const PREFERRED_PATTERNS = [
  /^gemini-3\.8-flash$/i,
  /^gemini-3\.7-flash$/i,
  /^gemini-3\.6-flash$/i,
  /^gemini-3\.5-flash$/i,
  /^gemini-3\.5-flash-lite$/i,
  /^gemini-3-flash-preview$/i,
  /^gemini-2\.5-flash$/i,
  /^gemini-flash-lite-latest$/i,
  /^gemini-flash-latest$/i,
  /^gemini-.*flash-lite$/i,
  /^gemini-.*flash$/i,
  /^gemini-.*pro$/i,
];

// ============================================================
// GET AVAILABLE GEMINI MODELS
// ============================================================

async function getAvailableGeminiModels() {
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
      `Failed to get Gemini models: ${JSON.stringify(data)}`
    );
  }

  const models = (data.models || [])
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
        !/embedding|vision|tts|image|live|transcribe|robotics|computer-use/i.test(
          name
        )
    );

  return models;
}

// ============================================================
// RANK GEMINI MODELS
// ============================================================

function rankGeminiModels(models) {
  const ranked = [];

  for (const pattern of PREFERRED_PATTERNS) {
    for (const model of models) {
      if (
        pattern.test(model) &&
        !ranked.includes(model)
      ) {
        ranked.push(model);
      }
    }
  }

  for (const model of models) {
    if (!ranked.includes(model)) {
      ranked.push(model);
    }
  }

  return ranked;
}

// ============================================================
// TEST A GEMINI MODEL
// ============================================================

async function testGeminiModel(model) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const response = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },

      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: "Reply with the word OK.",
              },
            ],
          },
        ],

        generationConfig: {
          maxOutputTokens: 5,
        },
      }),
    });

    const data = await response.json();

    if (response.ok) {
      return {
        available: true,
        status: response.status,
      };
    }

    console.warn(
      `[gemini] Model ${model} rejected: ${response.status}`
    );

    return {
      available: false,
      status: response.status,
      error: data,
    };
  } catch (error) {
    console.warn(
      `[gemini] Could not test ${model}: ${error.message}`
    );

    return {
      available: false,
      status: 0,
      error,
    };
  }
}

// ============================================================
// AUTOMATIC GEMINI MODEL RESOLVER
// ============================================================

async function resolveGeminiModel() {
  if (
    resolvedModel &&
    Date.now() - modelResolvedAt < MODEL_CACHE_MS
  ) {
    return resolvedModel;
  }

  console.log(
    "[gemini] Finding a working Gemini model..."
  );

  try {
    const availableModels =
      await getAvailableGeminiModels();

    console.log(
      "[gemini] Available models:",
      availableModels.join(", ")
    );

    const rankedModels =
      rankGeminiModels(availableModels);

    console.log(
      "[gemini] Testing models in this order:",
      rankedModels.join(", ")
    );

    for (const model of rankedModels) {
      console.log(
        `[gemini] Testing model: ${model}`
      );

      const result =
        await testGeminiModel(model);

      if (result.available) {
        resolvedModel = model;
        modelResolvedAt = Date.now();

        console.log(
          `[gemini] Selected working model: ${model}`
        );

        return model;
      }

      console.warn(
        `[gemini] ${model} is unavailable for this API key.`
      );
    }

    throw new Error(
      "No working Gemini model was found."
    );
  } catch (error) {
    console.error(
      "[gemini] Automatic model selection failed:",
      error.message
    );

    if (resolvedModel) {
      return resolvedModel;
    }

    throw error;
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (_req, res) => {
  res.status(200).send(
    "WhatsApp Gemini Bot is running."
  );
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
    console.log(
      "[webhook] Verification successful."
    );

    return res.status(200).send(challenge);
  }

  console.warn(
    "[webhook] Verification failed."
  );

  return res.sendStatus(403);
});

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================

app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) {
    console.warn(
      "[webhook] Invalid Meta signature."
    );

    return res.sendStatus(401);
  }

  // Respond to Meta immediately.
  res.sendStatus(200);

  try {
    const value =
      req.body?.entry?.[0]?.changes?.[0]?.value;

    const message = value?.messages?.[0];

    // Ignore status updates.
    if (!message) {
      return;
    }

    // Prevent duplicate messages.
    if (seenMessages.has(message.id)) {
      return;
    }

    seenMessages.add(message.id);

    if (seenMessages.size > 1000) {
      seenMessages.clear();
    }

    const from = message.from;

    const profileName =
      value?.contacts?.[0]?.profile?.name ||
      "there";

    // ========================================================
    // READ MESSAGE
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

    await markAsRead(message.id);

    // ========================================================
    // RESET
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
    // GEMINI
    // ========================================================

    const reply = await askGemini(
      from,
      text
    );

    // ========================================================
    // WHATSAPP RESPONSE
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
      "x-goog-api-key": GEMINI_API_KEY,
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
// ASK GEMINI
// ============================================================

async function askGemini(
  waId,
  userText
) {
  let turns =
    history.get(waId) || [];

  turns.push({
    role: "user",

    parts: [
      {
        text: userText,
      },
    ],
  });

  const payloadTurns =
    turns.slice(-MAX_TURNS * 2);

  try {
    let model =
      await resolveGeminiModel();

    console.log(
      `[gemini] Using model: ${model}`
    );

    let result =
      await callGemini(
        model,
        payloadTurns
      );

    // ========================================================
    // IF MODEL STOPS WORKING, FIND ANOTHER
    // ========================================================

    if (
      !result.ok &&
      (result.status === 404 ||
        result.status === 400)
    ) {
      console.warn(
        `[gemini] Model ${model} failed. Finding another model...`
      );

      resolvedModel = null;
      modelResolvedAt = 0;

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
    // HANDLE ERRORS
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
    // GET GEMINI TEXT
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
// SEND WHATSAPP MESSAGE
// ============================================================

async function sendText(
  to,
  body
) {
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
// MARK MESSAGE AS READ
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
    console.warn(
      "[whatsapp] Could not mark message as read:",
      error.message
    );
  }
}

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(
    `WhatsApp Gemini Bot listening on port ${PORT}`
  );

  console.log(
    "[gemini] Automatic model selection is ENABLED."
  );
});
