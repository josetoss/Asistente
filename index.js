/* ╔════════════════════════════════════════════════════════════════╗
 * ║      ASISTENTE JOYA ULTIMATE · v2025                           ║
 * ║    Telegram · Google Sheets · Calendar · OpenWeather · OpenAI   ║
 * ║    Node 18 (ESM) — preparado para Render PaaS                    ║
 * ╚════════════════════════════════════════════════════════════════╝ */

import express       from 'express';
import NodeCache     from 'node-cache';
import { google }    from 'googleapis';
import { DateTime }  from 'luxon';
import { XMLParser } from 'fast-xml-parser';
import fetchPkg      from 'node-fetch';

// ───── POLYFILL fetch (Node <18.20) ───────────────────────────────
if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch   = fetchPkg;
  globalThis.Headers = fetchPkg.Headers;
  globalThis.Request = fetchPkg.Request;
  globalThis.Response= fetchPkg.Response;
}

/* ─── ENV & CONSTANTES ──────────────────────────────────────────── */
const {
  PORT = 3000,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_SECRET,
  OPENWEATHER_API_KEY,
  OPENAI_API_KEY,
  GEMINI_API_KEY,
  CIUDAD_CLIMA = 'Santiago,cl',
  DASHBOARD_SPREADSHEET_ID,
  AGENDA_SHEET_ID,
  GOOGLE_CREDENTIALS,
  GOOGLE_CREDENTIALS_B64,
  ADMIN_CHAT_ID = ''
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_SECRET) {
  throw new Error('❌ Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_SECRET');
}
if (!DASHBOARD_SPREADSHEET_ID) {
  console.warn('⚠️ DASHBOARD_SPREADSHEET_ID no definido — funciones de Sheets fallarán');
}

/* ─── EXPRESS & CACHE ───────────────────────────────────────────── */
const app   = express();
app.use(express.json({ limit: '1mb' }));
const cache = new NodeCache({ stdTTL: 300 });           // 5 min
const TELE_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const banner   = (title, emoji) => `\n${emoji} *${title}*\n──────────────`;
const escapeMd = s => (s||'').replace(/([\\_*[\]()~`>#+\-=|{}.!])/g, '\\$1');

/* ─── FETCH SEGURO ──────────────────────────────────────────────── */
const fetchSafe = (url, ms = 3000) =>
  Promise.race([
    fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }}).then(r => r.text()),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]).catch(() => null);

/* ─── GOOGLE AUTH SINGLETONS ───────────────────────────────────── */
const singleton = fn => { let inst; return (...args) => inst ?? (inst = fn(...args)); };

const googleClient = singleton(async scopes => {
  const raw = GOOGLE_CREDENTIALS
    || (GOOGLE_CREDENTIALS_B64 && Buffer.from(GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8'));
  if (!raw) throw new Error('❌ GOOGLE_CREDENTIALS(_B64) faltante');
  return new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes }).getClient();
});

const sheetsClient   = singleton(async () =>
  google.sheets({ version: 'v4', auth: await googleClient(['https://www.googleapis.com/auth/spreadsheets']) })
);
const calendarClient = singleton(async () =>
  google.calendar({
    version: 'v3',
    auth: await googleClient(['https://www.googleapis.com/auth/calendar.readonly'])
  })
);

/* ─── TELEGRAM SENDER ───────────────────────────────────────────── */
async function sendTelegram(chatId, text) {
  if (!chatId || !text) return;
  const CHUNK = 4000;
  for (let i = 0; i < text.length; i += CHUNK) {
    const slice = text.slice(i, i + CHUNK);
    await fetch(`${TELE_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: escapeMd(slice),
        parse_mode: 'MarkdownV2'
      })
    }).catch(e => console.error('Telegram send error:', e.message));
  }
}

