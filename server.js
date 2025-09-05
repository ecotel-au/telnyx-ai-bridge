// server.js — Telnyx Call Control webhook (AU whisper coach)
// Robust outbound tracking: store pending_out_ccid and key 'call.answered' by ccid
// Enhanced logging for conference/media as before.

import express from "express";
import axios from "axios";
import getRawBody from "raw-body";
import nacl from "tweetnacl";
import pino from "pino";

const {
  TELNYX_API_KEY,
  TELNYX_PUBLIC_KEY,
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

const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
const b64eq = (incoming, plain) => String(incoming || "") === b64(plain);
const toE164AU = n => {
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

const telnyx = axios.create({
  baseURL: "https://api.telnyx.com/v2",
  headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
  timeout: 12000
});

async function post(path, body, label, meta = {}) {
  try {
    const r = await telnyx.post(path, body);
    log.info({
      label, path, status: r.status,
      requestId: r.headers["x-request-id"] || r.headers["x-telnyx-request-id"] || null,
      meta
    }, "telnyx.ok");
    return r;
  } catch (e) {
    const data = e?.response?.data;
    log.error({
      label, path,
      status: e?.response?.status || null,
      requestId: e?.response?.headers?.["x-request-id"] || e?.response?.headers?.["x-telnyx-request-id"] || null,
      err: data || e.message,
      meta
    }, "telnyx.err");
    throw e;
  }
}

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

const TTS = { voice: "female", language: "en-AU" };

async function speak(ccid, text) {
  log.info({ ccid, text }, "action.speak");
  await post(`/calls/${ccid}/actions/speak`, { payload: text, ...TTS }, "speak", { ccid });
}

async function gatherUsingSpeak(ccid, prompt, clientStatePlain) {
  log.info({ ccid, prompt, clientStatePlain }, "action.gather_using_speak");
  await post(`/calls/${ccid}/actions/gather_using_speak`, {
    payload: prompt,
    terminating_digit: "#",
    minimum_digits: 4,
    maximum_digits: 15,
    client_state: b64(clientStatePlain),
    ...TTS
  }, "gather_using_speak", { ccid });
}

async function gather(ccid, clientStatePlain) {
  log.info({ ccid, clientStatePlain }, "action.gather");
  await post(`/calls/${ccid}/actions/gather`, {
    minimum_digits: 2,
    maximum_digits: 2,
    inter_digit_timeout_millis: 5000,
    client_state: b64(clientStatePlain)
  }, "gather", { ccid });
}

async function dial(to) {
  log.info({ to }, "action.create_outbound_leg");
  const r = await post("/calls", { connection_id: CONNECTION_ID, to, from: FROM_NUMBER }, "create_call", { to });
  const outCcid = r?.data?.data?.call_control_id;
  log.info({ outCcid, to }, "outbound.leg.created");
  return outCcid;
}

async function createConference(agentCcid) {
  const r = await post("/conferences", { call_control_id: agentCcid, name: `conf-${Date.now()}` }, "conference.create", { agentCcid });
  const confId = r?.data?.data?.id;
  log.info({ confId }, "conference.created");
  return confId;
}

async function joinConference(confId, callControlId, role = "participant") {
  await post(`/conferences/${confId}/actions/join`, { call_control_id: callControlId, role }, "conference.join", { confId, callControlId, role });
}

async function startAssistantOnAgent(agentCcid) {
  if (!AI_ASSISTANT_ID) {
    log.info("AI assistant not configured; skipping");
    return;
  }
  await post(`/calls/${agentCcid}/actions/ai_assistant_start`, { assistant_id: AI_ASSISTANT_ID }, "assistant.start", { agentCcid, assistant: AI_ASSISTANT_ID });
}

// ---------- state ----------
// agent_ccid -> { stage, agent_ccid, pending_out_ccid, customer_ccid, conf_id }
const calls = new Map();

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
    // Inbound: agent calls the DID
    if (type === "call.initiated" && dir === "incoming") {
      const fromRaw  = p.from?.number ?? p.from_number ?? p.caller_id_number ?? null;
      const fromNorm = toE164AU(fromRaw);
      log.info({ type, fromRaw, fromNorm }, "call.initiated");

      await post(`/calls/${ccid}/actions/answer`, {}, "answer", { ccid });

      if (allowList.size && fromNorm && !allowList.has(fromNorm)) {
        log.info({ fromNorm }, "Rejected: CLID not in allow-list");
        await speak(ccid, "This number is not authorised. Goodbye.");
        await post(`/calls/${ccid}/actions/hangup`, {}, "hangup.unauthorised", { ccid });
        return;
      }
      if (!fromNorm) log.warn("No caller ID; skipping allow-list check.");

      calls.set(ccid, { stage: "collect", agent_ccid: ccid });
      await gatherUsingSpeak(ccid, "Enter the number to call, then press hash.", "collect_target");
      return;
    }

    // Agent entered a target number
    if (type === "call.gather.ended" && b64eq(p.client_state, "collect_target")) {
      const to = toE164AU(p.digits);
      log.info({ digits: p.digits, to }, "collect_target.result");

      if (!to) {
        await speak(ccid, "Invalid number. Goodbye.");
        await post(`/calls/${ccid}/actions/hangup`, {}, "hangup.invalid", { ccid });
        return;
      }

      const outCcid = await dial(to);

      // Track the specific outbound leg we expect to answer
      const s = calls.get(ccid) || {};
      s.stage = "dialling";
      s.agent_ccid = ccid;
      s.pending_out_ccid = outCcid;
      calls.set(ccid, s);

      log.info({ agent_ccid: ccid, pending_out_ccid: outCcid }, "state.updated.dialling");
      return;
    }

    // Outbound answered: key off the *exact* pending_out_ccid
    if (type === "call.answered") {
      // Find which agent record is waiting for this ccid
      const agentEntry = [...calls.entries()].find(
        ([, v]) => v.pending_out_ccid && v.pending_out_ccid === ccid
      );

      if (agentEntry) {
        const [agentCcid, s] = agentEntry;
        log.info({ agentCcid, outboundCcid: ccid, dir }, "outbound.answered.match");

        const confId = await createConference(agentCcid);
        await joinConference(confId, ccid, "participant"); // join customer
        await startAssistantOnAgent(agentCcid);
        await gather(agentCcid, "listen_whisper");

        s.stage = "live";
        s.customer_ccid = ccid;
        s.conf_id = confId;
        calls.set(agentCcid, s);

        log.info({ confId, agentCcid, customer_ccid: ccid }, "conference.live");
        return;
      }

      // Otherwise it was the inbound (agent) leg answered event – ignore.
      log.info({ ccid, dir }, "agent.leg.answered");
      return;
    }

    // DTMF whisper control on agent leg
    if (type === "call.gather.ended" && b64eq(p.client_state, "listen_whisper")) {
      log.info({ digits: p.digits }, "whisper.dtmf");
      if (p.digits === "*2") {
        await speak(ccid, "Whisper: recommend the ninety nine per user plan, then confirm how many users.");
      }
      await gather(ccid, "listen_whisper");
      return;
    }

    // Media / conference visibility logs
    if (type === "conference.participant.joined" || type === "conference.participant.left") {
      log.info({
        type,
        conference_id: p?.conference_id,
        call_control_id: p?.call_control_id,
        participant_id: p?.participant_id,
        role: p?.role
      }, "conference.participant.event");
      return;
    }

    if (type.startsWith("call.speak.")) {
      log.info({ type, ccid, payload: { state: p?.state } }, "speak.event");
      return;
    }

    if (type.startsWith("call.gather.")) {
      log.info({ type, ccid, payload: { digits: p?.digits, client_state: p?.client_state } }, "gather.event");
    }

    if (type === "call.conversation_insights.generated") {
      log.info({ insights: ev.payload }, "assistant.insights");
      return;
    }

    if (type === "call.hangup") {
      const entry = calls.get(ccid) || [...calls.values()].find(v => v.customer_ccid === ccid);
      if (entry) {
        calls.delete(entry.agent_ccid);
        log.info(entry, "cleanup.call_ended");
      }
      return;
    }

    log.debug({ type, dir }, "event.ignored");

  } catch (err) {
    log.error({ err: err?.response?.data || err.message }, "webhook.error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log.info(`listening on :${PORT}`));

