// server.js — Telnyx Call Control webhook (AU whisper coach)
// Base64 client_state, TTS voice set, allowlist normalised, optional signature verify.

import express from "express";
import axios from "axios";
import getRawBody from "raw-body";
import nacl from "tweetnacl";
import pino from "pino";

const {
  TELNYX_API_KEY,
  TELNYX_PUBLIC_KEY,   // leave empty to skip signature verify in dev
  FROM_NUMBER,
  CONNECTION_ID,
  AI_ASSISTANT_ID,
  ALLOW_LIST
} = process.env;

if (!TELNYX_API_KEY || !FROM_NUMBER || !CONNECTION_ID) {
  console.error("Missing env: TELNYX_API_KEY, FROM_NUMBER, CONNECTION_ID");
  process.exit(1);
}

const log = pino({ level: process.env.LOG_LEVEL || "info" });

// ---- utils ----
const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
const b64eq = (incoming, plain) =>
  String(incoming || "") === b64(plain);

const toE164AU = (n) => {
  if (!n) return null;
  const d = String(n).replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.startsWith("61")) return "+" + d;
  if (d.startsWith("0")) return "+61" + d.slice(1);
  return "+61" + d;
};

const allowList = new Set(
  (ALLOW_LIST || "")
    .split(",")
    .map(s => toE164AU(s.trim()))
    .filter(Boolean)
);

// ---- http client ----
const telnyx = axios.create({
  baseURL: "https://api.telnyx.com/v2",
  headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
  timeout: 12000
});

// ---- express + raw body ----
const app = express();
app.use(async (req, _res, next) => {
  try {
    req.rawBody = await getRawBody(req);
    const ct = req.headers["content-type"] || "";
    if (ct.includes("application/json")) {
      try { req.body = JSON.parse(req.rawBody.toString("utf8")); } catch {}
    }
    next();
  } catch (e) { next(e); }
});

// ---- signature verify (optional) ----
function verifyTelnyxSignature(req) {
  if (!TELNYX_PUBLIC_KEY) return true;
  const sig = req.headers["telnyx-signature-ed25519"];
  const ts  = req.headers["telnyx-timestamp"];
  if (!sig || !ts) return false;
  const message = Buffer.concat([
    Buffer.from(String(ts), "utf8"),
    Buffer.from("|", "utf8"),
    Buffer.from(req.rawBody || "")
  ]);
  try {
    return nacl.sign.detached.verify(
      message,
      Buffer.from(sig, "base64"),
      Buffer.from(TELNYX_PUBLIC_KEY, "base64")
    );
  } catch { return false; }
}

// ---- TTS helpers (voice required) ----
const TTS = { voice: "female", language: "en-AU" };

const speak = (ccid, text) =>
  telnyx.post(`/calls/${ccid}/actions/speak`, { payload: text, ...TTS });

const gatherUsingSpeak = (ccid, prompt, clientStatePlain) =>
  telnyx.post(`/calls/${ccid}/actions/gather_using_speak`, {
    payload: prompt,
    terminating_digit: "#",
    minimum_digits: 4,
    maximum_digits: 15,
    client_state: b64(clientStatePlain),
    ...TTS
  });

const gather = (ccid, clientStatePlain) =>
  telnyx.post(`/calls/${ccid}/actions/gather`, {
    minimum_digits: 2,
    maximum_digits: 2,
    inter_digit_timeout_millis: 5000,
    client_state: b64(clientStatePlain)
  });

// ---- state ----
const calls = new Map(); // agent_ccid -> { stage, customer_ccid, conf_id }

app.get("/", (_req, res) => res.status(200).send("OK"));

app.post("/telnyx/voice", async (req, res) => {
  res.sendStatus(200);

  if (!verifyTelnyxSignature(req)) {
    log.warn("Invalid Telnyx signature — check TELNYX_PUBLIC_KEY");
    return;
  }

  const ev = req.body?.data;
  if (!ev) return;

  const type = ev.event_type;
  const p = ev.payload || {};
  const ccid = p.call_control_id;
  const dir = p.direction;

  try {
    // 1) Incoming call
    if (type === "call.initiated" && dir === "incoming") {
      const fromRaw = p.from?.number ?? p.from_number ?? p.caller_id_number ?? null;
      const fromNorm = toE164AU(fromRaw);
      log.info({ type, fromRaw, fromNorm }, "call.initiated");

      await telnyx.post(`/calls/${ccid}/actions/answer`);

      if (allowList.size && fromNorm && !allowList.has(fromNorm)) {
        log.info({ fromNorm }, "Rejected: CLID not in allow-list");
        await speak(ccid, "This number is not authorised. Goodbye.");
        await telnyx.post(`/calls/${ccid}/actions/hangup`);
        return;
      }
      if (!fromNorm) log.warn("No caller ID; skipping allow-list check.");

      await gatherUsingSpeak(
        ccid,
        "Enter the number to call, then press hash.",
        "collect_target"
      );
      calls.set(ccid, { stage: "collect", agent_ccid: ccid });
      return;
    }

    // 2) Got digits for target (client_state is base64 now)
    if (type === "call.gather.ended" && b64eq(p.client_state, "collect_target")) {
      const agent_ccid = ccid;
      const to = toE164AU(p.digits);
      log.info({ digits: p.digits, to }, "collect_target result");

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

    // 3) Outbound answered -> conference & join; assistant on agent
    if (type === "call.answered" && dir === "outgoing") {
      const customer_ccid = ccid;
      const agent_ccid = [...calls.keys()].find(k => (calls.get(k)?.stage === "dialling"));
      if (!agent_ccid) return;

      const conf = await telnyx.post("/conferences", {
        call_control_id: agent_ccid,
        name: `conf-${Date.now()}`
      });
      const conf_id = conf.data?.data?.id;

      await telnyx.post(`/conferences/${conf_id}/actions/join`, { call_control_id: customer_ccid });

      if (AI_ASSISTANT_ID) {
        await telnyx.post(`/calls/${agent_ccid}/actions/ai_assistant_start`, {
          assistant_id: AI_ASSISTANT_ID
        });
      }

      await gather(agent_ccid, "listen_whisper");
      calls.set(agent_ccid, { stage: "live", agent_ccid, customer_ccid, conf_id });
      log.info({ conf_id }, "conference up");
      return;
    }

    // 4) Whisper trigger (*2) — compare base64 client_state
    if (type === "call.gather.ended" && b64eq(p.client_state, "listen_whisper")) {
      if (p.digits === "*2") {
        await speak(ccid, "Recommend the ninety nine per user plan, then confirm how many users.");
      }
      await gather(ccid, "listen_whisper"); // keep listening
      return;
    }

    // Optional insights
    if (type === "call.conversation_insights.generated") {
      log.info({ insights: ev.payload }, "insights");
      return;
    }

    // Cleanup
    if (type === "call.hangup") {
      const entry = calls.get(ccid) || [...calls.values()].find(v => v.customer_ccid === ccid);
      if (entry) calls.delete(entry.agent_ccid);
      return;
    }

  } catch (err) {
    log.error({ err: err?.response?.data || err.message }, "Webhook handler error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log.info(`listening on :${PORT}`));



