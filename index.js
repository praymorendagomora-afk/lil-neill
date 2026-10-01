/**
 * Lil Neill v1.0.0
 * WhatsApp bot (Baileys) with pairing-code auth, downloaders, AI, and group admin tools.
 */
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  jidNormalizedUser,
  proto,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import axios from "axios";
import express from "express";
import pino from "pino";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";

function loadEnvFile(path = ".env") {
  try {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // missing or unreadable .env is ignored; process env still works on Koyeb/Render
  }
}

loadEnvFile();

// --- bot identity & runtime config ---
const BOT_NAME = "Lil Neill";
const BOT_VERSION = "1.0.0";
const DEVELOPER = "Lil Neill";
const SLOGAN = "Smart. Fast. Always online.";
const PREFIX = ".";
const AUTH_DIR = "auth_info";
const STATUS_JID = "status@broadcast";
const MAX_STORE = 800;
const PORT = Number(process.env.PORT || 3000);

const BOT_NUMBER = digitsOnly(process.env.BOT_NUMBER || "");
const OWNER_NUMBER = digitsOnly(process.env.OWNER_NUMBER || BOT_NUMBER);
const COBALT_API_URL = (process.env.COBALT_API_URL || "https://api.cobalt.tools").replace(/\/$/, "");
const USER_LLM_API_KEY = process.env.USER_LLM_API_KEY || "";
const USER_LLM_BASE_URL = (process.env.USER_LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const USER_LLM_MODEL = process.env.USER_LLM_MODEL || "llama-3.1-8b-instant";

const logger = pino({ level: process.env.LOG_LEVEL || "silent" });
const startedAt = Date.now();
const messageStore = new Map();
const antilinkGroups = new Set();
const muteCache = new Map();

if (!existsSync(AUTH_DIR)) {
  mkdirSync(AUTH_DIR, { recursive: true });
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function nowStamp() {
  return new Date().toLocaleString("en-GB", { hour12: false });
}

function memoryUsageMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function hostInfo() {
  const total = Math.round(os.totalmem() / 1024 / 1024);
  const free = Math.round(os.freemem() / 1024 / 1024);
  return {
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cores: os.cpus()?.length || 1,
    ram: `${free}MB free / ${total}MB`,
    node: process.version,
    rss: `${memoryUsageMb()}MB`
  };
}

function card(title, rows, footer = "") {
  const lines = [
    `╭─── ${BOT_NAME} ───╮`,
    `│ ${title}`,
    `├──────────────────`,
    ...rows.map((row) => `│ ${row}`),
    `├──────────────────`,
    footer ? `│ ${footer}` : `│ ${SLOGAN}`,
    `│ ${DEVELOPER}  •  v${BOT_VERSION}`,
    `╰──────────────────╯`
  ];
  return lines.join("\n");
}

function infoCard(title, fields) {
  const rows = Object.entries(fields).map(([key, value]) => `• ${key} : ${value}`);
  return card(title, rows);
}

function box(lines) {
  return card(lines[0] || BOT_NAME, lines.slice(1));
}

function senderJid(msg) {
  const participant = msg.key.participant || msg.participant || msg.key.remoteJid;
  return jidNormalizedUser(participant);
}

function senderNumber(msg) {
  return digitsOnly(senderJid(msg).split("@")[0]);
}

function isOwner(msg) {
  const number = senderNumber(msg);
  return Boolean(OWNER_NUMBER) && number === OWNER_NUMBER;
}

function ownerJid() {
  return OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;
}

function isGroup(jid) {
  return String(jid || "").endsWith("@g.us");
}

function unwrapMessage(message) {
  if (!message) return message;
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message) return unwrapMessage(message.viewOnceMessageV2Extension.message);
  if (message.documentWithCaptionMessage?.message) return unwrapMessage(message.documentWithCaptionMessage.message);
  return message;
}

function isViewOnceMessage(message) {
  if (!message) return false;
  if (
    message.viewOnceMessage ||
    message.viewOnceMessageV2 ||
    message.viewOnceMessageV2Extension
  ) {
    return true;
  }
  const inner = unwrapMessage(message);
  return Boolean(
    inner?.imageMessage?.viewOnce ||
    inner?.videoMessage?.viewOnce ||
    inner?.audioMessage?.viewOnce
  );
}

function getText(msg) {
  const content = unwrapMessage(msg.message || {});
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  ).trim();
}

function parseCommand(text) {
  if (!text.startsWith(PREFIX)) return null;
  const [raw, ...rest] = text.slice(PREFIX.length).trim().split(/\s+/);
  return {
    command: (raw || "").toLowerCase(),
    args: rest,
    query: rest.join(" ").trim()
  };
}

function storeMessage(msg) {
  const id = msg.key?.id;
  if (!id) return;
  messageStore.set(id, {
    key: msg.key,
    message: unwrapMessage(msg.message),
    pushName: msg.pushName || "Unknown",
    timestamp: Date.now()
  });
  if (messageStore.size > MAX_STORE) {
    const first = messageStore.keys().next().value;
    messageStore.delete(first);
  }
}

