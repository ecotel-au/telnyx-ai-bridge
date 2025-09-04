// server.js — Telnyx Call Control webhook (AU whisper coach)
// Sam @ Ecotel — production-ready with Ed25519 verification

import express from "express";
import axios from "axios";
import getRawBody from "raw-body";
import nacl from "tweetnacl";
import pino from "pino";

// ---------- Config from environment ----------
const {
  TELNYX_API_KEY,        // Mission Control → API Keys
  TELNYX_PUBLIC_KEY,     // Voice → Settings → Webhooks → Public key (Ed25519)
  FROM_NUMBER,           // +61756060210
  CONNECTION_ID,         // Voice API App connection_id (UUID)
  AI_ASSISTANT_ID,       // AI Assistants → assistant_id
  ALLOW_LIST             // Comma separated CLIDs: +614...,+614...
} = process.env;

if (!TELNYX_API_KEY || !FROM_NUMBER || !CONNECTION_ID) {
  console.error("Missing required env vars. Set TELNYX_API_KEY, FROM_NUMBER, CONNECTION_ID.");
  process.exit(1);
}

const allowList = new Set(
  (ALLOW_LIST || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

const log = pino({ level: process.env.LOG_LEVEL || "info" });

// ---------- HTTP client for Call Control ----------
const telnyx = axios.create({
  baseURL: "https://api.telnyx.com/v2",
  headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
  timeout: 10000
});

// ---------- Express app & raw body capture ----------
const app = express();

// Keep the raw payload for signature verification; also parse JSON for handlers.
app.use(async (req, res, next) => {
  try {
    req.rawBody = await getRawBody(req);
    if ((req.headers["content-type"] || "").includes("application/json")) {
      try { req.body = JSON.parse(req.rawBody.toString("utf8")); } catch {}
    }
    next();
  } catch (err) {
    next(err);
  }
});

// ---------- Telnyx Ed25519 signature verification ----------
function verifyTelnyxSignature(req) {
  // Docs: Telnyx-Signature-Ed25519 + Telnyx-Timestamp headers.
  if (!TELNYX_PUBLIC_KEY) return true; // allow if not configured (dev only)
  const sig = req.headers["telnyx-signature-ed25519"];
  const ts  = req.headers["telnyx-timestamp"];
  if (!sig || !ts) return false;

  // message = timestamp + '|' + rawBody
  const message = Buffer.concat([
    Buffer.from(String(ts), "utf8"),
    Buffer.from("|", "utf8"),
    Buffer.from(req.rawBody || "")
  ]);

  try {
    const ok = nacl.sign.detached.verify(
      message,
      Buffer.from(sig, "base64"),
      Buffer.from(TELNYX_PUBLIC_KEY, "base64")
    );
    return ok;
  } catch {
    return false;
  }
}

// ---------- Small helpers ----------
const calls = new Map(); // agent_ccid -> { stage, conf_id, customer_ccid }

const e164AU = (digits) => {
  const d = (digits || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("+")) return d;
  if (d.startsWith("61")) return "+" + d;
  if (d.startsWith("0")) return "+61" + d.slice(1);
  return "+61" + d;
};

const speak = (ccid, text) =>
  telnyx.post(`/calls/${ccid}/actions/speak`, { payload: text });

const gatherUsingSpeak = (ccid, prompt, client_state) =>
  telnyx.post(`/calls/${ccid}/actions/gather_using_speak`, {
    payload: prompt,
    terminating_digit: "#",
    minimum_digits: 4,
    maximum_digits: 15,
    client_state
  });

const gather = (ccid, client_state) =>
  telnyx.post(`/calls/${ccid}/actions/gather`, {
    minimum_digits: 2,
    maximum_digits: 2,
    inter_digit_timeout_millis: 5000,
    client_state
  });

// ---------- Health ----------
app.get("/", (_req, res) => res.status(200).send("OK"));

// ---------- Main webhook ----------
app.post("/telnyx/voice", async (req, res) => {
  // Always 2xx immediately to avoid retries/timeouts.
  res.sendStatus(200);

  if (!verifyTelnyxSignature(req)) {
    log.warn({ h: req.headers }, "Invalid Telnyx signature");
    return;
  }

  const ev = req.body?.data;
  if (!ev) return;

  const type = ev.event_type;
  const payload = ev.payload || {};
  const ccid = payload.call_control_id;
  const direction = payload.direction;

  try {
    // 1) Inbound guard + collect target
    if (type === "call.initiated" && direction === "incoming") {
      const from = payload.from?.number;
      await telnyx.post(`/calls/${ccid}/actions/answer`);

      if (allowList.size && !allowList.has(from)) {
        log.info({ from }, "Rejected: CLID not in allow-list");
        await speak(ccid, "This number is not authorised. Goodbye.");
        await telnyx.post(`/calls/${ccid}/actions/hangup`);
        return;
      }

      calls.set(ccid, { stage: "collect", agent_ccid: ccid });
      await gatherUsingSpeak(
        ccid,
        "Enter the number to call, then press hash.",
        "collect_target"
      );
      return;
    }

    // 2) DTMF result with target number
    if (type === "call.gather.ended" && payload.client_state === "collect_target") {
      const agent_ccid = ccid;
      const to = e164AU(payload.digits);
      if (!to) {
        await speak(agent_ccid, "Invalid number. Goodbye.");
        await telnyx.post(`/calls/${agent_ccid}/actions/hangup`);
        return;
      }

      await telnyx.post("/calls", { to, from: FROM_NUMBER, connection_id: CONNECTION_ID });
      const s = calls.get(agent_ccid) || {};
      s.stage = "dialling";
      calls.set(agent_ccid, s);
      return;
    }

    // 3) Outbound answered → make conference & join
    if (type === "call.answered" && direction === "outgoing") {
      const customer_ccid = ccid;
      const agent_ccid = [...calls.keys()].find(k => (calls.get(k)?.stage === "dialling"));
      if (!agent_ccid) return;

      const conf = await telnyx.post("/conferences", {
        call_control_id: agent_ccid,
        name: `conf-${Date.now()}`
      });
      const conf_id = conf.data?.data?.id;

      await telnyx.post(`/conferences/${conf_id}/actions/join`, {
        call_control_id: customer_ccid
      });

      // Start Telnyx AI Assistant on the AGENT leg only (whisper model)
      if (AI_ASSISTANT_ID) {
        await telnyx.post(`/calls/${agent_ccid}/actions/ai_assistant_start`, {
          assistant_id: AI_ASSISTANT_ID
          // You can add per-call overrides here (system_instructions, voice, etc.)
        });
      }

      // Start silent gather to listen for *2
      await gather(agent_ccid, "listen_whisper");

      calls.set(agent_ccid, { stage: "live", agent_ccid, customer_ccid, conf_id });
      log.info({ conf_id }, "Conference established");
      return;
    }

    // 4) Whisper trigger
    if (type === "call.gather.ended" && payload.client_state === "listen_whisper") {
      if (payload.digits === "*2") {
        // Short, tactical whisper to AGENT only
        await speak(ccid, "Recommend the ninety nine per user plan, then confirm how many users.");
      }
      // Keep listening
      await gather(ccid, "listen_whisper");
      return;
    }

    // 5) Optional post-call insights (route later to Zoho Flow if you want)
    if (type === "call.conversation_insights.generated") {
      log.info({ insights: ev.payload }, "Conversation insights");
      return;
    }

    // 6) Cleanup when agent or customer hangs up
    if (type === "call.hangup") {
      const entry = calls.get(ccid) || [...calls.values()].find(v => v.customer_ccid === ccid);
      if (entry) {
        calls.delete(entry.agent_ccid);
      }
      return;
    }
  } catch (err) {
    const data = err?.response?.data;
    log.error({ err: data || err.message }, "Webhook handler error");
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log.info(`listening on :${PORT}`));
