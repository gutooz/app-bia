'use strict';
require('dotenv').config();

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const IS_VERCEL = !!process.env.VERCEL;
const USE_DB    = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY &&
                     !process.env.SUPABASE_URL.includes('SEU_PROJETO'));

app.use(express.static(__dirname));
app.use(express.json());

// ── Supabase ────────────────────────────────────────────────────────
let sb = null;
if (USE_DB) {
  const { createClient } = require('@supabase/supabase-js');
  sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// ── File storage (local dev sem Supabase) ───────────────────────────
function loadFile() {
  if (!fs.existsSync(DATA_FILE)) {
    const def = {
      tasks: [], hearings: [], notes: '',
      tg: { token: process.env.TG_TOKEN || '', chatId: process.env.TG_CHAT_ID || '', offset: 0 }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(def, null, 2));
    return def;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveFile(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
const gid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── Abstract data layer ─────────────────────────────────────────────
const db = {
  async getTasks() {
    if (sb) {
      const { data, error } = await sb.from('tasks').select('*').order('ca', { ascending: false });
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, tit: r.tit, desc: r.desc, pri: r.pri, due: r.due, st: r.st, ca: r.ca }));
    }
    return loadFile().tasks;
  },
  async addTask(t) {
    if (sb) {
      const { error } = await sb.from('tasks').insert(t);
      if (error) throw error;
    } else {
      const d = loadFile(); d.tasks.unshift(t); saveFile(d);
    }
  },
  async updateTask(id, u) {
    if (sb) {
      const { error } = await sb.from('tasks').update(u).eq('id', id);
      if (error) throw error;
    } else {
      const d = loadFile(); const t = d.tasks.find(x => x.id === id);
      if (t) Object.assign(t, u); saveFile(d);
    }
  },
  async deleteTask(id) {
    if (sb) {
      const { error } = await sb.from('tasks').delete().eq('id', id);
      if (error) throw error;
    } else {
      const d = loadFile(); d.tasks = d.tasks.filter(x => x.id !== id); saveFile(d);
    }
  },
  async getHearings() {
    if (sb) {
      const { data, error } = await sb.from('hearings').select('*').order('date').order('time');
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, date: r.date, time: r.time, cli: r.cli, notes: r.notes }));
    }
    return loadFile().hearings;
  },
  async addHearing(h) {
    if (sb) {
      const { error } = await sb.from('hearings').insert(h);
      if (error) throw error;
    } else {
      const d = loadFile(); d.hearings.push(h);
      d.hearings.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
      saveFile(d);
    }
  },
  async deleteHearing(id) {
    if (sb) {
      const { error } = await sb.from('hearings').delete().eq('id', id);
      if (error) throw error;
    } else {
      const d = loadFile(); d.hearings = d.hearings.filter(x => x.id !== id); saveFile(d);
    }
  },
  async markReminded(id) {
    if (sb) {
      await sb.from('hearings').update({ reminded: true }).eq('id', id);
    } else {
      const d = loadFile();
      const h = d.hearings.find(x => x.id === id);
      if (h) { h.reminded = true; saveFile(d); }
    }
  },
  async getNotes() {
    if (sb) {
      const { data } = await sb.from('notes').select('content').eq('id', 1).single();
      return data?.content || '';
    }
    return loadFile().notes;
  },
  async saveNotes(content) {
    if (sb) {
      const { error } = await sb.from('notes').upsert({ id: 1, content });
      if (error) throw error;
    } else {
      const d = loadFile(); d.notes = content; saveFile(d);
    }
  },
  async getTgConfig() {
    if (sb) {
      const { data } = await sb.from('tg_config').select('*').eq('id', 1).single();
      return {
        token:  data?.token   || process.env.TG_TOKEN   || '',
        chatId: data?.chat_id || process.env.TG_CHAT_ID || '',
        offset: data?.offset  || 0
      };
    }
    const d = loadFile();
    return {
      token:  d.tg.token  || process.env.TG_TOKEN   || '',
      chatId: d.tg.chatId || process.env.TG_CHAT_ID || '',
      offset: d.tg.offset || 0
    };
  },
  async saveTgConfig(u) {
    if (sb) {
      const row = { id: 1 };
      if (u.token  !== undefined) row.token   = u.token;
      if (u.chatId !== undefined) row.chat_id = u.chatId;
      if (u.offset !== undefined) row.offset  = u.offset;
      const { error } = await sb.from('tg_config').upsert(row);
      if (error) throw error;
    } else {
      const d = loadFile();
      if (u.token  !== undefined) d.tg.token  = u.token;
      if (u.chatId !== undefined) d.tg.chatId = u.chatId;
      if (u.offset !== undefined) d.tg.offset = u.offset;
      saveFile(d);
    }
  }
};

