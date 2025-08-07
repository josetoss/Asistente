/* ╔════════════════════════════════════════════════════════════════╗
 * ║                 ASISTENTE JOYA ULTIMATE · v2025               ║
 * ║   Telegram · Google Sheets · Calendar · OpenWeather · OpenAI  ║
 * ║        Node 18 (ESM) — listo para Render PaaS                 ║
 * ╚════════════════════════════════════════════════════════════════╝ */

import express from 'express';
import fetch from 'node-fetch';                     // polyfill estable
import NodeCache from 'node-cache';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { XMLParser } from 'fast-xml-parser';

/* ─── ENV ───────────────────────────────────────────────────────── */
const {
  PORT = 3000,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_SECRET,
  OPENWEATHER_API_KEY,
  OPENAI_API_KEY,
  NINJAS_KEY,
  CIUDAD_CLIMA = 'Santiago,cl',
  DASHBOARD_SPREADSHEET_ID,
  AGENDA_SHEET_ID,
  ADMIN_CHAT_ID,
  GOOGLE_CREDENTIALS,
  GOOGLE_CREDENTIALS_B64
} = process.env;

if (!TELEGRAM_SECRET || !TELEGRAM_BOT_TOKEN)
  throw new Error('Faltan TELEGRAM_SECRET y/o TELEGRAM_BOT_TOKEN');
if (!DASHBOARD_SPREADSHEET_ID)
  console.warn('⚠️  DASHBOARD_SPREADSHEET_ID no definido — funciones de Sheets fallarán');

/* ─── Express & caché ───────────────────────────────────────────── */
const app     = express();
app.use(express.json({ limit: '1mb' }));
const cache   = new NodeCache({ stdTTL: 300 });            // 5 min
const TELE_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const banner   = (t, e) => `\n${e} *${t}*\n──────────────`;
const escapeMd = s => (s || '')
  .replace(/([\\_*[\]()~`>#+\-=|{}.!])/g, '\\$1');

/* ─── helper seguro (timeout + catch) ───────────────────────────── */
const fetchSafe = (url, ms = 3000) =>
  Promise.race([
    fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text()),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]).catch(() => null);                                // → null si falla

/* ─── Google Auth (singletons) ──────────────────────────────────── */
const singleton = fn => { let i; return (...a) => i ?? (i = fn(...a)); };

const googleClient = singleton(async scopes => {
  const raw = GOOGLE_CREDENTIALS ||
              (GOOGLE_CREDENTIALS_B64 &&
               Buffer.from(GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8'));
  if (!raw) throw new Error('GOOGLE_CREDENTIALS(_B64) faltante');
  return new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes }).getClient();
});

const sheetsClient = singleton(async () =>
  google.sheets({ version: 'v4', auth: await googleClient(['https://www.googleapis.com/auth/spreadsheets']) }));

const calendarClient = singleton(async () =>
  google.calendar({ version: 'v3', auth: await googleClient(['https://www.googleapis.com/auth/calendar.readonly']) }));

/* ─── Telegram helper ───────────────────────────────────────────── */
async function sendTelegram(chatId, txt) {
  if (!chatId || !txt) return;
  const CHUNK = 4000;
  for (let i = 0; i < txt.length; i += CHUNK) {
    await fetch(`${TELE_API}/sendMessage`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        chat_id: chatId,
        text   : escapeMd(txt.slice(i, i + CHUNK)),
        parse_mode: 'MarkdownV2'
      })
    }).catch(e => console.error('Telegram:', e.message));
  }
}

/* ─── OpenWeather ──────────────────────────────────────────────── */
async function cityCoords(city) {
  const k = `coords_${city}`; if (cache.has(k)) return cache.get(k);
  if (!OPENWEATHER_API_KEY) return null;
  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_API_KEY}`;
  const [d] = await fetch(url).then(r => r.json()).catch(() => []);
  if (!d) return null;
  const coords = { lat: d.lat, lon: d.lon };
  cache.set(k, coords, 86_400);                                // 24 h
  return coords;
}

async function weather() {
  const k = `weather_${CIUDAD_CLIMA}`; if (cache.has(k)) return cache.get(k);
  const coords = await cityCoords(CIUDAD_CLIMA);
  if (!coords) return 'Clima no disponible';
  const url  = `https://api.openweathermap.org/data/2.5/forecast?lat=${coords.lat}&lon=${coords.lon}&units=metric&lang=es&appid=${OPENWEATHER_API_KEY}`;
  const data = await fetch(url).then(r => r.json()).catch(() => null);
  if (!data) return 'Clima no disponible';
  const today = DateTime.local().toISODate();
  const hits  = data.list.filter(i => i.dt_txt.startsWith(today));
  if (!hits.length) return 'Pronóstico no disponible';
  const min  = Math.round(Math.min(...hits.map(i => i.main.temp_min)));
  const max  = Math.round(Math.max(...hits.map(i => i.main.temp_max)));
  const desc = hits[Math.floor(hits.length / 2)].weather[0].description;
  const out  = `📉 Mín: ${min}°C · 📈 Máx: ${max}°C · ${desc[0].toUpperCase()}${desc.slice(1)}`;
  cache.set(k, out, 10_800);                                    // 3 h
  return out;
}

/* ─── Sheets utils ─────────────────────────────────────────────── */
const col = async (s, c = 'A') =>
  sheetsClient().then(gs => gs.spreadsheets.values.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    range: `${s}!${c}:${c}`
  })).then(r => r.data.values?.flat() || []);