/* ─── OPENWEATHER ──────────────────────────────────────────────── */
async function cityCoords(city) {
  const key = `coords_${city}`;
  if (cache.has(key)) return cache.get(key);
  if (!OPENWEATHER_API_KEY) return null;
  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_API_KEY}`;
  const [data] = await fetch(url).then(r=>r.json()).catch(()=>[]);
  if (!data) return null;
  const coords = { lat: data.lat, lon: data.lon };
  cache.set(key, coords, 86400);
  return coords;
}

async function weather() {
  const key = `weather_${CIUDAD_CLIMA}`;
  if (cache.has(key)) return cache.get(key);
  const coords = await cityCoords(CIUDAD_CLIMA);
  if (!coords) return 'Clima no disponible';
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${coords.lat}&lon=${coords.lon}&units=metric&lang=es&appid=${OPENWEATHER_API_KEY}`;
  const data = await fetch(url).then(r=>r.json()).catch(()=>null);
  if (!data?.list) return 'Clima no disponible';
  const today = DateTime.local().toISODate();
  const list  = data.list.filter(i=>i.dt_txt.startsWith(today));
  if (!list.length) return 'Pronóstico no disponible';
  const min  = Math.round(Math.min(...list.map(i=>i.main.temp_min)));
  const max  = Math.round(Math.max(...list.map(i=>i.main.temp_max)));
  const desc = list[Math.floor(list.length/2)].weather[0].description;
  const out  = `📉 Mín: ${min}°C · 📈 Máx: ${max}°C · ${desc[0].toUpperCase()}${desc.slice(1)}`;
  cache.set(key, out, 10800);
  return out;
}

/* ─── SHEETS UTILITIES ─────────────────────────────────────────── */
const col = async (sheet, col='A') =>
  (await sheetsClient()).spreadsheets.values.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    range: `${sheet}!${col}:${col}`
  }).then(r=>r.data.values?.flat()||[]);

const append = async (sheet, row) =>
  (await sheetsClient()).spreadsheets.values.append({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    range: `${sheet}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] }
  });

const getSheetId = singleton(async name => {
  const meta = await (await sheetsClient()).spreadsheets.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    fields: 'sheets.properties'
  });
  const s = meta.data.sheets.find(s=>s.properties.title===name);
  if (!s) throw new Error(`Sheet "${name}" no encontrado`);
  return s.properties.sheetId;
});

async function addUnique(sheet, text) {
  const vals = await col(sheet);
  if (vals.some(v=>v?.toLowerCase()===text.toLowerCase())) {
    return `ℹ️ "${text}" ya existe en "${sheet}".`;
  }
  await append(sheet, [text]);
  return `✅ Agregado a "${sheet}": ${text}`;
}

async function removeRow(sheet, text) {
  try {
    const vals = await col(sheet);
    const idx  = vals.findIndex(v=>v?.toLowerCase()===text.toLowerCase());
    if (idx<0) return `ℹ️ No se encontró "${text}" en "${sheet}".`;
    await (await sheetsClient()).spreadsheets.batchUpdate({
      spreadsheetId: DASHBOARD_SPREADSHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: await getSheetId(sheet),
              dimension: 'ROWS',
              startIndex: idx,
              endIndex: idx+1
            }
          }
        }]
      }
    });
    return `🗑️ Eliminado de "${sheet}": ${text}`;
  } catch(e) {
    console.error('removeRow error:', e.message);
    return `❌ Error al eliminar en "${sheet}".`;
  }
}

/* ─── AGENDA DE CALENDARIO ─────────────────────────────────────── */
async function getCalendarAgenda() {
  const key = 'agenda';
  if (cache.has(key)) return cache.get(key);
  const cal = await calendarClient();
  const tz  = 'America/Santiago';
  const now = DateTime.local().setZone(tz);
  const end = now.endOf('day').toISO();
  const start = now.startOf('day').toISO();
  const list = await cal.calendarList.list().then(r=>r.data.items||[]);
  const events = (await Promise.all(list.map(c=>
    cal.events.list({ calendarId:c.id, timeMin:start, timeMax:end, singleEvents:true, orderBy:'startTime' })
  ))).flatMap(r=>r.data.items||[])
    .sort((a,b)=> new Date(a.start.dateTime||a.start.date)- new Date(b.start.dateTime||b.start.date))
    .filter(e=>!(e.summary||'').toLowerCase().includes('office'))
    .map(e=>{
      const h = e.start.dateTime
        ? DateTime.fromISO(e.start.dateTime,{zone:tz}).toFormat('HH:mm')
        : 'Todo el día';
      return `• ${h} – ${e.summary||'(sin título)'}`;
    });
  cache.set(key, events, 300);
  return events;
}

/* ─── SINCRONIZAR SHEET → CALENDARIO ───────────────────────────── */
async function syncSheetToCalendar() {
  const key = 'sync_agenda';
  if (cache.has(key)) return;
  if (!AGENDA_SHEET_ID) return;
  try {
    const sheets = await sheetsClient();
    const cal    = await calendarClient();
    const tab   = 'Hoja 1!A2:C';
    const rows  = await sheets.spreadsheets.values.get({ spreadsheetId: AGENDA_SHEET_ID, range: tab })
                        .then(r=>r.data.values||[]);
    const tz    = 'America/Santiago';
    const today = DateTime.local().setZone(tz);
    let bufCal  = await cal.calendarList.list().then(r=>r.data.items.find(c=>c.summary==='Agenda oficina (importada)'));
    if (!bufCal) {
      const nc = await cal.calendars.insert({ resource:{ summary:'Agenda oficina (importada)' } });
      bufCal = nc.data;
    }
    const existing = new Set(
      (await cal.events.list({
        calendarId:bufCal.id,
        timeMin: today.startOf('day').toISO(),
        timeMax: today.endOf('day').toISO(),
        singleEvents:true
      })).data.items.map(e=>`${e.summary}@${e.start.dateTime}`)
    );
    for (const [title, startRaw, endRaw] of rows) {
      if (!title||!startRaw) continue;
      const start = DateTime.fromISO(startRaw,{zone:tz});
      const end   = endRaw
        ? DateTime.fromISO(endRaw,{zone:tz})
        : start.plus({minutes:30});
      const keyEv = `${title}@${start.toISO()}`;
      if (!existing.has(keyEv)) {
        await cal.events.insert({
          calendarId: bufCal.id,
          resource: {
            summary: title,
            start: { dateTime: start.toISO(), timeZone: tz },
            end:   { dateTime: end.toISO(),   timeZone: tz }
          }
        });
      }
    }
    cache.set(key,true,3600);
  } catch(e) {
    console.error('syncSheetToCalendar:', e.message);
  }
}

/* ─── GPT & GEMINI ─────────────────────────────────────────────── */
async function askGPT(prompt, max_tokens=300, temperature=0.6) {
  if (!OPENAI_API_KEY) return '[OPENAI_API_KEY faltante]';
  const res = await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'Authorization':`Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model:'gpt-4o-mini',
      messages:[{role:'user',content:prompt}],
      max_tokens,temperature
    })
  });
  if (!res.ok) {
    console.error('GPT error:', await res.text());
    return `[GPT error: ${res.statusText}]`;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content.trim() || '[GPT vacío]';
}