// ── SSE ─────────────────────────────────────────────────────────────
let dataClients = [];
let logEntries  = [];

function broadcastData() {
  dataClients.forEach(c => { try { c.write('data: update\n\n'); } catch(e) {} });
}
function broadcastLog(msg, type = 'info') {
  const entry = { t: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), msg, type };
  logEntries.push(entry);
  if (logEntries.length > 100) logEntries.shift();
  dataClients.forEach(c => { try { c.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`); } catch(e) {} });
  const icons = { ok: '✅', err: '❌', info: 'ℹ️' };
  console.log(`${icons[type] || 'ℹ️'} ${msg}`);
}

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  logEntries.forEach(e => res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`));
  dataClients.push(res);
  req.on('close', () => { dataClients = dataClients.filter(c => c !== res); });
});

// ── AUTH ─────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.LOGIN_EMAIL && password === process.env.LOGIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Credenciais inválidas' });
  }
});

// ── API: DATA ────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const [tasks, hearings, notes, tg] = await Promise.all([
      db.getTasks(), db.getHearings(), db.getNotes(), db.getTgConfig()
    ]);
    res.json({ tasks, hearings, notes, tg: { token: tg.token ? '***' : '', chatId: tg.chatId, active: tgPolling } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: TASKS ───────────────────────────────────────────────────────
app.post('/api/tasks', async (req, res) => {
  try {
    const body = req.body || {};
    const { tit, desc, pri, due, st } = body;
    console.log('[tasks POST] body:', JSON.stringify(body));
    if (!tit) return res.status(400).json({ error: 'Título obrigatório' });
    const t = { id: gid(), tit, desc: desc || '', pri: pri || 'media', due: due || '', st: st || 'af', ca: new Date().toISOString() };
    await db.addTask(t);
    console.log('[tasks POST] saved:', tit);
    res.json({ ok: true, tasks: await db.getTasks() });
    broadcastData();
  } catch (e) {
    console.error('[tasks POST] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch('/api/tasks/:id', async (req, res) => {
  try {
    await db.updateTask(req.params.id, req.body || {});
    res.json({ ok: true, tasks: await db.getTasks() });
    broadcastData();
  } catch (e) {
    console.error('[tasks PATCH] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await db.deleteTask(req.params.id);
    res.json({ ok: true, tasks: await db.getTasks() });
    broadcastData();
  } catch (e) {
    console.error('[tasks DELETE] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: HEARINGS ─────────────────────────────────────────────────────
app.post('/api/hearings', async (req, res) => {
  try {
    const body = req.body || {};
    const { date, time, cli, notes } = body;
    if (!date || !time || !cli) return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
    await db.addHearing({ id: gid(), date, time, cli, notes: notes || '' });
    res.json({ ok: true, hearings: await db.getHearings() });
    broadcastData();
  } catch (e) {
    console.error('[hearings POST] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/hearings/:id', async (req, res) => {
  try {
    await db.deleteHearing(req.params.id);
    res.json({ ok: true, hearings: await db.getHearings() });
    broadcastData();
  } catch (e) {
    console.error('[hearings DELETE] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: NOTES ────────────────────────────────────────────────────────
app.put('/api/notes', async (req, res) => {
  try {
    await db.saveNotes((req.body || {}).notes ?? '');
    res.json({ ok: true });
  } catch (e) {
    console.error('[notes PUT] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: TELEGRAM ─────────────────────────────────────────────────────
app.get('/api/tg/status', async (req, res) => {
  const tg = await db.getTgConfig();
  res.json({ active: tgPolling, hasToken: !!tg.token, chatId: tg.chatId || '', mode: IS_VERCEL ? 'webhook' : 'polling' });
});

app.post('/api/tg/config', async (req, res) => {
  const u = {};
  if (req.body.token  !== undefined && req.body.token  !== '***') u.token  = req.body.token;
  if (req.body.chatId !== undefined)                               u.chatId = req.body.chatId;
  await db.saveTgConfig(u);
  res.json({ ok: true });
});

app.get('/api/tg/detect', async (req, res) => {
  const tg = await db.getTgConfig();
  if (!tg.token) return res.json({ ok: false, error: 'Token não configurado' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/getUpdates?limit=20`);
    const data = await r.json();
    if (!data.ok) return res.json({ ok: false, error: data.description });
    const msgs = data.result.filter(u => u.message?.chat?.id);
    if (!msgs.length) return res.json({ ok: false, error: 'Nenhuma mensagem encontrada. Envie /start ao bot primeiro.' });
    const chatId = String(msgs[msgs.length - 1].message.chat.id);
    await db.saveTgConfig({ chatId });
    broadcastLog(`Chat ID detectado: ${chatId}`, 'ok');
    res.json({ ok: true, chatId });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/tg/connect', async (req, res) => {
  const tg = await db.getTgConfig();
  if (!tg.token)  return res.json({ ok: false, error: 'Token não configurado' });
  if (!tg.chatId) return res.json({ ok: false, error: 'Chat ID não configurado. Clique em Detectar.' });
  if (IS_VERCEL)  return res.json({ ok: false, error: 'No Vercel use o Webhook (botão abaixo).' });
  const started = await startTgBot();
  res.json({ ok: started });
});

app.post('/api/tg/disconnect', (req, res) => {
  stopTgBot();
  res.json({ ok: true });
});

// Webhook (Vercel / produção)
app.post('/api/tg/webhook', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (process.env.TG_WEBHOOK_SECRET && secret !== process.env.TG_WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  res.json({ ok: true });
  try { await handleUpdate(req.body); } catch (e) { console.error('Webhook error:', e); }
});

app.post('/api/tg/set-webhook', async (req, res) => {
  const tg = await db.getTgConfig();
  if (!tg.token) return res.json({ ok: false, error: 'Token não configurado' });
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host'] || req.get('host');
  const webhookUrl = `${proto}://${host}/api/tg/webhook`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: process.env.TG_WEBHOOK_SECRET || '', allowed_updates: ['message'] })
    });
    const data = await r.json();
    if (data.ok) {
      broadcastLog(`Webhook configurado: ${webhookUrl}`, 'ok');
      res.json({ ok: true, url: webhookUrl });
    } else {
      res.json({ ok: false, error: data.description });
    }
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── TELEGRAM BOT ──────────────────────────────────────────────────────
let tgPolling = false;
let tgTimer   = null;
const isWed   = s => new Date(s + 'T12:00:00').getDay() === 3;

async function tgSend(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) { broadcastLog('Erro ao enviar mensagem: ' + e.message, 'err'); }
}

async function startTgBot() {
  if (tgPolling || IS_VERCEL) return false;
  const tg = await db.getTgConfig();
  if (!tg.token || !tg.chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/getMe`);
    const data = await r.json();
    if (!data.ok) { broadcastLog('Token inválido: ' + data.description, 'err'); return false; }
    broadcastLog(`Bot conectado: @${data.result.username}`, 'ok');
  } catch (e) { broadcastLog('Sem conexão com Telegram: ' + e.message, 'err'); return false; }
  tgPolling = true;
  broadcastData();
  pollTelegram();
  return true;
}

function stopTgBot() {
  tgPolling = false;
  clearTimeout(tgTimer);
  tgTimer = null;
  broadcastLog('Bot desconectado', 'info');
  broadcastData();
}

async function pollTelegram() {
  if (!tgPolling) return;
  const tg = await db.getTgConfig();
  if (!tg.token) { stopTgBot(); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/getUpdates?offset=${tg.offset}&timeout=5`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.ok && data.result.length) {
      for (const u of data.result) {
        await db.saveTgConfig({ offset: u.update_id + 1 });
        await handleUpdate(u);
      }
    }
  } catch (e) {
    if (tgPolling) broadcastLog('Polling error: ' + e.message, 'err');
  }
  if (tgPolling) tgTimer = setTimeout(pollTelegram, 3000);
}

// ── Gemini: interpreta mensagem em linguagem natural ─────────────────
async function askAI(userMessage) {
  const apiKey = process.env.GEMINI_KEY;
  if (!apiKey || apiKey.includes('COLE_SUA')) throw new Error('GEMINI_KEY não configurada no .env');

  const hoje    = new Date();
  const hojeISO = hoje.toISOString().split('T')[0];
  const hojeStr = hoje.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  const amanha  = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const semanaQ = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  const prompt = `Você é um assistente de Ana Beatriz, estagiária de direito no Brasil.
Hoje é ${hojeStr} (${hojeISO}).

Interprete a mensagem do usuário e retorne APENAS um JSON válido (sem markdown, sem texto extra).

Formatos possíveis:
{"action":"tarefa","tit":"string","pri":"alta|media|baixa","due":"YYYY-MM-DD ou null","desc":"string ou null"}
{"action":"audiencia","date":"YYYY-MM-DD","time":"HH:MM","cli":"nome do cliente","notes":"string ou null"}
{"action":"nota","content":"string"}
{"action":"ajuda"}

Regras:
- Audiências SOMENTE às quartas-feiras. Se o dia pedido não for quarta, escolha a quarta mais próxima.
- Prioridade padrão "media". Use "alta" para urgente/prazo/imediato. "baixa" para eventual/sem pressa.
- "due": amanhã=${amanha}, semana que vem≈${semanaQ}. null se não houver prazo.
- Retorne {"action":"ajuda"} se não entender ou for saudação/pergunta genérica.

Mensagem do usuário: ${userMessage}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
    })
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Gemini ${r.status}: ${err.slice(0, 300)}`);
  }

  const data = await r.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!raw) throw new Error('Sem resposta do Gemini');
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(clean);
}

function parseSimples(txt) {
  const tl = txt.toLowerCase().trim();

  // Tarefa
  if (/^(\/tarefa|tarefa)[:\s]/i.test(tl) || /^\/tarefa$/i.test(tl)) {
    let content = txt.replace(/^\/tarefa\s*/i, '').replace(/^tarefa[:\s]*/i, '').trim();
    let pri = 'media';
    if (/^(urgente|alta)[:\s]/i.test(content)) { pri = 'alta'; content = content.replace(/^(urgente|alta)[:\s]*/i, '').trim(); }
    else if (/^baixa[:\s]/i.test(content)) { pri = 'baixa'; content = content.replace(/^baixa[:\s]*/i, '').trim(); }
    else if (/urgent|urgente|imediato|priorit/i.test(content)) { pri = 'alta'; }
    return content ? { action: 'tarefa', tit: content, pri, due: null, desc: null } : { action: 'ajuda' };
  }

  // Audiência
  if (/^(\/audi[eê]ncia|audi[eê]ncia)[:\s]/i.test(tl) || /^\/audi[eê]ncia$/i.test(tl)) {
    const content = txt.replace(/^\/audi[eê]ncia\s*/i, '').replace(/^audi[eê]ncia[:\s]*/i, '').trim();
    // Formato: DD/MM HH:MM nome  OU  DD/MM às HH:MM nome  OU  nome DD/MM HH:MM
    const m = content.match(/(\d{1,2})\/(\d{1,2})\s+(?:às\s+)?(\d{1,2}:\d{2})\s+(.+)/) ||
              content.match(/(\d{1,2})\/(\d{1,2})\s+(?:às\s+)?(\d{1,2}h\d{0,2})\s+(.+)/);
    if (m) {
      const [, dy, mo, rawTime, name] = m;
      const time = rawTime.replace('h', ':').replace(/:$/, ':00').padEnd(5, '0');
      const yr = new Date().getFullYear();
      return { action: 'audiencia', date: `${yr}-${mo.padStart(2,'0')}-${dy.padStart(2,'0')}`, time, cli: name.trim(), notes: null };
    }
    // Só nome e horário sem data — retorna ajuda com dica
    return { action: 'ajuda_audiencia' };
  }

  // Nota
  if (/^(\/nota|nota|anotar)[:\s]/i.test(tl) || /^\/nota$/i.test(tl)) {
    const content = txt.replace(/^\/(nota)\s*/i, '').replace(/^(nota|anotar)[:\s]*/i, '').trim();
    return content ? { action: 'nota', content } : { action: 'ajuda' };
  }

  return { action: 'ajuda' };
}

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg?.text) return;
  const tg = await db.getTgConfig();
  if (tg.chatId && String(msg.chat.id) !== tg.chatId) return;

  const txt  = msg.text.trim();
  let reply  = '';

  // Comando /start ou /ajuda sem IA
  if (/^\/(start|ajuda|help)$/i.test(txt)) {
    reply = '🤖 <b>Assistente da Ana Beatriz</b>\n\nMe escreva em linguagem natural o que precisa!\n\nExemplos:\n• "Adicionar tarefa urgente de fazer a petição inicial"\n• "Audiência quarta que vem às 14h com João Silva"\n• "Anotar: ligar para o cliente amanhã cedo"\n• "Prazo para entrega do recurso na sexta"\n\nO assistente entende português e cria a tarefa, audiência ou nota automaticamente. ⚖️';
    return tgSend(tg.token, msg.chat.id, reply);
  }

  // Detecta se OpenAI está disponível; se não, usa parsing simples
  const hasAI = !!(process.env.GEMINI_KEY && !process.env.GEMINI_KEY.includes('COLE_SUA'));
  let intent = null;

  if (hasAI) {
    try {
      broadcastLog(`IA processando: "${txt.slice(0,40)}..."`, 'info');
      intent = await askAI(txt);
    } catch (aiErr) {
      broadcastLog(`IA indisponível (${aiErr.message.slice(0,60)}), usando parsing simples`, 'err');
      intent = parseSimples(txt);
    }
  } else {
    intent = parseSimples(txt);
  }

  try {
    const priLabel = { alta: '🔴 Alta', media: '🟡 Média', baixa: '🟢 Baixa' };

    if (intent.action === 'tarefa') {
      if (!intent.tit) throw new Error('Título não identificado');
      const task = { id: gid(), tit: intent.tit, desc: intent.desc || '', pri: intent.pri || 'media', due: intent.due || '', st: 'af', ca: new Date().toISOString() };
      await db.addTask(task);
      broadcastData();
      broadcastLog(`Nova tarefa via IA: "${intent.tit}"`, 'ok');
      const prazo = intent.due ? `\n📅 Prazo: ${new Date(intent.due + 'T12:00:00').toLocaleDateString('pt-BR')}` : '';
      reply = `✅ Tarefa adicionada!\n\n📋 <b>${intent.tit}</b>\nPrioridade: ${priLabel[intent.pri] || priLabel.media}${prazo}`;

    } else if (intent.action === 'audiencia') {
      if (!intent.date || !intent.time || !intent.cli) throw new Error('Data, horário ou cliente não identificados');
      await db.addHearing({ id: gid(), date: intent.date, time: intent.time, cli: intent.cli, notes: intent.notes || '' });
      broadcastData();
      broadcastLog(`Nova audiência: ${intent.cli} ${intent.date} ${intent.time}h`, 'ok');
      const dtStr = new Date(intent.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long' });
      const avisoQuarta = !isWed(intent.date) ? '\n\n⚠️ <i>Atenção: esta data não é quarta-feira.</i>' : '';
      reply = `✅ Audiência cadastrada!\n\n⚖️ <b>${intent.cli}</b>\n📅 ${dtStr} às ${intent.time}h${intent.notes ? '\n📝 ' + intent.notes : ''}${avisoQuarta}`;

    } else if (intent.action === 'nota') {
      if (!intent.content) throw new Error('Conteúdo da nota não identificado');
      const cur = await db.getNotes();
      const dt  = new Date().toLocaleDateString('pt-BR');
      await db.saveNotes((cur ? cur + '\n' : '') + `[${dt}] ${intent.content}`);
      broadcastData();
      broadcastLog('Nova anotação via IA', 'ok');
      reply = `✅ Anotação salva!\n\n📝 <i>${intent.content}</i>`;

    } else if (intent.action === 'ajuda_audiencia') {
      reply = '⚖️ Para cadastrar audiência, informe a data, horário e cliente:\n\n<b>Exemplos:</b>\n• audiência 18/06 14:00 João Silva\n• audiência 25/06 às 9h Maria Souza\n\nFormato: <code>audiência DD/MM HH:MM nome do cliente</code>';

    } else {
      reply = '🤖 <b>Olá, Ana Beatriz!</b>\n\nMe diga o que precisa:\n\n• "tarefa urgente: petição inicial"\n• "audiência 18/06 14:00 João Silva"\n• "anotar: ligar para cliente amanhã"\n\nEstou aqui para ajudar! ⚖️';
    }

  } catch (e) {
    broadcastLog('Erro IA: ' + e.message, 'err');
    if (e.message.includes('GEMINI_KEY')) {
      reply = '⚙️ Chave do Gemini não configurada no servidor. Configure GEMINI_KEY no arquivo .env e reinicie.';
    } else {
      reply = `❌ Não consegui interpretar sua mensagem.\n\n${e.message.includes('JSON') ? 'Tente reformular de forma mais direta.' : e.message}\n\nExemplos:\n• "tarefa urgente: petição inicial"\n• "audiência quarta dia 18/06 às 14h com João"`;
    }
  }

  if (reply) await tgSend(tg.token, msg.chat.id, reply);
}

// ── Lembretes de audiência (30 min antes) ────────────────────────────
const lembretesEnviados = new Set(); // cache local para modo não-serverless

async function verificarLembretes() {
  try {
    const [hearings, tg] = await Promise.all([db.getHearings(), db.getTgConfig()]);
    if (!tg.token || !tg.chatId) return;

    const agora = new Date();
    let enviados = 0;

    for (const h of hearings) {
      // Já avisado (Supabase) ou em cache local (data.json)
      if (h.reminded || lembretesEnviados.has(h.id)) continue;

      const dataAud = new Date(`${h.date}T${h.time}:00`);
      const diffMin = (dataAud - agora) / 60000;

      if (diffMin >= 28 && diffMin <= 32) {
        lembretesEnviados.add(h.id);
        await db.markReminded(h.id);
        const dtStr = dataAud.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
        const msg = `⏰ <b>Lembrete de Audiência!</b>\n\n⚖️ <b>${h.cli}</b>\n📅 ${dtStr} às ${h.time}h\n\nDaqui a 30 minutos! Boa audiência, Bia! ⚖️✨`;
        await tgSend(tg.token, tg.chatId, msg);
        broadcastLog(`🔔 Lembrete enviado: ${h.cli} às ${h.time}h`, 'ok');
        enviados++;
      }
    }
    return enviados;
  } catch (e) {
    console.error('Erro lembretes:', e.message);
    return 0;
  }
}

// Endpoint chamado pelo cron (Vercel Cron ou cron-job.org)
app.get('/api/cron/lembretes', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const n = await verificarLembretes();
  res.json({ ok: true, enviados: n, ts: new Date().toISOString() });
});

// ── START ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   Agenda da Estagiária — Ana Beatriz ║');
  console.log(`  ║  http://localhost:${PORT}               ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Dados: ${USE_DB ? 'Supabase ☁️' : 'data.json 📁'}`);
  console.log(`  Modo:  ${IS_VERCEL ? 'Vercel (webhook)' : 'Local (polling)'}`);
  console.log('');

  if (!IS_VERCEL) {
    const tg = await db.getTgConfig();
    if (tg.token && tg.chatId) {
      console.log('  ▶ Iniciando bot do Telegram...');
      await startTgBot();
    } else {
      console.log('  ℹ️  Telegram: configure na aba Telegram do app');
    }
  }

  // Verifica lembretes a cada minuto
  setInterval(verificarLembretes, 60 * 1000);
  verificarLembretes();
});