const append = async (s, row) =>
  sheetsClient().then(gs => gs.spreadsheets.values.append({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    range: `${s}!A1`,
    valueInputOption:'USER_ENTERED',
    resource:{ values:[row] }
  }));

const sheetId = singleton(async name => {
  const meta = await sheetsClient().then(gs => gs.spreadsheets.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    fields: 'sheets.properties'
  }));
  const found = meta.data.sheets.find(x => x.properties.title === name);
  if (!found) throw new Error(`Sheet ${name} no encontrado`);
  return found.properties.sheetId;
});

async function addUnique(sheet, text) {
  if ((await col(sheet)).some(v => v?.toLowerCase() === text.toLowerCase()))
    return `ℹ️ "${text}" ya existe en "${sheet}".`;
  await append(sheet, [text]);
  return `✅ Agregado a "${sheet}": ${text}`;
}

async function removeRow(sheet, text) {
  try {
    const values = await col(sheet);
    const idx = values.findIndex(v => v?.toLowerCase?.() === text.toLowerCase());
    if (idx === -1) return `ℹ️ No se encontró "${text}" en "${sheet}".`;

    const gs = await sheetsClient();
    await gs.spreadsheets.batchUpdate({
      spreadsheetId: DASHBOARD_SPREADSHEET_ID,
      requestBody: { requests: [{
        deleteDimension: { range: {
          sheetId : await sheetId(sheet),
          dimension: 'ROWS',
          startIndex: idx,
          endIndex  : idx + 1
        }}
      }] }
    });
    return `🗑️ Eliminado de "${sheet}": ${text}`;
  } catch (e) {
    console.error('removeRow:', e.message);
    return `❌ Error al eliminar en "${sheet}".`;
  }
}

/* Big Rocks */
const bigRocks = async () => {
  const k='bigR'; if(cache.has(k)) return cache.get(k);
  const list=(await col('BigRocks')).filter(Boolean).map(t=>'• '+t.trim());
  cache.set(k,list,120); return list;
};

/* Pendientes Top-5 */
async function pendientes() {
  const k='pend'; if(cache.has(k)) return cache.get(k);
  const rows = await sheetsClient().then(gs => gs.spreadsheets.values.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID, range: 'Pendientes!A2:G'
  })).then(r => r.data.values || []);

  const today = DateTime.local().startOf('day');
  const list  = rows.map(r => ({
    tarea : r[1] || '(sin descripción)',
    vence : r[2] ? DateTime.fromJSDate(new Date(r[2])) : null,
    estado: (r[4]||'').toLowerCase(),
    score : (Number(r[5])||2)*2 + (Number(r[6])||2)
  })).filter(p => !['done','discarded','waiting'].includes(p.estado))
    .map(p => ({ ...p, atras: p.vence && p.vence < today }))
    .sort((a,b)=> (b.atras-a.atras)||(b.score-a.score))
    .slice(0,5)
    .map(p => `${p.atras?'🔴':'•'} ${p.tarea}${p.vence?` (${p.vence.toFormat('dd-MMM')})`:''}`);

  cache.set(k,list,120);
  return list;
}