async function getGroupMeta(sock, jid) {
  return sock.groupMetadata(jid);
}

async function getParticipant(sock, jid, userJid) {
  const meta = await getGroupMeta(sock, jid);
  return (meta.participants || []).find((item) => item.id === userJid);
}

async function isGroupAdmin(sock, jid, userJid) {
  const participant = await getParticipant(sock, jid, userJid);
  return Boolean(participant?.admin);
}

async function botIsAdmin(sock, jid) {
  const botJid = jidNormalizedUser(sock.user?.id);
  return isGroupAdmin(sock, jid, botJid);
}

function mentionedJid(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

function quotedParticipant(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.participant || null;
}

function targetJids(msg, args) {
  const mentioned = mentionedJid(msg);
  const quoted = quotedParticipant(msg);
  const fromArgs = args
    .map((arg) => digitsOnly(arg))
    .filter(Boolean)
    .map((num) => `${num}@s.whatsapp.net`);
  const list = [...mentioned];
  if (quoted) list.push(quoted);
  list.push(...fromArgs);
  return [...new Set(list.map((jid) => jidNormalizedUser(jid)))];
}

function brandContext(title = BOT_NAME, body = SLOGAN) {
  return {
    forwardingScore: 999,
    isForwarded: true,
    externalAdReply: {
      title,
      body,
      mediaType: 1,
      renderLargerThumbnail: false,
      sourceUrl: OWNER_NUMBER ? `https://wa.me/${OWNER_NUMBER}` : "https://whatsapp.com"
    }
  };
}

async function reply(sock, jid, msg, content) {
  const payload = typeof content === "string" ? { text: content } : content;
  if (payload.text && !payload.contextInfo) {
    payload.contextInfo = brandContext();
  }
  return sock.sendMessage(jid, payload, { quoted: msg });
}

async function sendOwner(sock, content) {
  const dest = ownerJid() || sock.user?.id;
  if (!dest) return;
  const payload = typeof content === "string" ? { text: content } : content;
  if (payload.text && !payload.contextInfo) {
    payload.contextInfo = brandContext();
  }
  return sock.sendMessage(dest, payload);
}

async function requireGroupAdmin(sock, jid, msg) {
  if (!isGroup(jid)) {
    await reply(sock, jid, msg, card("Admin", ["This command only works in groups."]));
    return false;
  }
  const userAdmin = await isGroupAdmin(sock, jid, senderJid(msg));
  if (!userAdmin && !isOwner(msg)) {
    await reply(sock, jid, msg, card("Admin", ["Admins only."]));
    return false;
  }
  if (!(await botIsAdmin(sock, jid))) {
    await reply(sock, jid, msg, card("Admin", ["I need admin rights to run this command."]));
    return false;
  }
  return true;
}

function buildMenu(pingMs, extra = {}) {
  const host = hostInfo();
  return [
    `╭─── ${BOT_NAME} ───╮`,
    `│ ${SLOGAN}`,
    `├─ STATUS`,
    `│ • Version  : ${BOT_VERSION}`,
    `│ • Owner    : ${DEVELOPER}`,
    `│ • Prefix   : ${PREFIX}`,
    `│ • Uptime   : ${formatUptime(Date.now() - startedAt)}`,
    `│ • Ping     : ${pingMs} ms`,
    `│ • RAM      : ${host.rss}  |  ${host.ram}`,
    `│ • Host     : ${host.arch} • ${host.cores} cores`,
    `│ • Node     : ${host.node}`,
    extra.user ? `│ • You      : ${extra.user}` : null,
    extra.chat ? `│ • Chat     : ${extra.chat}` : null,
    `├─ GENERAL`,
    `│ ${PREFIX}menu  ${PREFIX}alive  ${PREFIX}ping  ${PREFIX}about`,
    `│ ${PREFIX}owner  ${PREFIX}runtime  ${PREFIX}stats  ${PREFIX}id`,
    `├─ INFO`,
    `│ ${PREFIX}whois  ${PREFIX}groupinfo  ${PREFIX}weather  ${PREFIX}time`,
    `│ ${PREFIX}wiki  ${PREFIX}define  ${PREFIX}translate  ${PREFIX}calc`,
    `├─ DOWNLOADER`,
    `│ ${PREFIX}play  ${PREFIX}song  ${PREFIX}video  ${PREFIX}tiktok  ${PREFIX}ig`,
    `├─ AI TOOLS`,
    `│ ${PREFIX}gemini  ${PREFIX}gpt`,
    `├─ ADMIN`,
    `│ ${PREFIX}kick  ${PREFIX}ban  ${PREFIX}promote  ${PREFIX}demote`,
    `│ ${PREFIX}mute  ${PREFIX}unmute  ${PREFIX}tagall  ${PREFIX}hidetag`,
    `│ ${PREFIX}antilink  ${PREFIX}link  ${PREFIX}revoke`,
    `├─ OWNER`,
    `│ ${PREFIX}restart`,
    `├─ FUN`,
    `│ ${PREFIX}quote  ${PREFIX}joke  ${PREFIX}fact  ${PREFIX}dice  ${PREFIX}flip`,
    `╰── Lil Neill  •  v${BOT_VERSION} ──╯`
  ].filter((line) => line !== null).join("\n");
}

async function resolveMediaUrl(query) {
  if (/^https?:\/\//i.test(query)) return query;
  const { data } = await axios.get("https://www.youtube.com/results", {
    params: { search_query: query },
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/122.0.0.0 Mobile Safari/537.36" },
    timeout: 20000
  });
  const match = String(data).match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (!match) throw new Error("No YouTube result found");
  return `https://www.youtube.com/watch?v=${match[1]}`;
}

async function handlePlay(sock, jid, msg, query, kind) {
  if (!query) {
    await reply(sock, jid, msg, card("Downloader", [`Usage : ${PREFIX}${kind === "audio" ? "play" : "video"} <title or url>`]));
    return;
  }

  await reply(sock, jid, msg, card("Downloader", [`Fetching ${kind === "audio" ? "audio" : "video"}...`, `Query : ${query}`]));
  const searchUrl = await resolveMediaUrl(query);

  const { data } = await axios.post(
    `${COBALT_API_URL}/`,
    {
      url: searchUrl,
      downloadMode: kind === "audio" ? "audio" : "auto",
      audioFormat: "mp3",
      videoQuality: "720"
    },
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      timeout: 45000
    }
  );

  const mediaUrl = data.url || data.tunnel || data.picker?.[0]?.url;
  if (!mediaUrl) {
    throw new Error(data.text || data.error?.code || "No downloadable media found");
  }

  const media = await axios.get(mediaUrl, { responseType: "arraybuffer", timeout: 60000 });
  const buffer = Buffer.from(media.data);
  const filename = `${kind === "audio" ? "audio" : "video"}-${Date.now()}.${kind === "audio" ? "mp3" : "mp4"}`;

  if (kind === "audio") {
    await sock.sendMessage(
      jid,
      {
        audio: buffer,
        mimetype: "audio/mpeg",
        ptt: false,
        fileName: filename
      },
      { quoted: msg }
    );
    return;
  }

  await sock.sendMessage(
    jid,
    {
      video: buffer,
      mimetype: "video/mp4",
      caption: card("Video Ready", [`Query : ${query}`, `Source : YouTube / Cobalt`]),
      fileName: filename
    },
    { quoted: msg }
  );
}

async function handleTiktok(sock, jid, msg, query) {
  if (!query) {
    await reply(sock, jid, msg, card("TikTok", [`Usage : ${PREFIX}tiktok <url>`]));
    return;
  }

  await reply(sock, jid, msg, card("TikTok", ["Fetching media...", `URL : ${query}`]));
  const { data } = await axios.post(
    `${COBALT_API_URL}/`,
    { url: query, downloadMode: "auto" },
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      timeout: 45000
    }
  );

  const mediaUrl = data.url || data.tunnel || data.picker?.[0]?.url;
  if (!mediaUrl) {
    throw new Error(data.text || data.error?.code || "TikTok download failed");
  }

  const media = await axios.get(mediaUrl, { responseType: "arraybuffer", timeout: 60000 });
  await sock.sendMessage(
    jid,
    {
      video: Buffer.from(media.data),
      mimetype: "video/mp4",
      caption: card("TikTok Ready", [`Source : Cobalt`, `URL : ${query}`])
    },
    { quoted: msg }
  );
}