async function getGemini(prompt, maxOutputTokens=150, temperature=0.5) {
  if (!GEMINI_API_KEY) return '[GEMINI_API_KEY faltante]';
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents:[{parts:[{text:prompt}]}],
      generationConfig:{maxOutputTokens,temperature}
    };
    const res = await fetch(url,{
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    return j.candidates?.[0]?.content?.parts?.[0]?.text.trim() || '[Gemini vacío]';
  } catch(e) {
    console.error('Gemini error:', e.message);
    return '[Gemini error]';
  }
}

async function hybridAI(prompt, max_tokens=300, temperature=0.7) {
  const [g1, g2] = await Promise.all([
    getGemini(prompt, max_tokens, temperature),
    askGPT(prompt, max_tokens, temperature)
  ]);
  return `${g1}\n\n${g2}`;
}

/* ─── CONTENIDO DE IA ──────────────────────────────────────────── */
async function getIntereses() {
  const key = 'intereses';
  if (cache.has(key)) return cache.get(key);
  const list = (await col('Intereses')).slice(1).filter(Boolean).map(t=>t.trim());
  cache.set(key,list,600);
  return list;
}

async function intelGlobal() {
  const key='intel';
  if (cache.has(key)) return cache.get(key);
  const FEEDS = [
    'https://warontherocks.com/feed/','https://www.foreignaffairs.com/rss.xml',
    'https://www.theverge.com/rss/index.xml','https://restofworld.org/feed/latest/',
    'https://feeds.bbci.co.uk/news/world/rss.xml','https://rss.nytimes.com/services/xml/rss/nyt/World.xml'
  ];
  const parser = new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_'});
  const xmls = (await Promise.all(FEEDS.map(fetchSafe))).filter(Boolean);
  const items = xmls.flatMap(x=>{
    const f = parser.parse(x);
    return f.rss?f.rss.channel.item:f.feed?f.feed.entry:[];
  }).slice(0,20);
  const heads = items.map((it,i)=>({
    id:i+1,
    title:it.title,
    link: typeof it.link==='string'?it.link:it.link?.['@_href']
  }));
  const intereses = (await getIntereses()).join(', ')||'geopolítica, tecnología';
  const prompt = `
👁️ Analista senior. Intereses: ${intereses}
Elige 4 titulares y para cada uno escribe 2-3 líneas de impacto con:
• Oportunidad → …
• Riesgo      → …
• Implicancia para Chile → …
Incluye [Link X] al final.
Titulares:
${heads.map(h=>`${h.id}: ${h.title}`).join('\n')}
`;
  let text = await hybridAI(prompt, 600, 0.7);
  heads.forEach(h=>{
    text = text.replace(`[Link ${h.id}]`,`[Ver fuente](${h.link})`);
  });
  cache.set(key,text,3600);
  return text;
}

