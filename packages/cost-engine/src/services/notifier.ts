// Outbound webhook / Slack notifier (ELEAA-664).
//
// A single low-level sender shared by the alerts route (budget/runaway alerts)
// and the human-in-the-loop hold notifier. Slack gets a Block Kit message;
// generic webhooks get a plain JSON envelope. Failures are the caller's to
// handle — this function throws on a non-2xx so Promise.allSettled callers can
// count successes, and fire-and-forget callers can swallow.
//
// Hardening (ELEAA-781): every send is (a) SSRF-guarded against private/metadata
// hosts and (b) bounded by an AbortController timeout so a hanging endpoint can
// never wedge the caller. Every failure — unsafe URL, timeout, network error,
// non-2xx — is recorded in a durable in-process failure log (below) in addition
// to being thrown, so fire-and-forget callers that swallow the throw still leave
// an operational trace instead of a lone console.error.

import { assertSafeWebhookUrl } from "./webhook-safety.js";

export type NotifyChannel = "webhook" | "slack";

// How long we wait for a webhook endpoint before aborting the request.
export const NOTIFY_TIMEOUT_MS = 10_000;

export type NotifyFailureReason =
  | "unsafe_url"
  | "timeout"
  | "network_error"
  | `http_${number}`;

export interface NotifyFailure {
  url: string;
  channel: NotifyChannel;
  event: string;
  reason: NotifyFailureReason;
  at: string;
}

// Durable-ish failure record. In-process ring buffer (survives for the process
// lifetime, queryable/assertable) plus a structured, greppable log line that
// alerting can key off. Persisting to a table is a follow-up; a metric/log sink
// is the bar this item was scoped to.
const MAX_FAILURES = 200;
const recentFailures: NotifyFailure[] = [];

export function recordNotificationFailure(f: Omit<NotifyFailure, "at">): void {
  const entry: NotifyFailure = { ...f, at: new Date().toISOString() };
  recentFailures.push(entry);
  if (recentFailures.length > MAX_FAILURES) recentFailures.shift();
  // Structured, greppable signal for alerting ([notifier:delivery_failed]).
  console.error("[notifier:delivery_failed]", {
    channel: entry.channel,
    event: entry.event,
    reason: entry.reason,
    // Host only — never log the full URL (may embed a token/secret).
    host: safeHost(entry.url),
  });
}

export function getRecentNotificationFailures(): readonly NotifyFailure[] {
  return recentFailures;
}

// Test/reset hook — clears the in-process failure log.
export function clearNotificationFailures(): void {
  recentFailures.length = 0;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid-url>";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export interface NotifyField {
  label: string;
  value: string;
}

export interface NotifyMessage {
  event: string;
  title: string;
  // Optional one-line summary shown above the fields in Slack.
  summary?: string | undefined;
  fields: NotifyField[];
  // Optional call-to-action link (e.g. the dashboard approval view).
  actionUrl?: string | undefined;
  actionLabel?: string | undefined;
}

export async function sendNotification(
  webhookUrl: string,
  channel: NotifyChannel,
  msg: NotifyMessage,
): Promise<void> {
  // SSRF guard first — never even open a socket to a private/metadata host.
  try {
    assertSafeWebhookUrl(webhookUrl);
  } catch (err) {
    recordNotificationFailure({ url: webhookUrl, channel, event: msg.event, reason: "unsafe_url" });
    throw err;
  }

  const body = channel === "slack" ? toSlackBody(msg) : toWebhookBody(msg);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = isAbortError(err);
      recordNotificationFailure({
        url: webhookUrl,
        channel,
        event: msg.event,
        reason: timedOut ? "timeout" : "network_error",
      });
      throw timedOut
        ? new Error(`Notification webhook timed out after ${NOTIFY_TIMEOUT_MS}ms`)
        : err;
    }
    if (!res.ok) {
      recordNotificationFailure({
        url: webhookUrl,
        channel,
        event: msg.event,
        reason: `http_${res.status}`,
      });
      throw new Error(`Notification webhook returned ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Block Kit payload for a NotifyMessage. Exported so the Slack App integration
// (chat.postMessage over a stored bot token) renders alerts identically to the
// incoming-webhook path — one source of truth for how a Steadio alert looks.
export function slackBlocksFromMessage(msg: NotifyMessage): {
  text: string;
  blocks: unknown[];
} {
  const lines = msg.fields.map((f) => `• *${f.label}:* ${f.value}`).join("\n");
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${msg.title}*${msg.summary ? `\n${msg.summary}` : ""}\n${lines}`,
      },
    },
  ];
  if (msg.actionUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: msg.actionLabel ?? "Open" },
          url: msg.actionUrl,
          style: "primary",
        },
      ],
    });
  }
  return { text: `${msg.title}`, blocks };
}

function toSlackBody(msg: NotifyMessage): unknown {
  return slackBlocksFromMessage(msg);
}

function toWebhookBody(msg: NotifyMessage): unknown {
  return {
    event: msg.event,
    title: msg.title,
    summary: msg.summary,
    fields: Object.fromEntries(msg.fields.map((f) => [f.label, f.value])),
    ...(msg.actionUrl ? { actionUrl: msg.actionUrl } : {}),
    timestamp: new Date().toISOString(),
  };
}
