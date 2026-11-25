/**
 * telegram.js — long polling against the Bot API. No webhook, no public IP,
 * works from behind your router. Approvals get real inline buttons.
 */
import { formatActionPreview } from "../action-preview.js";
import { config } from "../config.js";
import { createAllowList } from "./auth.js";
import { isApprovalReply, routeMessage } from "./router.js";
import { answerApproval, pendingApprovalsFor } from "../agent.js";
import { registerSender } from "../outbound.js";
import { formatIncomingTelegramText } from "./telegram-reply.js";

const API = (method) => `https://api.telegram.org/bot${config.telegram.token}/${method}`;

async function call(method, payload) {
  const res = await fetch(API(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(70_000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description || "failed"}`);
  return json.result;
}

function chunk(text, size = 4000) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/** One refusal per stranger per ten minutes; a loop must not make the bot spam. */
const REFUSAL_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * What an unauthorised sender is told.
 *
 * The echo is the setup path `docs/CHANNELS.md` promises: a bot username is
 * public, so the first person to find a new bot gets their own id back and can
 * hand it to the owner. It is a string builder, exported, so a test can hold it
 * to that promise without opening a socket.
 */
export function unauthorisedReply(userId, { configured = false } = {}) {
  const id = userId == null ? "unknown" : String(userId);
  if (configured) {
    return (
      `✦ This bot is private.\n\nYour Telegram user id is \`${id}\`, and it is not on the allowlist.\n` +
      `Ask the owner to add it to \`TELEGRAM_ALLOWED_IDS\` in .env, then restart Quasnooze.`
    );
  }
  return (
    `✦ This bot is not open to messages.\n\n` +
    `\`TELEGRAM_ALLOWED_IDS\` is empty, so it refuses everyone — including you, until the owner adds you.\n` +
    `Your Telegram user id is \`${id}\`. Ask the owner to add it to \`TELEGRAM_ALLOWED_IDS\` in .env and restart Quasnooze.`
  );
}

export function startTelegram(log = console) {
  if (!config.telegram.token) return null;

  // Fail closed: no allowlist means nobody, not everybody. See channels/auth.js.
  const allowed = createAllowList(config.telegram.allowedIds);
  const lastRefusal = new Map();
  let offset = 0;
  let running = true;

  async function send(chatId, text, extra = {}) {
    for (const part of chunk(text)) {
      await call("sendMessage", { chat_id: chatId, text: part, parse_mode: "Markdown", disable_web_page_preview: true, ...extra }).catch(
        (err) => {
          // Markdown can fail on unbalanced characters — retry as plain text.
          if (String(err.message).includes("can't parse")) {
            return call("sendMessage", { chat_id: chatId, text: part, ...extra });
          }
          log.warn?.(`telegram send: ${err.message}`);
        }
      );
    }
  }

  async function sendApproval(chatId, id, description, preview) {
    const details = description + (preview ? "\n" + formatActionPreview(preview) : "");
    await call("sendMessage", {
      chat_id: chatId,
      text: `✦ Quick check — ${details}\n\nAllow it?`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Allow", callback_data: `ap:${id}:1` },
            { text: "❌ Deny", callback_data: `ap:${id}:0` },
          ],
        ],
      },
    }).catch(async () => {
      await send(chatId, `✦ ${details} Reply yes or no.`);
    });
  }

  async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const incomingText = msg.text || msg.caption || "";

    // Authorise before replying to anything. The old order answered an
    // unauthorised sender's voice note first, which is a free reply amplifier
    // and tells a stranger the bot is alive and listening.
    if (!allowed.has(userId)) {
      const key = String(userId);
      const now = Date.now();
      if (now - (lastRefusal.get(key) || 0) >= REFUSAL_COOLDOWN_MS) {
        // Bounded: a stranger cannot grow this map without a rate limit on them.
        if (lastRefusal.size >= 500) lastRefusal.delete(lastRefusal.keys().next().value);
        lastRefusal.set(key, now);
        log.warn?.(`telegram: refused unauthorised user ${key}`);
        await send(chatId, unauthorisedReply(userId, { configured: allowed.configured }));
      }
      return;
    }

    if (!incomingText) {
      await send(chatId, "✦ I can only read text for now. Voice notes are on the roadmap — use the web panel mic for talking.");
      return;
    }

    const sessionId = `telegram-${chatId}`;
    const approvalReply = pendingApprovalsFor(sessionId).length > 0 &&
      isApprovalReply(incomingText);
    const text = formatIncomingTelegramText(msg, { preserveApprovalReply: approvalReply });

    await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    try {
      await routeMessage({
        channel: "telegram",
        text,
        sessionId,
        target: String(chatId),
        send: (t) => send(chatId, t),
        onProgress: async () => {
          await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
        },
        onApproval: ({ id, description, preview }) => sendApproval(chatId, id, description, preview),
      });
    } catch (err) {
      await send(chatId, `✦ Something jammed: ${err.message}`);
    }
  }

  async function poll() {
    while (running) {
      try {
        const updates = await call("getUpdates", {
          offset,
          timeout: 50,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) await handleMessage(update.message);
          if (update.callback_query) {
            // A tapped button is a message like any other, and it answers a
            // permission prompt — the one place where "yes" has consequences.

            // Without this check the allowlist had a second, unlocked door: an
            // approval id is delivered to a chat, but nothing tied the *tap* to
            // an authorised person.
            if (!allowed.has(update.callback_query.from?.id)) {
              log.warn?.(`telegram: refused approval tap from unauthorised user ${update.callback_query.from?.id}`);
              await call("answerCallbackQuery", {
                callback_query_id: update.callback_query.id,
                text: "That prompt is not yours.",
                show_alert: true,
              }).catch(() => {});
              continue;
            }
            const [tag, id, decision] = String(update.callback_query.data || "").split(":");
            if (tag === "ap") answerApproval(id, decision === "1");
            await call("answerCallbackQuery", {
              callback_query_id: update.callback_query.id,
              text: decision === "1" ? "Allowed 🔧" : "Denied",
            }).catch(() => {});
            const chatId = update.callback_query.message?.chat?.id;
            if (chatId) await send(chatId, decision === "1" ? "✦ Allowed. On it." : "✦ Denied — leaving that alone.");
          }
        }
      } catch (err) {
        log.warn?.(`telegram poll: ${err.message} — retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  (async () => {
    try {
      const me = await call("getMe");
      await call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
      registerSender("telegram", (target, text) => send(target, text));
      log.info?.(`telegram: connected as @${me.username}${allowed.configured ? ` (${allowed.size} allowed id(s))` : ""}`);
      if (!allowed.configured) {
        log.warn?.(
          "telegram: TELEGRAM_ALLOWED_IDS is empty — refusing every message and echoing the sender's id. " +
            "Message the bot once, copy the id it replies with into .env, and restart."
        );
      }
      poll();
    } catch (err) {
      log.warn?.(`telegram: could not connect — ${err.message}`);
    }
  })();

  return {
    name: "telegram",
    stop: () => {
      running = false;
    },
  };
}