async function handleAi(sock, jid, msg, query, label) {
  if (!query) {
    await reply(sock, jid, msg, card("AI Tools", [`Usage : ${PREFIX}${label} <question>`]));
    return;
  }
  if (!USER_LLM_API_KEY) {
    await reply(sock, jid, msg, card("AI Tools", ["AI is not configured.", "Set USER_LLM_API_KEY in your environment."]));
    return;
  }

  await reply(sock, jid, msg, card("AI Tools", [`${label.toUpperCase()} is thinking...`, `Model : ${USER_LLM_MODEL}`]));
  const { data } = await axios.post(
    `${USER_LLM_BASE_URL}/chat/completions`,
    {
      model: USER_LLM_MODEL,
      messages: [
        { role: "system", content: `You are ${BOT_NAME}, a concise WhatsApp assistant by ${DEVELOPER}.` },
        { role: "user", content: query }
      ],
      temperature: 0.7,
      max_tokens: 700
    },
    {
      headers: {
        Authorization: `Bearer ${USER_LLM_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 45000
    }
  );

  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("Empty AI response");
  await reply(sock, jid, msg, card(`${label.toUpperCase()} Reply`, answer.split("\n").slice(0, 24)));
}

// Anti-delete: protocolMessage REVOKE -> restore cached text/media to owner DM
async function handleDeletedMessage(sock, protoMsg) {
  const protocol = protoMsg.message?.protocolMessage;
  if (!protocol || protocol.type !== proto.Message.ProtocolMessage.Type.REVOKE) return;

  const deletedKey = protocol.key;
  const stored = deletedKey?.id ? messageStore.get(deletedKey.id) : null;
  if (!ownerJid() && !sock.user?.id) return;

  const from = protoMsg.key.remoteJid;
  const who = protoMsg.key.participant || protoMsg.participant || from;
  const header = infoCard("Anti-Delete Alert", {
    Chat: from,
    User: who,
    Name: stored ? stored.pushName : "not in cache",
    Time: nowStamp()
  });

  await sendOwner(sock, header);
  if (!stored?.message) return;

  const type = getContentType(stored.message);
  if (type === "conversation" || type === "extendedTextMessage") {
    const text = stored.message.conversation || stored.message.extendedTextMessage?.text || "";
    await sendOwner(sock, card("Deleted Text", text.split("\n").slice(0, 20)));
    return;
  }

  try {
    const buffer = await downloadMediaMessage(
      { message: stored.message, key: stored.key },
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    if (type === "imageMessage") {
      await sendOwner(sock, { image: buffer, caption: stored.message.imageMessage?.caption || card("Deleted Image", [`From : ${who}`]) });
    } else if (type === "videoMessage") {
      await sendOwner(sock, { video: buffer, caption: stored.message.videoMessage?.caption || card("Deleted Video", [`From : ${who}`]) });
    } else if (type === "audioMessage") {
      await sendOwner(sock, { audio: buffer, mimetype: stored.message.audioMessage?.mimetype || "audio/mpeg" });
    } else if (type === "documentMessage") {
      await sendOwner(sock, {
        document: buffer,
        mimetype: stored.message.documentMessage?.mimetype || "application/octet-stream",
        fileName: stored.message.documentMessage?.fileName || "deleted-file"
      });
    } else {
      await sendOwner(sock, card("Anti-Delete", [`Deleted ${type || "media"} could not be restored.`]));
    }
  } catch (error) {
    await sendOwner(sock, card("Anti-Delete", [`Restore failed : ${error.message}`]));
  }
}

// Anti-view-once: copy disappearing media to owner DM only, never the original chat
async function handleViewOnce(sock, msg) {
  if (!ownerJid() && !sock.user?.id) return;
  if (msg.key.fromMe) return;

  const inner = unwrapMessage(msg.message);
  const type = getContentType(inner);
  const from = msg.key.remoteJid;
  const who = senderJid(msg);
  const caption =
    inner?.imageMessage?.caption ||
    inner?.videoMessage?.caption ||
    inner?.documentMessage?.caption ||
    "";

  const header = infoCard("Anti-View-Once", {
    Chat: from,
    User: who,
    Name: msg.pushName || "Unknown",
    Type: type || "unknown",
    Time: nowStamp()
  });

  await sendOwner(sock, header);

  try {
    const buffer = await downloadMediaMessage(
      { message: inner, key: msg.key },
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );

    if (type === "imageMessage") {
      await sendOwner(sock, { image: buffer, caption: caption || card("View-Once Image", [`From : ${who}`]) });
      return;
    }
    if (type === "videoMessage") {
      await sendOwner(sock, { video: buffer, caption: caption || card("View-Once Video", [`From : ${who}`]) });
      return;
    }
    if (type === "audioMessage") {
      await sendOwner(sock, {
        audio: buffer,
        mimetype: inner.audioMessage?.mimetype || "audio/ogg; codecs=opus",
        ptt: Boolean(inner.audioMessage?.ptt)
      });
      return;
    }
    if (type === "documentMessage") {
      await sendOwner(sock, {
        document: buffer,
        mimetype: inner.documentMessage?.mimetype || "application/octet-stream",
        fileName: inner.documentMessage?.fileName || "view-once-file",
        caption: caption || card("View-Once File", [`From : ${who}`])
      });
      return;
    }
    await sendOwner(sock, card("Anti-View-Once", [`View-once ${type || "media"} could not be restored.`]));
  } catch (error) {
    await sendOwner(sock, card("Anti-View-Once", [`Restore failed : ${error.message}`]));
  }
}

// Auto-view WhatsApp statuses and react with a random emoji
async function handleStatus(sock, msg) {
  try {
    await sock.readMessages([msg.key]);
    const reactions = ["❤️", "🔥", "✨", "👍"];
    const emoji = reactions[Math.floor(Math.random() * reactions.length)];
    await sock.sendMessage(STATUS_JID, {
      react: { text: emoji, key: msg.key }
    });
  } catch (error) {
    logger.warn({ err: error }, "status auto-view failed");
  }
}

async function handleAntilink(sock, jid, msg, text) {
  if (!antilinkGroups.has(jid)) return;
  if (!/(https?:\/\/|wa\.me\/|chat\.whatsapp\.com\/)/i.test(text)) return;
  if (isOwner(msg) || (await isGroupAdmin(sock, jid, senderJid(msg)))) return;
  if (!(await botIsAdmin(sock, jid))) return;

  try {
    await sock.sendMessage(jid, { delete: msg.key });
    await sock.groupParticipantsUpdate(jid, [senderJid(msg)], "remove");
    await sock.sendMessage(jid, { text: card("Antilink", ["Link detected.", "User removed from the group."]) });
  } catch (error) {
    logger.warn({ err: error }, "antilink action failed");
  }
}

const quotes = [
  "Stay consistent. Results compound.",
  "Small steps still move you forward.",
  "Build quietly. Let the work speak.",
  "Discipline beats motivation.",
  "Protect your focus like it is money."
];

const jokes = [
  "Why did the developer go broke? Because he used up all his cache.",
  "I told my computer I needed a break. It froze.",
  "There are 10 types of people: those who understand binary and those who do not."
];

const facts = [
  "WhatsApp handles more than 100 billion messages a day.",
  "Node.js was first released in 2009.",
  "Zimbabwe uses the country code +263."
];

function safeCalc(expr) {
  const cleaned = String(expr).replace(/\s+/g, "");
  if (!/^[0-9+\-*/().%^]+$/.test(cleaned)) throw new Error("Only numbers and + - * / % ^ ( ) are allowed");
  const jsExpr = cleaned.replace(/\^/g, "**");
  const result = Function(`"use strict"; return (${jsExpr})`)();
  if (!Number.isFinite(result)) throw new Error("Invalid calculation");
  return result;
}

async function fetchWeather(query) {
  const place = query || "Harare";
  const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(place)}`, {
    params: { format: "j1" },
    timeout: 15000,
    headers: { "User-Agent": "LilNeillBot/1.0" }
  });
  const current = data.current_condition?.[0] || {};
  const area = data.nearest_area?.[0] || {};
  return infoCard("Weather", {
    Place: `${area.areaName?.[0]?.value || place}, ${area.country?.[0]?.value || ""}`.trim(),
    Temp: `${current.temp_C || "?"}°C  (feels ${current.FeelsLikeC || "?"}°C)`,
    Sky: current.weatherDesc?.[0]?.value || "n/a",
    Humidity: `${current.humidity || "?"}%`,
    Wind: `${current.windspeedKmph || "?"} km/h`,
    Updated: nowStamp()
  });
}

async function fetchWiki(query) {
  const { data } = await axios.get("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(query), {
    timeout: 15000,
    headers: { "User-Agent": "LilNeillBot/1.0" }
  });
  const extract = String(data.extract || "No summary found.").split("\n")[0];
  return card("Wikipedia", [
    `Title : ${data.title || query}`,
    extract.length > 500 ? `${extract.slice(0, 500)}...` : extract,
    data.content_urls?.desktop?.page ? `Link : ${data.content_urls.desktop.page}` : ""
  ].filter(Boolean));
}

async function fetchDefine(query) {
  const { data } = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(query)}`, {
    timeout: 15000
  });
  const entry = Array.isArray(data) ? data[0] : data;
  const meaning = entry?.meanings?.[0];
  const def = meaning?.definitions?.[0]?.definition || "No definition found.";
  return infoCard("Define", {
    Word: entry?.word || query,
    Phonetic: entry?.phonetic || entry?.phonetics?.[0]?.text || "n/a",
    Part: meaning?.partOfSpeech || "n/a",
    Meaning: def
  });
}

async function fetchTranslate(query) {
  const match = query.match(/^(\w{2})\s+(.+)$/);
  const lang = match ? match[1] : "en";
  const text = match ? match[2] : query;
  const { data } = await axios.get("https://api.mymemory.translated.net/get", {
    params: { q: text, langpair: `autodetect|${lang}` },
    timeout: 15000
  });
  const translated = data.responseData?.translatedText || "Translation failed.";
  return infoCard("Translate", {
    To: lang,
    Source: text,
    Result: translated
  });
}

async function fetchWorldTime(query) {
  const zone = query || "Africa/Harare";
  try {
    const { data } = await axios.get(`https://worldtimeapi.org/api/timezone/${encodeURIComponent(zone)}`, { timeout: 12000 });
    return infoCard("World Time", {
      Zone: data.timezone,
      Time: String(data.datetime || "").replace("T", " ").slice(0, 19),
      Offset: data.utc_offset || "n/a",
      Day: data.day_of_week
    });
  } catch {
    return infoCard("Local Time", {
      Host: nowStamp(),
      Hint: `Try ${PREFIX}time Africa/Harare`
    });
  }
}

