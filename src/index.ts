/**
 * treq-slack-relay
 * Verify Slack Events → ack <3s → waitUntil forward to Treq Grok webhook.
 * Does not reply in Slack; Treq posts as the bot later.
 */

export interface Env {
  SLACK_SIGNING_SECRET: string;
  GROK_WEBHOOK_URL: string;
  GROK_WEBHOOK_AUTHORIZATION: string;
  SLACK_BOT_USER_ID?: string;
}

type SlackEnvelope = {
  type?: string;
  challenge?: string;
  token?: string;
  team_id?: string;
  event_id?: string;
  event?: SlackEvent;
};

type SlackEvent = {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
};

const seenEventIds = new Map<string, number>();
const DEDUPE_TTL_MS = 10 * 60 * 1000;

function pruneSeen(now: number) {
  for (const [id, at] of seenEventIds) {
    if (now - at > DEDUPE_TTL_MS) seenEventIds.delete(id);
  }
}

async function verifySlackSignature(
  signingSecret: string,
  signature: string | null,
  timestamp: string | null,
  rawBody: string,
): Promise<boolean> {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = `v0=${hex}`;

  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

function stripBotMention(text: string, botUserId?: string): string {
  let out = text;
  if (botUserId) {
    out = out.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "");
  }
  out = out.replace(/<@[A-Z0-9]+>\s*/g, (m, _offset, whole) => {
    // keep other user mentions; only strip leading bot-style if whole was mostly mention
    return m;
  });
  // Prefer stripping first leading mention (typical app_mention pattern)
  out = out.replace(/^<@[A-Z0-9]+>\s*/, "");
  return out.trim();
}

function shouldForward(event: SlackEvent): boolean {
  if (!event?.type) return false;
  if (event.bot_id) return false;
  if (event.subtype && event.subtype !== "file_share") return false;

  if (event.type === "app_mention") return true;
  if (event.type === "message" && event.channel_type === "im") return true;
  return false;
}

async function forwardToGrok(env: Env, envelope: SlackEnvelope, event: SlackEvent) {
  const text = stripBotMention(event.text || "", env.SLACK_BOT_USER_ID);
  const payload = {
    source: "slack",
    type: event.type === "app_mention" ? "app_mention" : (event.channel_type === "mpim" || event.channel_type === "group" ? "message.mpim" : "message.im"),
    event_id: envelope.event_id || null,
    team_id: envelope.team_id || null,
    channel: event.channel || null,
    user: event.user || null,
    text,
    ts: event.ts || event.event_ts || null,
    thread_ts: event.thread_ts || null,
    raw_event: event,
  };

  const res = await fetch(env.GROK_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: env.GROK_WEBHOOK_AUTHORIZATION,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("grok_webhook_failed", res.status, body.slice(0, 500));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "GET") {
      return new Response("treq-slack-relay ok", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (!env.SLACK_SIGNING_SECRET || !env.GROK_WEBHOOK_URL || !env.GROK_WEBHOOK_AUTHORIZATION) {
      console.error("missing_required_secrets");
      return new Response("misconfigured", { status: 500 });
    }

    const rawBody = await request.text();
    const ok = await verifySlackSignature(
      env.SLACK_SIGNING_SECRET,
      request.headers.get("x-slack-signature"),
      request.headers.get("x-slack-request-timestamp"),
      rawBody,
    );
    if (!ok) return new Response("invalid signature", { status: 401 });

    let envelope: SlackEnvelope;
    try {
      envelope = JSON.parse(rawBody) as SlackEnvelope;
    } catch {
      return new Response("bad json", { status: 400 });
    }

    if (envelope.type === "url_verification" && envelope.challenge) {
      return new Response(envelope.challenge, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    if (envelope.type !== "event_callback" || !envelope.event) {
      return new Response("ok", { status: 200 });
    }

    const retry = request.headers.get("x-slack-retry-num");
    if (retry && Number(retry) > 0) {
      // Already working / worked; ack quietly
      return new Response("ok", { status: 200 });
    }

    const eventId = envelope.event_id;
    const now = Date.now();
    pruneSeen(now);
    if (eventId) {
      if (seenEventIds.has(eventId)) return new Response("ok", { status: 200 });
      seenEventIds.set(eventId, now);
    }

    const event = envelope.event;
    if (!shouldForward(event)) {
      return new Response("ok", { status: 200 });
    }

    ctx.waitUntil(
      forwardToGrok(env, envelope, event).catch((err) => {
        console.error("forward_error", String(err));
      }),
    );

    return new Response("ok", { status: 200 });
  },
};
