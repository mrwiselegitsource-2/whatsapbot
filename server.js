// Small WhatsApp AI auto-replier: Baileys + Gemini + Supabase (storage) + Express (dashboard)
const express = require('express');
const pino = require('pino');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');
const baileys = require('@whiskeysockets/baileys');
const {
  default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds, proto,
  fetchLatestBaileysVersion, makeCacheableSignalKeyStore, normalizeMessageContent,
  generateMessageID, Browsers,
} = baileys;

const {
  GEMINI_API_KEY, SUPABASE_URL, SUPABASE_KEY, DASHBOARD_PASSWORD,
  OWNER_NAME = 'Mawuli', GEMINI_MODEL = 'gemini-2.5-flash',
  MAX_REPLIES_PER_HOUR = '40', PORT = 3000,
} = process.env;

for (const k of ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY', 'DASHBOARD_PASSWORD']) {
  if (!process.env[k]) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

const logger = pino({ level: 'silent' });
const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny key-value store on Supabase ----------
async function kvGet(key) {
  const { data, error } = await db.from('kv').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}
async function kvSet(key, value) {
  const { error } = await db.from('kv').upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) console.error('kvSet', key, error.message);
}
async function kvDel(key) { await db.from('kv').delete().eq('key', key); }
async function kvDelPrefix(prefix) { await db.from('kv').delete().like('key', prefix + '%'); }

// ---------- WhatsApp login saved in Supabase (survives Render restarts) ----------
async function useDbAuthState() {
  const read = async (k) => {
    const v = await kvGet('auth:' + k);
    return v ? JSON.parse(JSON.stringify(v), BufferJSON.reviver) : null;
  };
  const write = (k, v) => kvSet('auth:' + k, JSON.parse(JSON.stringify(v, BufferJSON.replacer)));
  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let v = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: async (data) => {
          const jobs = [];
          for (const type in data) for (const id in data[type]) {
            const v = data[type][id];
            jobs.push(v ? write(`${type}-${id}`, v) : kvDel(`auth:${type}-${id}`));
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

// ---------- settings + chat memory ----------
const DEFAULT_PROMPT = `You reply on WhatsApp on behalf of ${OWNER_NAME}.
Write exactly like ${OWNER_NAME} does in the conversation: same language, tone, message length, slang and emoji habits.
Keep replies short and natural, like a real chat message. No markdown, no lists unless asked.
Never invent facts, prices, promises or appointments you were not given. If you don't know, say you'll get back to them.
If someone sincerely asks whether they are talking to an AI, say you are ${OWNER_NAME}'s AI assistant.
If no reply is needed (for example just "ok", "thanks" or a reaction), output exactly: SKIP`;

let cfg = { basePrompt: DEFAULT_PROMPT, chats: {} }; // chats[jid] = {name, group, enabled, prompt, notes, trigger}
const hist = {};            // jid -> [{me, who, text, t}]  (only kept for enabled chats)
const dirtyHist = new Set();
let cfgTimer;

function saveCfg() { clearTimeout(cfgTimer); cfgTimer = setTimeout(() => kvSet('config', cfg), 1500); }
function push(jid, e) {
  const a = hist[jid] || (hist[jid] = []);
  a.push(e);
  if (a.length > 40) a.splice(0, a.length - 40);
  dirtyHist.add(jid);
}
setInterval(() => {
  for (const jid of [...dirtyHist]) { dirtyHist.delete(jid); kvSet('hist:' + jid, hist[jid] || []); }
}, 15000);

async function loadAll() {
  const saved = await kvGet('config');
  if (saved) cfg = { basePrompt: saved.basePrompt || DEFAULT_PROMPT, chats: saved.chats || {} };
  for (const [jid, c] of Object.entries(cfg.chats)) if (c.enabled) hist[jid] = (await kvGet('hist:' + jid)) || [];
}

function newChat(jid, name, group) {
  return { name, group, enabled: false, prompt: '', notes: '', trigger: '' };
}

// ---------- AI reply ----------
const sentIds = new Set();
const sentTimes = [];
const timers = {};
const status = { state: 'starting', me: '', error: '' };
let sock;

function underBudget() {
  const cutoff = Date.now() - 3600e3;
  while (sentTimes.length && sentTimes[0] < cutoff) sentTimes.shift();
  return sentTimes.length < Number(MAX_REPLIES_PER_HOUR);
}

function schedule(jid) {            // wait a few seconds so quick bursts get ONE reply
  clearTimeout(timers[jid]);
  timers[jid] = setTimeout(() => reply(jid).catch((e) => { status.error = e.message; console.error('reply', e.message); }), 3500);
}

async function reply(jid) {
  const chat = cfg.chats[jid];
  if (!chat || !chat.enabled || !sock || status.state !== 'open' || !underBudget()) return;
  const h = hist[jid] || [];
  if (!h.length || h[h.length - 1].me) return;

  const transcript = h.slice(-30).map((x) => `${x.who}: ${x.text}`).join('\n');
  const system = [
    cfg.basePrompt,
    chat.prompt && `Instructions for this chat:\n${chat.prompt}`,
    chat.notes && `Notes about this chat and how people talk in it:\n${chat.notes}`,
  ].filter(Boolean).join('\n\n');

  const r = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `Conversation so far (oldest first):\n${transcript}\n\nWrite ${OWNER_NAME}'s next message. Output only the message text.`,
    config: { systemInstruction: system, temperature: 0.8, maxOutputTokens: 500 },
  });
  const out = (r.text || '').trim();
  if (!out || out === 'SKIP') return;

  await sock.sendPresenceUpdate('composing', jid);
  await sleep(Math.min(1500 + out.length * 40, 8000));
  const id = generateMessageID();
  sentIds.add(id);
  await sock.sendMessage(jid, { text: out }, { messageId: id });
  await sock.sendPresenceUpdate('paused', jid);
  sentTimes.push(Date.now());
  push(jid, { me: true, who: OWNER_NAME, text: out, t: Date.now() });
  status.error = '';
}

function textOf(m) {
  const c = normalizeMessageContent(m.message);
  if (!c) return '';
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || '';
}

async function onMessage(m) {
  const jid = m.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  if (sentIds.has(m.key.id)) return;                 // our own AI message echoing back
  const text = textOf(m);
  if (!text) return;

  const group = jid.endsWith('@g.us');
  const fromMe = !!m.key.fromMe;
  let chat = cfg.chats[jid];
  if (!chat) {
    chat = cfg.chats[jid] = newChat(jid, group ? jid : (!fromMe && m.pushName) || jid.split('@')[0], group);
    saveCfg();
  } else if (!group && !fromMe && m.pushName && chat.name !== m.pushName) {
    chat.name = m.pushName; saveCfg();
  }
  if (!chat.enabled) return;

  const who = fromMe ? OWNER_NAME : (m.pushName || chat.name);
  push(jid, { me: fromMe, who, text: text.slice(0, 600), t: Date.now() });
  if (fromMe) return;                                // learn from my own messages, never reply to them
  if (chat.trigger && !text.toLowerCase().includes(chat.trigger.toLowerCase())) return;
  schedule(jid);
}

async function refreshGroups() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    let changed = false;
    for (const [jid, g] of Object.entries(groups)) {
      if (!cfg.chats[jid]) { cfg.chats[jid] = newChat(jid, g.subject, true); changed = true; }
      else if (cfg.chats[jid].name !== g.subject) { cfg.chats[jid].name = g.subject; changed = true; }
    }
    if (changed) saveCfg();
  } catch (e) { console.error('groups', e.message); }
}