/* Agenda hoy (todos los calendarios) */
async function agenda() {
  const k='agenda'; if(cache.has(k)) return cache.get(k);
  const cal = await calendarClient();
  const tz  = 'America/Santiago';
  const now = DateTime.local().setZone(tz).startOf('day');
  const end = now.endOf('day');

  const metas   = await cal.calendarList.list();
  const events  = (await Promise.all(
      metas.data.items.map(c => cal.events.list({
        calendarId:c.id,timeMin:now.toISO(),timeMax:end.toISO(),
        singleEvents:true,orderBy:'startTime'
      }))
    )).flatMap(r=>r.data.items||[])
      .sort((a,b)=>new Date(a.start.dateTime||a.start.date)-new Date(b.start.dateTime||b.start.date))
      .filter(e=>!(e.summary||'').toLowerCase().includes('office'))
      .map(e=>`• ${e.start.dateTime?DateTime.fromISO(e.start.dateTime,{zone:tz}).toFormat('HH:mm'):'Todo el día'} – ${e.summary||'(sin título)'}`);

  cache.set(k,events,300);
  return events;
}

/* ─── Sincronizador de Agenda (opcional) ───────────────────────── */
async function addWorkAgendaToPersonalCalendar() {
  if (!AGENDA_SHEET_ID) return;
  const key='agenda_sync'; if(cache.has(key)) return;
  try{
    const sheets = await sheetsClient();
    const calendar = await calendarClient();
    const CALENDARIO_IMPORTADO = 'Agenda oficina (importada)';

    const calendars = await calendar.calendarList.list();
    let buf = calendars.data.items.find(c => c.summary === CALENDARIO_IMPORTADO);
    if (!buf) buf = (await calendar.calendars.insert({resource:{summary:CALENDARIO_IMPORTADO}})).data;

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId:AGENDA_SHEET_ID, range:'Hoja 1!A2:C'
    });
    const rows = res.data.values || [];
    const tz   = 'America/Santiago';
    const hoy  = DateTime.local().setZone(tz).startOf('day');
    const existentes = await calendar.events.list({
      calendarId: buf.id,timeMin:hoy.toISO(),timeMax:hoy.plus({days:1}).toISO(),singleEvents:true
    });
    const existing = new Set(existentes.data.items.map(e=>`${e.summary}@${e.start.dateTime}`));

    for(const [tit,inicioRaw,finRaw] of rows){
      if(!tit||!inicioRaw) continue;
      const inicio = DateTime.fromJSDate(new Date(inicioRaw),{zone:tz});
      const fin    = finRaw ? DateTime.fromJSDate(new Date(finRaw),{zone:tz}) : inicio.plus({minutes:30});
      const key = `${tit}@${inicio.toISO()}`;
      if(!existing.has(key) && !tit.toLowerCase().includes('office')){
        await calendar.events.insert({
          calendarId:buf.id,
          resource:{summary:tit,start:{dateTime:inicio.toISO(),timeZone:tz},end:{dateTime:fin.toISO(),timeZone:tz}}
        });
      }
    }
    cache.set(key,true,3600);                    // 1 h
  }catch(e){ console.error('agendaSync:',e.message); }
}

