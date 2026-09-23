# WhatsApp + Gemini bot (Render)

Meta WhatsApp Cloud API test number → Render webhook → Gemini → reply.

## 1. Get your keys

**Gemini:** https://aistudio.google.com/apikey — free tier, no card needed.

**WhatsApp:** https://developers.facebook.com → Create App → type **Business** → add the **WhatsApp** product.
On the *API Setup* page you get, for free:
- a **test phone number** (Meta owns it, you send *from* it)
- a **temporary access token** — expires in 24h
- a **Phone number ID** — copy this, not the phone number
- a spot to add up to **5 recipient numbers**. Add your own WhatsApp number there and confirm the OTP. The bot can only message numbers on this list.

App secret is under *App settings → Basic*.

## 2. Deploy

```bash
git init && git add . && git commit -m "init"
git remote add origin git@github.com:YOU/whatsapp-gemini-bot.git
git push -u origin main
```

On Render: **New → Web Service** → connect the repo.
- Runtime: Node
- Build: `npm install`
- Start: `npm start`
- Add every variable from `.env.example` under *Environment*

Don't set `PORT` — Render injects it.

You'll get a URL like `https://whatsapp-gemini-bot.onrender.com`.

## 3. Connect the webhook

Meta → WhatsApp → **Configuration** → Edit webhook:
- Callback URL: `https://YOUR-APP.onrender.com/webhook`
- Verify token: the exact `VERIFY_TOKEN` string you set on Render

Click Verify and Save. Then hit **Manage** next to Webhook fields and subscribe to **messages**.

## 4. Test

From the personal number you registered as a recipient, message the test number. You should get a Gemini reply. Send `/reset` to clear history.

## Local testing

```bash
cp .env.example .env   # fill it in
node --env-file=.env --watch server.js
ngrok http 3000        # use the https URL + /webhook in Meta
```

## Gotchas

- **Render free tier sleeps after 15 min idle.** First message after sleep takes ~50s and Meta may retry it. The `seenMessages` set stops duplicate replies. Fix properly with a paid instance or an external cron pinging `/`.
- **Token expires in 24h.** For anything longer, create a System User in Meta Business Settings, assign the WhatsApp app, and generate a permanent token with `whatsapp_business_messaging` + `whatsapp_business_management`.
- **24-hour window.** You can only free-text a user within 24h of *their* last message. Outside that you need an approved template.
- **Conversation history is in memory** and dies on restart. Move to Redis/Postgres for real use.
- If the webhook won't verify, it's almost always a `VERIFY_TOKEN` mismatch or a missing `/webhook` on the URL.