async function horoscopo() {
  const key='horo';
  if (cache.has(key)) return cache.get(key);
  const drafts = await Promise.allSettled([
    fetchSafe('https://aztro.sameerkumar.website/?sign=libra&day=today').then(t=>t&&JSON.parse(t).description),
    NINJAS_KEY
      ? fetch('https://api.api-ninjas.com/v1/horoscope?zodiac=libra',{headers:{'X-Api-Key':NINJAS_KEY}})
          .then(r=>r.json()).then(d=>d.horoscope).catch(()=>null)
      : null,
    askGPT('Horóscopo Libra hoy (3-4 líneas, profesional).',150,0.7),
    askGPT('Horóscopo Libra (carrera/finanzas).',150,0.7),
    askGPT('Horóscopo Libra (bienestar emocional).',150,0.7)
  ]);
  const combined = drafts.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value).join('\n\n');
  const prompt = `
Eres astrólogo maestro. Sintetiza en un *Mega Horóscopo* (titular en negrita + 4-5 líneas) en español:
${combined}
`;
  const final = await hybridAI(prompt, 250, 0.6);
  cache.set(key,final,21600);
  return final;
}

async function bonusTrack() {
  const key='bonus';
  if (cache.has(key)) return cache.get(key);
  const FEEDS = [
    'https://aeon.co/feed.rss','https://psyche.co/feed','https://longnow.org/ideas/feed/',
    'https://nautil.us/feed/','https://www.quantamagazine.org/feed/','https://publicdomainreview.org/feed/',
    'https://elpais.com/rss/cultura.xml','https://hipertextual.com/feed'
  ];
  const parser = new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_'});
  const xmls = (await Promise.all(FEEDS.map(fetchSafe))).filter(Boolean);
  const items = xmls.flatMap(x=>{
    const f=parser.parse(x);
    return f.rss?f.rss.channel.item:f.feed?f.feed.entry:[];
  }).filter(Boolean);
  // barajar
  for (let i=items.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [items[i],items[j]]=[items[j],items[i]];
  }
  // elegir primer link válido
  let pick;
  for(const it of items.slice(0,30)){
    const link = typeof it.link==='string'?it.link:it.link?.['@_href'];
    try {
      const r = await fetch(link,{method:'HEAD',signal:AbortSignal.timeout(2000)});
      if(r.ok){ pick={title:it.title,link}; break; }
    } catch{}
  }
  if(!pick) return 'No se encontraron artículos válidos hoy.';
  const prompt = `
🔍 Ensayo: «${pick.title}».
1. Resume en 2-3 líneas su valor para un profesional ocupado.
2. Relaciónalo con filosofía, ciencia o historia.
3. Cierra con una pregunta provocadora.
4. Termina con (leer).
`;
  const txt = (await hybridAI(prompt,200,0.75))
                .replace('(leer)',`(leer)(${pick.link})`);
  cache.set(key,txt,86400);
  return txt;
}

/* ─── BRIEFS ───────────────────────────────────────────────────── */
async function briefShort() {
  const [cl, rock, ag, pend] = await Promise.all([
    weather(), bigRocks(), getCalendarAgenda(), pendientes()
  ]);
  return [
    '⚡️ *Resumen Rápido*',
    banner('Clima','🌦️'), cl,
    banner('Big Rock','🚀'), rock.join('\n')||'_(No definido)_',
    banner('Pendientes','🔥'), pend.join('\n')||'_(Sin pendientes)_',
    banner('Agenda','📅'), ag.join('\n')||'_(Sin eventos)_'
  ].join('\n\n');
}