/* ─── GPT helper ────────────────────────────────────────────────── */
async function askGPT(prompt, tok=300, temp=0.6){
  if (!OPENAI_API_KEY) return '[OPENAI_API_KEY faltante]';
  const r = await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}` },
    body:JSON.stringify({ model:'gpt-4o-mini', messages:[{role:'user',content:prompt}], max_tokens:tok, temperature:temp })
  });
  if(!r.ok){ console.error('GPT:',r.statusText); return `[GPT error: ${r.statusText}]`; }
  return (await r.json()).choices?.[0]?.message?.content?.trim() || '[GPT vacío]';
}

/* ─── Intereses (Sheets) ───────────────────────────────────────── */
const getIntereses = async () => {
  const k='inter'; if(cache.has(k)) return cache.get(k);
  const list=(await col('Intereses')).slice(1).filter(Boolean).map(t=>t.trim());
  cache.set(k,list,600); return list;
};

/* ─── Radar de Inteligencia ─────────────────────────────────────── */
async function intelGlobal() {
  const k='intel'; if(cache.has(k)) return cache.get(k);

  const FEEDS = [
    // geopolitics
    'https://warontherocks.com/feed/','https://www.foreignaffairs.com/rss.xml',
    'https://www.cfr.org/rss.xml','https://carnegieendowment.org/rss/all-publications',
    'https://www.csis.org/rss/analysis','https://www.rand.org/pubs.rss',
    'https://globalvoices.org/feed/','https://thediplomat.com/feed/',
    'https://www.foreignpolicy.com/feed',
    // tech
    'https://www.wired.com/feed/rss','https://feeds.arstechnica.com/arstechnica/index',
    'https://www.theverge.com/rss/index.xml','http://feeds.feedburner.com/TechCrunch/',
    'https://www.technologyreview.com/feed/','https://restofworld.org/feed/latest/',
    'https://themarkup.org/feeds/rss.xml','https://www.schneier.com/feed/atom/',
    // spanish
    'https://feeds.weblogssl.com/xataka2','https://elordenmundial.com/feed/','https://es.globalvoices.org/feed/'
  ];

  const parser   = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:'@_' });
  const xmlTexts = (await Promise.all(FEEDS.map(fetchSafe))).filter(Boolean);
  if (!xmlTexts.length) return 'No se pudo acceder a los feeds de noticias hoy.';

  const items = xmlTexts.flatMap(x => {
    const f = parser.parse(x);
    return f.rss ? f.rss.channel.item : f.feed ? f.feed.entry : [];
  }).slice(0,60);

  const headlines = items.map((it,i)=>({
    id   : i+1,
    title: it.title,
    link : typeof it.link==='string'?it.link:it.link?.['@_href']
  }));

  const intereses = (await getIntereses()).join(', ') || 'geopolítica, tecnología';
  const prompt = `
👁️ Analista senior. Intereses: ${intereses}
FORMATO:
◼️ *<Categoría>*
» **Titular N°X** — 2-3 líneas
   • Oportunidad → …
   • Riesgo      → …
   • Implicancia para Chile → …
   • [Fuente X]

Escoge 4 titulares.
Titulares:
${headlines.map(h=>`${h.id}: ${h.title}`).join('\n')}
  `;

  let texto = await askGPT(prompt,700,0.7);
  headlines.forEach(h=>{
    texto = texto.replace(`[Fuente ${h.id}]`,`[Ver fuente](${h.link})`);
  });

  cache.set(k,texto,3600);
  return texto;
}

/* ─── Horóscopo ─────────────────────────────────────────────────── */
async function horoscopo() {
  const k='horo'; if(cache.has(k)) return cache.get(k);

  const fuentes = await Promise.allSettled([
    fetchSafe('https://aztro.sameerkumar.website/?sign=libra&day=today')
        .then(t=>t && JSON.parse(t).description),
    NINJAS_KEY
      ? fetch('https://api.api-ninjas.com/v1/horoscope?zodiac=libra',{headers:{'X-Api-Key':NINJAS_KEY}})
          .then(r=>r.json()).then(d=>d.horoscope).catch(()=>null)
      : null,
    askGPT('Horóscopo Libra global (3 líneas, español).',120,0.7),
    askGPT('Horóscopo Libra carrera/finanzas (3 líneas, español).',120,0.7),
    askGPT('Horóscopo Libra bienestar personal (3 líneas, español).',120,0.8)
  ]);

  const borradores = fuentes.filter(f=>f.status==='fulfilled'&&f.value)
                            .map(f=>f.value).join('\n\n');
  if (!borradores) return 'Horóscopo no disponible.';

  const prompt = `
Eres astrólogo maestro. Sintetiza los siguientes borradores en UN solo horóscopo (titular en negrita + 4-5 líneas), español:

${borradores}
  `;
  const final = await askGPT(prompt,250,0.6);
  cache.set(k,final,21_600);                                         // 6 h
  return final;
}

/* ─── Bonus Track ───────────────────────────────────────────────── */
async function bonusTrack() {
  const k='bonus'; if(cache.has(k)) return cache.get(k);

  const FEEDS = [
    // Filosofía + cultura
    'https://aeon.co/feed.rss','https://psyche.co/feed','https://www.noemamag.com/feed/',
    'https://longnow.org/ideas/feed/','https://www.the-tls.co.uk/feed/','https://laphamsquarterly.org/rss.xml',
    'https://www.nybooks.com/feed/','https://thepointmag.com/feed/','https://thebaffler.com/feed','https://quillette.com/feed/','https://palladiummag.com/feed/',
    // Ciencia & tecnología profunda
    'https://nautil.us/feed/','https://www.quantamagazine.org/feed/','https://www.technologyreview.com/feed/',
    'https://arstechnica.com/science/feed/','https://www.wired.com/feed/category/science/latest/rss','https://stratechery.com/feed/','https://knowingneurons.com/feed/',
    // Curiosidades intelectuales
    'https://longreads.com/feed/','https://getpocket.com/explore/rss','https://publicdomainreview.org/feed/',
    'https://daily.jstor.org/feed/','https://bigthink.com/feed/','https://sidebar.io/feed.xml',
    // Español
    'https://elgatoylacaja.com/feed/','https://ethic.es/feed/','https://principia.io/feed/','https://ctxt.es/es/rss.xml',
    'https://elpais.com/rss/cultura.xml','https://hipertextual.com/feed','https://www.bbvaopenmind.com/en/feed/'
  ];

  const parser  = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:'@_' });
  const xmlList = (await Promise.all(FEEDS.map(fetchSafe))).filter(Boolean);
  if (!xmlList.length) return 'No hay artículos disponibles hoy.';

  const items = xmlList.flatMap(xml=>{
    const f=parser.parse(xml);
    return f.rss?f.rss.channel.item:f.feed?f.feed.entry:[];
  }).filter(Boolean);

  // Durstenfeld shuffle
  for(let i=items.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [items[i],items[j]]=[items[j],items[i]];
  }

  const linkOk = async url=>{
    if(!url) return false;
    try{
      const ctrl=new AbortController();
      const id=setTimeout(()=>ctrl.abort(),2000);
      const r=await fetch(url,{method:'HEAD',signal:ctrl.signal});
      clearTimeout(id);
      return r.ok;
    }catch{return false;}
  };

  let pick;
  for(const it of items.slice(0,60)){
    const link = typeof it.link==='string'?it.link:it.link?.['@_href']||it.link?.['@_url'];
    if(await linkOk(link)){
      pick={title:it.title,link};
      break;
    }
  }
  if(!pick) return 'Hoy no se encontraron enlaces válidos.';

  const prompt=`
🔍 Ensayo: «${pick.title}».
1. Resume en 2-3 líneas su valor para un profesional ocupado.
2. Conéctalo con filosofía, ciencia o historia.
3. Cierra con una pregunta provocadora.
4. Termina con (leer).
  `;
  const txt=(await askGPT(prompt,200,0.75))
             .replace('(leer)',`(leer)(${pick.link})`);

  cache.set(k,txt,86_400);                                         // 24 h
  return txt;
}

/* ─── Briefs ────────────────────────────────────────────────────── */
async function briefShort() {
  const [clima, rock, ag, pend] = await Promise.all([
    weather(), bigRocks(), agenda(), pendientes()
  ]);

  return [
    '⚡️ *Resumen Rápido*',
    banner('Clima','🌦️'), clima,
    banner('Misión Principal','🚀'), rock.join('\n')||'_(No definido)_',
    banner('Focos Críticos','🔥'), pend.join('\n')||'_(Sin pendientes)_',
    banner('Agenda','📅'), ag.join('\n')||'_(Sin eventos)_'
  ].join('\n\n');
}

async function briefFull() {
  await addWorkAgendaToPersonalCalendar();          // opcional

  const [clima, ag, pend, rock, intel, horo, bonus] = await Promise.all([
    weather(), agenda(), pendientes(), bigRocks(), intelGlobal(), horoscopo(), bonusTrack()
  ]);

  const promptCoach = `