async function handleCommand(sock, jid, msg, parsed) {
  const { command, args, query } = parsed;
  const pingStart = Date.now();

  switch (command) {
    case "menu":
    case "help":
    case "alive": {
      const ping = Date.now() - pingStart;
      await reply(sock, jid, msg, buildMenu(ping, {
        user: msg.pushName || senderNumber(msg),
        chat: isGroup(jid) ? "Group" : "Private"
      }));
      break;
    }
    case "ping": {
      await reply(sock, jid, msg, infoCard("Ping", {
        Latency: `${Date.now() - pingStart} ms`,
        Uptime: formatUptime(Date.now() - startedAt),
        Status: "online"
      }));
      break;
    }
    case "runtime": {
      const host = hostInfo();
      await reply(sock, jid, msg, infoCard("Runtime", {
        Uptime: formatUptime(Date.now() - startedAt),
        RAM: host.rss,
        Node: host.node,
        Time: nowStamp()
      }));
      break;
    }
    case "stats": {
      const host = hostInfo();
      await reply(sock, jid, msg, infoCard("System Stats", {
        Bot: BOT_NAME,
        Version: BOT_VERSION,
        Uptime: formatUptime(Date.now() - startedAt),
        RAM: `${host.rss} process  |  ${host.ram}`,
        CPU: `${host.cores} cores • ${host.arch}`,
        Platform: host.platform,
        Node: host.node,
        Cache: `${messageStore.size} messages`
      }));
      break;
    }
    case "about": {
      await reply(sock, jid, msg, infoCard("About", {
        Name: BOT_NAME,
        Developer: DEVELOPER,
        Version: BOT_VERSION,
        Line: SLOGAN,
        Owner: OWNER_NUMBER || "not set",
        Features: "Pairing, downloaders, AI, admin, anti-delete, view-once"
      }));
      break;
    }
    case "owner": {
      await reply(sock, jid, msg, infoCard("Owner", {
        Name: DEVELOPER,
        Number: OWNER_NUMBER || "not set",
        Chat: OWNER_NUMBER ? `wa.me/${OWNER_NUMBER}` : "n/a"
      }));
      break;
    }
    case "id": {
      await reply(sock, jid, msg, infoCard("IDs", {
        You: senderJid(msg),
        Name: msg.pushName || "Unknown",
        Chat: jid,
        Type: isGroup(jid) ? "Group" : "Private"
      }));
      break;
    }
    case "whois": {
      const target = targetJids(msg, args)[0] || senderJid(msg);
      const number = digitsOnly(target.split("@")[0]);
      await reply(sock, jid, msg, infoCard("Whois", {
        JID: target,
        Number: number || "n/a",
        Name: msg.pushName || "Unknown",
        Owner: number === OWNER_NUMBER ? "yes" : "no"
      }));
      break;
    }
    case "groupinfo": {
      if (!isGroup(jid)) {
        await reply(sock, jid, msg, card("Group Info", ["This command only works in groups."]));
        break;
      }
      const meta = await getGroupMeta(sock, jid);
      const members = meta.participants || [];
      const admins = members.filter((item) => item.admin).length;
      await reply(sock, jid, msg, infoCard("Group Info", {
        Name: meta.subject || "n/a",
        Members: members.length,
        Admins: admins,
        Created: meta.creation ? new Date(meta.creation * 1000).toLocaleString("en-GB") : "n/a",
        Restrict: meta.restrict ? "on" : "off",
        Announce: meta.announce ? "admins only" : "open",
        Antilink: antilinkGroups.has(jid) ? "on" : "off"
      }));
      break;
    }
    case "weather": {
      await reply(sock, jid, msg, await fetchWeather(query));
      break;
    }
    case "wiki": {
      if (!query) {
        await reply(sock, jid, msg, card("Wikipedia", [`Usage : ${PREFIX}wiki <topic>`]));
        break;
      }
      await reply(sock, jid, msg, await fetchWiki(query));
      break;
    }
    case "define": {
      if (!query) {
        await reply(sock, jid, msg, card("Define", [`Usage : ${PREFIX}define <word>`]));
        break;
      }
      await reply(sock, jid, msg, await fetchDefine(query));
      break;
    }
    case "translate": {
      if (!query) {
        await reply(sock, jid, msg, card("Translate", [`Usage : ${PREFIX}translate <lang> <text>`, `Example : ${PREFIX}translate en ndiri right`]));
        break;
      }
      await reply(sock, jid, msg, await fetchTranslate(query));
      break;
    }
    case "time": {
      await reply(sock, jid, msg, await fetchWorldTime(query));
      break;
    }
    case "calc": {
      if (!query) {
        await reply(sock, jid, msg, card("Calculator", [`Usage : ${PREFIX}calc 12*8+5`]));
        break;
      }
      const result = safeCalc(query);
      await reply(sock, jid, msg, infoCard("Calculator", { Expression: query, Result: result }));
      break;
    }
    case "play":
    case "song": {
      await handlePlay(sock, jid, msg, query, "audio");
      break;
    }
    case "video": {
      await handlePlay(sock, jid, msg, query, "video");
      break;
    }
    case "tiktok": {
      await handleTiktok(sock, jid, msg, query);
      break;
    }
    case "gemini":
    case "gpt": {
      await handleAi(sock, jid, msg, query, command);
      break;
    }
    case "kick":
    case "ban": {
      if (!(await requireGroupAdmin(sock, jid, msg))) return;
      const targets = targetJids(msg, args).filter((target) => target !== jidNormalizedUser(sock.user?.id));
      if (!targets.length) {
        await reply(sock, jid, msg, card("Admin", [`Tag, reply, or pass a number.`, `Usage : ${PREFIX}${command} @user`]));
        return;
      }
      await sock.groupParticipantsUpdate(jid, targets, "remove");
      await reply(sock, jid, msg, card("Admin", [`Removed ${targets.length} member(s).`]));
      break;
    }
    case "promote":
    case "demote": {
      if (!(await requireGroupAdmin(sock, jid, msg))) return;
      const targets = targetJids(msg, args);
      if (!targets.length) {
        await reply(sock, jid, msg, card("Admin", [`Tag or reply to a user.`, `Usage : ${PREFIX}${command} @user`]));
        return;
      }
      await sock.groupParticipantsUpdate(jid, targets, command === "promote" ? "promote" : "demote");
      await reply(sock, jid, msg, card("Admin", [`${command === "promote" ? "Promoted" : "Demoted"} ${targets.length} member(s).`]));
      break;
    }
    case "mute": {
      if (!(await requireGroupAdmin(sock, jid, msg))) return;
      await sock.groupSettingUpdate(jid, "announcement");
      muteCache.set(jid, true);
      await reply(sock, jid, msg, card("Admin", ["Group muted.", "Only admins can send messages."]));
      break;
    }
    case "unmute": {
      if (!(await requireGroupAdmin(sock, jid, msg))) return;
      await sock.groupSettingUpdate(jid, "not_announcement");
      muteCache.set(jid, false);
      await reply(sock, jid, msg, card("Admin", ["Group unmuted.", "Everyone can send messages."]));
      break;
    }
    case "tagall": {
      if (!(await requireGroupAdmin(sock, jid, msg))) return;
      const meta = await getGroupMeta(sock, jid);
      const members = (meta.participants || []).map((item) => item.id);
      const text = [
        `╭─── ${BOT_NAME} ───╮`,
        `│ Tag All  •  ${members.length} members`,
        `├──────────────────`,
        `│ ${query || "Attention everyone"}`,
        `├──────────────────`,
        ...members.map((id, i) => `│ ${i + 1}. @${id.split("@")[0]}`),
        `╰── Lil Neill  •  v${BOT_VERSION} ──╯`
      ].join("\n");
      await sock.sendMessage(jid, { text, mentions: members }, { quoted: msg });
      break;
    }
    case "hidetag": {
      if (!(await requireGroupAdmin(sock, jid, msg))) return;
      const meta = await getGroupMeta(sock, jid);
      const members = (meta.participants || []).map((item) => item.id);
      await sock.sendMessage(jid, {
        text: card("Announcement", [query || `${BOT_NAME} announcement`]),
        mentions: members
      }, { quoted: msg });
      break;
    }
    case "antilink": {
      if (!(await requireGroupAdmin(sock, jid, msg))) return;
      const mode = (args[0] || "").toLowerCase();
      if (mode === "on") {
        antilinkGroups.add(jid);
        await reply(sock, jid, msg, card("Antilink", ["Status : ON", "Links from members will be removed."]));
      } else if (mode === "off") {
        antilinkGroups.delete(jid);
        await reply(sock, jid, msg, card("Antilink", ["Status : OFF"]));
      } else {
        const state = antilinkGroups.has(jid) ? "ON" : "OFF";
        await reply(sock, jid, msg, card("Antilink", [`Status : ${state}`, `Usage : ${PREFIX}antilink on/off`]));
      }
      break;
    }
    case "link": {
      if (!(await requireGroupAdmin(sock, jid, msg))) return;
      const code = await sock.groupInviteCode(jid);
      await reply(sock, jid, msg, infoCard("Group Link", {
        Invite: `https://chat.whatsapp.com/${code}`
      }));
      break;
    }
    case "revoke": {
      if (!(await requireGroupAdmin(sock, jid, msg))) return;
      await sock.groupRevokeInvite(jid);
      const code = await sock.groupInviteCode(jid);
      await reply(sock, jid, msg, infoCard("Invite Revoked", {
        New: `https://chat.whatsapp.com/${code}`
      }));
      break;
    }
    case "ig": {
      await handleTiktok(sock, jid, msg, query);
      break;
    }
    case "quote": {
      await reply(sock, jid, msg, card("Quote", [quotes[Math.floor(Math.random() * quotes.length)]]));
      break;
    }
    case "joke": {
      await reply(sock, jid, msg, card("Joke", [jokes[Math.floor(Math.random() * jokes.length)]]));
      break;
    }
    case "fact": {
      await reply(sock, jid, msg, card("Fact", [facts[Math.floor(Math.random() * facts.length)]]));
      break;
    }
    case "dice": {
      await reply(sock, jid, msg, infoCard("Dice", { Result: 1 + Math.floor(Math.random() * 6) }));
      break;
    }
    case "flip": {
      await reply(sock, jid, msg, infoCard("Coin Flip", { Result: Math.random() < 0.5 ? "Heads" : "Tails" }));
      break;
    }
    case "restart": {
      if (!isOwner(msg)) {
        await reply(sock, jid, msg, card("Owner", ["This command is owner only."]));
        return;
      }
      await reply(sock, jid, msg, card("Owner", ["Restarting Lil Neill..."]));
      process.exit(0);
      break;
    }
    default:
      break;
  }
}