async function briefFull() {
  await syncSheetToCalendar();
  const [cl, ag, pend, rock, intel, horo, bonus] = await Promise.all([
    weather(), getCalendarAgenda(), pendientes(), bigRocks(),
    intelGlobal(), horoscopo(), bonusTrack()
  ]);
  const promptCoach = `
⚔️ Jefe de Gabinete y coach estratégico: formatea en 4 viñetas:
1️⃣ Foco Principal
2️⃣ Riesgo a Mitigar
3️⃣ Acción Clave
4️⃣ Métrica de Éxito
Datos:
Agenda:
${ag.join('\n')||'—'}
Pendientes:
${pend.join('\n')||'—'}
Big Rock:
${rock.join('\n')||'—'}
`;
  const analysis = await hybridAI(promptCoach,350,0.7);
  return [
    '🗞️ *MORNING BRIEF JOYA ULTIMATE*',
    `> _${DateTime.local().setZone('America/Santiago').toFormat("cccc d 'de' LLLL yyyy")}_`,
    banner('Análisis Estratégico','🧠'), analysis,
    banner('Clima','🌦️'), cl,
    banner('Agenda','📅'), ag.join('\n')||'_(Sin eventos)_',
    banner('Pendientes','🔥'), pend.join('\n')||'_(Sin pendientes)_',
    banner('Big Rock','🚀'), rock.join('\n')||'_(No definido)_',
    banner('Radar Inteligencia','🌍'), intel,
    banner('Horóscopo (Libra)','🔮'), horo,
    banner('Bonus Track','🎁'), bonus
  ].join('\n\n');
}

/* ─── DIAGNÓSTICO ──────────────────────────────────────────────── */
async function getSystemStatus() {
  const checks = await Promise.allSettled([
    sheetsClient().then(()=> '✅ Google Sheets'),
    calendarClient().then(()=> '✅ Google Calendar'),
    askGPT('test',1).then(r=>r.includes('[')?`❌ OpenAI (${r})`:'✅ OpenAI'),
    weather().then(r=>r.includes('disponible')?`❌ OpenWeather`:'✅ OpenWeather')
  ]);
  return '*Estado del Sistema JOYA*\n──────────────\n'+
    checks.map(res=> res.status==='fulfilled'?res.value:`❌ ${res.reason.message}`).join('\n');
}

/* ─── ROUTER & WEBHOOK ─────────────────────────────────────────── */
async function router(msg){
  const [cmd,...args] = (msg.text||'').trim().split(' ');
  const arg = args.join(' ').trim();
  switch(cmd){
    case '/start': case '/help':
      return '*JOYA* comandos:\n/brief\n/briefcompleto\n/addrock <t>\n/removerock <t>\n/addinteres <i>\n/removeinteres <i>\n/status';
    case '/brief':         return await briefShort();
    case '/briefcompleto': return await briefFull();
    case '/status':        return await getSystemStatus();
    case '/addrock':       return arg? await addUnique('BigRocks',arg): '✏️ Falta tarea';
    case '/removerock':    return arg? await removeRow('BigRocks',arg): '✏️ Falta tarea';
    case '/addinteres':    return arg? await addUnique('Intereses',arg): '✏️ Falta interés';
    case '/removeinteres': return arg? await removeRow('Intereses',arg): '✏️ Falta interés';
    default: return '🤖 Comando no reconocido. Usa /help';
  }
}

app.post(`/webhook/${TELEGRAM_SECRET}`, (req, res) => {
  res.sendStatus(200);
  (async()=>{
    const msg = req.body.message;
    if (!msg?.text) return;
    try {
      const reply = await router(msg);
      await sendTelegram(msg.chat.id, reply);
    } catch(err) {
      console.error('Webhook error:', err);
      if (ADMIN_CHAT_ID) {
        await sendTelegram(ADMIN_CHAT_ID,
          `🔴 *Error Crítico*\nComando: \`${msg.text}\`\nError: \`${err.message}\``);
      }
    }
  })();
});

app.get('/healthz', (_,res)=> res.send('ok'));
app.listen(PORT, ()=> console.log(`🚀 Joya Ultimate escuchando en ${PORT}`));