⚔️ Actúa como mi "Jefe de Gabinete" y coach estratégico. Formato:
1. **Foco Principal:** …
2. **Riesgo a Mitigar:** …
3. **Acción Clave:** …
4. **Métrica de Éxito:** El éxito hoy se medirá por: ___

Agenda:
${ag.join('\n')||'—'}

Pendientes:
${pend.join('\n')||'—'}

Big Rock:
${rock.join('\n')||'—'}
`;
  const analisis = await askGPT(promptCoach,350,0.7);

  return [
    '🗞️ *MORNING BRIEF ULTIMATE*',
    `> _${DateTime.local().setZone('America/Santiago').toFormat("cccc d 'de' LLLL yyyy")}_`,
    banner('Análisis Estratégico','🧠'), analisis,
    banner('Clima','🌦️'), clima,
    banner('Agenda','📅'), ag.join('\n')||'_(Sin eventos)_',
    banner('Pendientes','🔥'), pend.join('\n')||'_(Sin pendientes)_',
    banner('Big Rock','🚀'), rock.join('\n')||'_(No definido)_',
    banner('Radar de Inteligencia','🌍'), intel,
    banner('Horóscopo (Libra)','🔮'), horo,
    banner('Bonus Track','🎁'), bonus
  ].join('\n\n');
}

/* ─── Diagnóstico del sistema ──────────────────────────────────── */
async function getSystemStatus() {
  const checks = await Promise.allSettled([
    sheetsClient().then(()=> '✅ Google Sheets'),
    calendarClient().then(()=> '✅ Google Calendar'),
    askGPT('ping',1).then(()=> '✅ OpenAI').catch(()=> '❌ OpenAI'),
    weather().then(r=>r.includes('disponible')?'❌ OpenWeather':'✅ OpenWeather')
  ]);
  return `*Estado del Sistema*\n──────────────\n${checks.map(r=>r.value||r.reason).join('\n')}`;
}

/* ─── Comandos ─────────────────────────────────────────────────── */
async function router(msg) {
  const [cmd,...rest]=(msg.text||'').trim().split(' ');
  const arg=rest.join(' ').trim();

  switch(cmd){
    case '/start':
    case '/help':
      return '*JOYA* comandos:\n/brief\n/briefcompleto\n/status\n/addrock <t>\n/removerock <t>\n/addinteres <t>\n/removeinteres <t>';
    case '/brief':          return await briefShort();
    case '/briefcompleto':  return await briefFull();
    case '/status':         return await getSystemStatus();
    case '/addrock':        return arg ? await addUnique('BigRocks',arg)  : '✏️ Falta la tarea.';
    case '/removerock':     return arg ? await removeRow('BigRocks',arg)  : '✏️ Falta la tarea a eliminar.';
    case '/addinteres':     return arg ? await addUnique('Intereses',arg) : '✏️ Falta el interés.';
    case '/removeinteres':  return arg ? await removeRow('Intereses',arg) : '✏️ Falta el interés a eliminar.';
    default:                return '🤖 Comando desconocido. Usa /help';
  }
}

/* ─── Routes & Server ──────────────────────────────────────────── */
app.post(`/webhook/${TELEGRAM_SECRET}`, (req,res)=>{
  res.sendStatus(200);                               // ACK inmediato
  (async()=>{
    try{
      const msg=req.body.message;
      if(msg?.text){
        const reply = await router(msg);
        await sendTelegram(msg.chat.id, reply);
      }
    }catch(err){
      console.error('Async webhook:',err);
      if(ADMIN_CHAT_ID){
        await sendTelegram(ADMIN_CHAT_ID,
          `🔴 *Error JOYA*\n${err.message.substring(0,200)}`);
      }
    }
  })();
});

app.get('/healthz',(_,res)=>res.send('ok'));
app.listen(PORT,()=>console.log(`🚀 Joya Ultimate on ${PORT}`));