async function onMessages(sock, { type, messages }) {
  if (type !== "notify") return;

  for (const msg of messages) {
    try {
      if (!msg.message) continue;
      if (msg.key.remoteJid === STATUS_JID) {
        await handleStatus(sock, msg);
        continue;
      }

      const content = unwrapMessage(msg.message);
      if (content?.protocolMessage) {
        await handleDeletedMessage(sock, { ...msg, message: content });
        continue;
      }

      storeMessage(msg);

      if (isViewOnceMessage(msg.message) && !msg.key.fromMe) {
        await handleViewOnce(sock, msg);
      }

      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      const text = getText(msg);
      if (text) await handleAntilink(sock, jid, msg, text);

      const parsed = parseCommand(text);
      if (!parsed) continue;
      await handleCommand(sock, jid, msg, parsed);
    } catch (error) {
      logger.error({ err: error }, "message handler failed");
      try {
        const jid = msg.key?.remoteJid;
        if (jid) await sock.sendMessage(jid, { text: card("Error", [`${error.message}`]) });
      } catch (sendError) {
        logger.error({ err: sendError }, "error reply failed");
      }
    }
  }
}

// Keep-alive HTTP server for Koyeb / Render health checks
function startHealthServer() {
  const app = express();
  app.get("/", (_req, res) => {
    res.json({
      bot: BOT_NAME,
      version: BOT_VERSION,
      developer: DEVELOPER,
      uptime: formatUptime(Date.now() - startedAt),
      status: "online"
    });
  });
  app.get("/health", (_req, res) => {
    res.status(200).send("ok");
  });
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[${BOT_NAME}] health server on port ${PORT}`);
  });
}

// Request an 8-digit pairing code when the session is not yet registered
async function requestPairing(sock) {
  if (sock.authState.creds.registered) return;
  if (!BOT_NUMBER) {
    console.log(`[${BOT_NAME}] Set BOT_NUMBER to use pairing-code login.`);
    return;
  }

  await sleep(2000);
  const code = await sock.requestPairingCode(BOT_NUMBER);
  console.log(`[${BOT_NAME}] Pairing code for ${BOT_NUMBER}: ${code}`);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    auth: state,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    try {
      const { connection, lastDisconnect } = update;
      if (connection === "connecting") {
        console.log(`[${BOT_NAME}] connecting...`);
      }
      if (connection === "open") {
        console.log(`[${BOT_NAME}] connected as ${sock.user?.id}`);
        const host = hostInfo();
        const dest = ownerJid() || sock.user?.id;
        if (dest) {
          await sock.sendMessage(dest, {
            text: infoCard("Online", {
              Bot: BOT_NAME,
              Version: BOT_VERSION,
              Number: BOT_NUMBER || sock.user?.id,
              Uptime: formatUptime(Date.now() - startedAt),
              RAM: host.rss,
              Time: nowStamp()
            })
          });
        }
      }
      if (connection === "close") {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`[${BOT_NAME}] connection closed (${statusCode}). reconnect=${!loggedOut}`);
        if (!loggedOut) {
          await sleep(1500);
          startBot().catch((error) => logger.error({ err: error }, "reconnect failed"));
        } else {
          console.log(`[${BOT_NAME}] logged out. delete ${AUTH_DIR} and pair again.`);
        }
      }
    } catch (error) {
      logger.error({ err: error }, "connection.update failed");
    }
  });

  sock.ev.on("messages.upsert", (payload) => {
    onMessages(sock, payload).catch((error) => logger.error({ err: error }, "messages.upsert failed"));
  });

  try {
    await requestPairing(sock);
  } catch (error) {
    logger.error({ err: error }, "pairing failed");
    console.log(`[${BOT_NAME}] pairing failed: ${error.message}`);
  }

  return sock;
}

startHealthServer();
startBot().catch((error) => {
  console.error(`[${BOT_NAME}] fatal start error:`, error);
  process.exit(1);
});