// ---------- WhatsApp connection ----------
async function start() {
  const { state, saveCreds } = await useDbAuthState();
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) status.state = 'needs_pairing';
    if (connection === 'open') {
      status.state = 'open';
      status.me = (sock.user?.id || '').split(':')[0].split('@')[0];
      refreshGroups();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        await kvDelPrefix('auth:');                  // phone unlinked us: wipe login, start fresh
        status.state = 'needs_pairing'; status.me = '';
      } else {
        status.state = 'reconnecting';
      }
      setTimeout(() => start().catch((e) => console.error('start', e.message)), 3000);
    }
  });

  sock.ev.on('contacts.upsert', (list) => {
    let changed = false;
    for (const c of list) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net') || cfg.chats[c.id]) continue;
      cfg.chats[c.id] = newChat(c.id, c.name || c.notify || c.id.split('@')[0], false);
      changed = true;
    }
    if (changed) saveCfg();
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) { try { await onMessage(m); } catch (e) { console.error('msg', e.message); } }
  });
}

// ---------- dashboard API ----------
const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.send('ok'));            // ping this URL to keep Render awake
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) =>
  req.get('x-pass') === DASHBOARD_PASSWORD ? next() : res.status(401).json({ error: 'Wrong password' });

app.get('/api/state', auth, (_req, res) => {
  const chats = Object.entries(cfg.chats)
    .map(([jid, c]) => ({ jid, ...c, remembered: (hist[jid] || []).length }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  res.json({ status, basePrompt: cfg.basePrompt, chats, repliesLastHour: sentTimes.length, maxPerHour: Number(MAX_REPLIES_PER_HOUR) });
});

app.post('/api/pair', auth, async (req, res) => {
  try {
    if (sock.authState.creds.registered) return res.json({ error: 'Already linked' });
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    if (!phone) return res.json({ error: 'Enter your number with country code, e.g. 233XXXXXXXXX' });
    res.json({ code: await sock.requestPairingCode(phone) });
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/chat', auth, async (req, res) => {
  const { jid, enabled, prompt, notes, trigger } = req.body;
  const c = cfg.chats[jid];
  if (!c) return res.status(404).json({ error: 'Unknown chat' });
  Object.assign(c, { enabled: !!enabled, prompt: String(prompt || ''), notes: String(notes || ''), trigger: String(trigger || '') });
  if (c.enabled && !hist[jid]) hist[jid] = (await kvGet('hist:' + jid)) || [];
  saveCfg();
  res.json({ ok: true });
});

app.post('/api/chat/forget', auth, async (req, res) => {
  const { jid } = req.body;
  hist[jid] = []; dirtyHist.add(jid);
  res.json({ ok: true });
});

app.post('/api/settings', auth, (req, res) => {
  cfg.basePrompt = String(req.body.basePrompt || '').trim() || DEFAULT_PROMPT;
  saveCfg();
  res.json({ ok: true });
});

app.post('/api/logout', auth, async (_req, res) => {
  try { await sock.logout(); } catch (_) { /* close handler wipes the login */ }
  res.json({ ok: true });
});

// ---------- go ----------
app.listen(PORT, () => console.log('Dashboard on port', PORT));
loadAll().then(start).catch((e) => { console.error('fatal', e); process.exit(1); });
