/* ╔════════════════════════════════════════════════════════════════╗
 * ║                 ASISTENTE JOYA ULTIMATE · v2025               ║
 * ║   Telegram · Google Sheets · Calendar · OpenWeather · OpenAI  ║
 * ║        Node 18 (ESM) — preparado para Render PaaS             ║
 * ╚════════════════════════════════════════════════════════════════╝ */

import express                    from 'express';
import NodeCache                  from 'node-cache';
import { google }                 from 'googleapis';
import { DateTime }               from 'luxon';
import { XMLParser }              from 'fast-xml-parser';

/* ─── ENV ───────────────────────────────────────────────────────── */
const {
  PORT = 3000,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_SECRET,
  OPENWEATHER_API_KEY,
  OPENAI_API_KEY,
  NINJAS_KEY,
  CIUDAD_CLIMA             = 'Santiago,cl',
  DASHBOARD_SPREADSHEET_ID,
  GOOGLE_CREDENTIALS,
  GOOGLE_CREDENTIALS_B64
} = process.env;

if (!TELEGRAM_SECRET || !TELEGRAM_BOT_TOKEN)
  throw new Error('Faltan TELEGRAM_SECRET y/o TELEGRAM_BOT_TOKEN');

if (!DASHBOARD_SPREADSHEET_ID)
  console.warn('⚠️  DASHBOARD_SPREADSHEET_ID no definido — funciones de Sheets fallarán');

/* ─── Express & caché ───────────────────────────────────────────── */
const app   = express();
app.use(express.json({ limit: '1mb' }));
const cache = new NodeCache({ stdTTL: 300 });          // 5 min
const TELE_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const banner   = (t, e) => `\n${e} *${t}*\n──────────────`;
const escapeMd = s => (s || '').replace(/([\\_*[\]()~`>#+\-=|{}.!])/g, '\\$1');

/* ─── Google Auth (singletons) ──────────────────────────────────── */
const singleton = fn => { let i; return (...a) => i ?? (i = fn(...a)); };

const googleClient = singleton(async (scopes) => {
  const raw = GOOGLE_CREDENTIALS ||
              (GOOGLE_CREDENTIALS_B64 &&
              Buffer.from(GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8'));
  if (!raw) throw new Error('GOOGLE_CREDENTIALS(_B64) faltante');
  return new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes }).getClient();
});

const sheetsClient   = singleton(async () => google.sheets  ({ version: 'v4', auth: await googleClient(['https://www.googleapis.com/auth/spreadsheets']) }));
const calendarClient = singleton(async () => google.calendar({ version: 'v3', auth: await googleClient(['https://www.googleapis.com/auth/calendar.readonly']) }));

/* ─── Telegram helper ───────────────────────────────────────────── */
async function sendTelegram(chatId, txt) {
  if (!chatId || !txt) return;
  const CHUNK = 4000;
  for (let i = 0; i < txt.length; i += CHUNK) {
    await fetch(`${TELE_API}/sendMessage`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id: chatId, text: escapeMd(txt.slice(i, i + CHUNK)), parse_mode: 'MarkdownV2' })
    }).catch(e => console.error('Telegram:', e.message));
  }
}

/* ─── OpenWeather: clima min/max de hoy ─────────────────────────── */
async function cityCoords(city) {
  const k = `coords_${city}`; if (cache.has(k)) return cache.get(k);
  if (!OPENWEATHER_API_KEY) return null;
  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_API_KEY}`;
  const [d] = await fetch(url).then(r => r.json()).catch(() => []);
  if (!d) return null;
  const coords = { lat: d.lat, lon: d.lon };
  cache.set(k, coords, 86400);                    // 24 h
  return coords;
}

async function weather() {
  const k = `weather_${CIUDAD_CLIMA}`; if (cache.has(k)) return cache.get(k);
  const coords = await cityCoords(CIUDAD_CLIMA);  if (!coords) return 'Clima no disponible';
  const url  = `https://api.openweathermap.org/data/2.5/forecast?lat=${coords.lat}&lon=${coords.lon}&units=metric&lang=es&appid=${OPENWEATHER_API_KEY}`;
  const data = await fetch(url).then(r => r.json()).catch(() => null); if (!data) return 'Clima no disponible';
  const today  = DateTime.local().toISODate();
  const hits   = data.list.filter(i => i.dt_txt.startsWith(today)); if (!hits.length) return 'Pronóstico no disponible';
  const min    = Math.round(Math.min(...hits.map(i => i.main.temp_min)));
  const max    = Math.round(Math.max(...hits.map(i => i.main.temp_max)));
  const desc   = hits[Math.floor(hits.length / 2)].weather[0].description;
  const out    = `📉 Mín: ${min}°C · 📈 Máx: ${max}°C · ${desc[0].toUpperCase()}${desc.slice(1)}`;
  cache.set(k, out, 10800);                       // 3 h
  return out;
}

/* ─── Sheets util ───────────────────────────────────────────────── */
const col = async (s, c='A') =>
  await sheetsClient().then(gs => gs.spreadsheets.values.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID, range: `${s}!${c}:${c}`
  })).then(r => r.data.values?.flat() || []);

const append = async (s, row) =>
  await sheetsClient().then(gs => gs.spreadsheets.values.append({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID, range: `${s}!A1`,
    valueInputOption:'USER_ENTERED', resource:{ values:[row] }
}));

const sheetId = singleton(async (name) => {
  const meta = await sheetsClient().then(gs => gs.spreadsheets.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID, fields: 'sheets.properties'
  }));
  const found = meta.data.sheets.find(x => x.properties.title === name);
  if (!found) throw new Error(`Sheet ${name} no encontrado`);
  return found.properties.sheetId;
});

async function addUnique(sheet, text) {
  if ((await col(sheet)).some(v => v?.toLowerCase() === text.toLowerCase()))
    return `ℹ️ \"${text}\" ya existe en \"${sheet}\".`;
  await append(sheet, [text]); return `✅ Agregado a \"${sheet}\": ${text}`;
}

async function removeRow(sheet, text) {
  try {
    const c = await col(sheet);
    const idx = c.findIndex(v => v?.toLowerCase?.() === text.toLowerCase());

    if (idx === -1) {
      return `ℹ️ No se encontró "${text}" en "${sheet}".`;
    }

    // --- LA CORRECCIÓN ESTÁ AQUÍ ---
    // 1. Obtenemos el cliente y el ID de la hoja ANTES de construir el objeto de la petición.
    const gs = await sheetsClient();
    const idDeLaHoja = await sheetId(sheet);

    // 2. Ahora construimos el objeto usando la variable, sin 'await' adentro.
    await gs.spreadsheets.batchUpdate({
      spreadsheetId: DASHBOARD_SPREADSHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: idDeLaHoja, // <-- Usamos la variable
              dimension: 'ROWS',
              startIndex: idx,
              endIndex: idx + 1
            }
          }
        }]
      }
    });

    return `🗑️ Eliminado de "${sheet}": ${text}`;
  } catch (e) {
    console.error(`Error en removeRow para "${sheet}":`, e.message);
    return `❌ Error al intentar eliminar de "${sheet}".`;
  }
}

/* Big Rocks */
const bigRocks = async () => { const k='bigR'; if(cache.has(k)) return cache.get(k); const list=(await col('BigRocks')).filter(Boolean).map(t=>'• '+t.trim()); cache.set(k,list,120); return list; };

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
  cache.set(k,list,120); return list;
}

/* Agenda hoy (todos los calendarios) */
async function agenda() {
  const k='agenda'; if(cache.has(k)) return cache.get(k);
  const cal = await calendarClient();
  const tz  = 'America/Santiago';
  const now = DateTime.local().setZone(tz);
  const end = now.endOf('day');

  const metas    = await cal.calendarList.list();
  const events   = (await Promise.all(
      metas.data.items.map(c => cal.events.list({
        calendarId:c.id,timeMin:now.toISO(),timeMax:end.toISO(),
        singleEvents:true,orderBy:'startTime'
      }))
    )).flatMap(r=>r.data.items||[])
      .sort((a,b)=>new Date(a.start.dateTime||a.start.date)-new Date(b.start.dateTime||b.start.date))
      .filter(e=>!(e.summary||'').toLowerCase().includes('office'))
      .map(e=>`• ${e.start.dateTime?DateTime.fromISO(e.start.dateTime,{zone:tz}).toFormat('HH:mm'):'Todo el día'} – ${e.summary||'(sin título)'}`);

  cache.set(k,events,300); return events;
}

/* ─── GPT helper ─────────────────────────────────────────────────── */
async function askGPT(prompt, tok = 300, temp = 0.6) {
  if (!OPENAI_API_KEY) return '[OPENAI_API_KEY faltante]';
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method : 'POST',
    headers: { 'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}` },
    body   : JSON.stringify({ model:'gpt-4o-mini', messages:[{role:'user',content:prompt}], max_tokens:tok, temperature:temp })
  });
  if (!r.ok) { console.error('GPT:', r.statusText); return `[GPT error: ${r.statusText}]`; }
  return (await r.json()).choices?.[0]?.message?.content?.trim() || '[GPT vacío]';
}

/* ─── Intereses & Radar de Inteligencia ─────────────────────────── */
const getIntereses = async () => { const k='inter'; if(cache.has(k)) return cache.get(k); const list=(await col('Intereses')).slice(1).filter(Boolean).map(t=>t.trim()); cache.set(k,list,600); return list; };

async function intelGlobal() {
  const k='intel'; if(cache.has(k)) return cache.get(k);

  /* 1.  leer feeds */
  const FEEDS = [
    // === GEOPOLÍTICA Y RELACIONES INTERNACIONALES (NÚCLEO) ===
    'https://warontherocks.com/feed/',          // War on the Rocks
    'https://www.foreignaffairs.com/rss.xml',   // Foreign Affairs
    'https://www.cfr.org/rss.xml',              // Council on Foreign Relations
    'https://carnegieendowment.org/rss/all-publications', // Carnegie Endowment
    'https://www.csis.org/rss/analysis',        // CSIS
    'https://www.rand.org/pubs.rss',            // RAND Corporation
    'https://www.brookings.edu/feed/',          // Brookings Institution
    'https://globalvoices.org/feed/',           // Global Voices
    'https://thediplomat.com/feed/',            // The Diplomat (Asia-Pacific)
    'https://www.foreignpolicy.com/feed',      // Foreign Policy

    // === TECNOLOGÍA Y CIBERSEGURIDAD ===
    'https://www.wired.com/feed/rss',
    'https://feeds.arstechnica.com/arstechnica/index',
    'https://www.theverge.com/rss/index.xml',
    'http://feeds.feedburner.com/TechCrunch/',
    'https://www.technologyreview.com/feed/',
    'https://restofworld.org/feed/latest/',
    'https://themarkup.org/feeds/rss.xml',
    'https://www.schneier.com/feed/atom/',       // Schneier on Security
    'https://krebsonsecurity.com/feed/',        // Krebs on Security
    'https://thehackernews.com/feeds/posts/default', // The Hacker News
    'https://darknetdiaries.com/podcast.xml',   // Darknet Diaries (Podcast)

    // === NEGOCIOS Y ESTRATEGIA ===
    'https://stratechery.com/feed/',            // Stratechery by Ben Thompson
    'https://hbr.org/rss',                      // Harvard Business Review
    'https://www.ben-evans.com/rss',            // Benedict Evans

    // === CIENCIA Y FUTURO ===
    'https://nautil.us/feed/',                  // Nautilus
    'https://www.quantamagazine.org/feed/',     // Quanta Magazine
    'https://singularityhub.com/feed/',          // Singularity Hub

    // === NOTICIAS GLOBALES (AGENCIAS Y MEDIOS PRINCIPALES) ===
    'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', // New York Times - World
    'https://feeds.bbci.co.uk/news/world/rss.xml', // BBC News - World
    'https://www.theguardian.com/world/rss',    // The Guardian - World
    'https://www.reuters.com/tools/rss',        // Reuters - Top News
    'https://www.economist.com/rss',            // The Economist
    'https://www.theatlantic.com/feed/all/',    // The Atlantic
    'https://www.aljazeera.com/xml/rss/all.xml', // Al Jazeera

    // === ECONOMÍA Y FINANZAS ===
    'https://www.ft.com/?format=rss',           // Financial Times
    'https://feeds.a.dj.com/rss/RSSWorldNews.xml', // Wall Street Journal - World News
    'https://www.bloomberg.com/opinion/authors/A_1iP-c2o8I/matthew-a-levine.rss', // Matt Levine's Money Stuff

    // === REDDIT (PULSO DE LA COMUNIDAD) ===
    'https://www.reddit.com/r/worldnews/.rss',
    'https://www.reddit.com/r/geopolitics/.rss',
    'https://www.reddit.com/r/technology/.rss',
    'https://www.reddit.com/r/cybersecurity/.rss',
    'https://www.reddit.com/r/Futurology/.rss',
    
    // === EN ESPAÑOL (ANÁLISIS) ===
    'https://feeds.weblogssl.com/xataka2',      // Xataka
    'https://elordenmundial.com/feed/',         // El Orden Mundial
    'https://es.globalvoices.org/feed/',         // Global Voices en Español
    ];
  const parser   = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:'@_' });
  const xmlTexts = (await Promise.allSettled(
      FEEDS.map(u => fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.text()))
    )).filter(r => r.status === 'fulfilled').map(r => r.value);

  const items = xmlTexts.flatMap(x => {
    const f = parser.parse(x);
    return f.rss ? f.rss.channel.item : f.feed ? f.feed.entry : [];
  }).slice(0,40);

  const heads = items.map((it,i)=>({
    id   : i+1,
    title: it.title,
    link : typeof it.link==='string'?it.link:it.link?.['@_href']
  }));

  /* 2.  prompt IA mejorado */
  const intereses = (await getIntereses()).join(', ') || 'geopolítica y tecnología';
  const promptIntel = `
👁️ Eres un analista senior de inteligencia para un alto ejecutivo.
• Intereses clave: ${intereses}
• Idioma: ESPAÑOL.
• FORMATO:

◼️ *<Categoría>*  
» **Titular N°X** — (2-3 líneas de impacto)  
   • Oportunidad → …  
   • Riesgo      → …  
   • Implicancia para **Chile** → …  
   • [Fuente X]

Escoge **4** titulares de la lista.  Brevedad incisiva, sin introducción ni conclusión.

Titulares:
${heads.map(h=>`${h.id}: ${h.title}`).join('\n')}
`;

  let txt = await askGPT(promptIntel, 700, 0.7);
  heads.forEach(h => { txt = txt.replace(`[Fuente ${h.id}]`, `[Ver fuente](${h.link})`); });

  cache.set(k,txt,3600);
  return txt;
}

/* ─── Horóscopo mega-fusion ─────────────────────────────────────── */
async function horoscopo() {
  const k='horosc'; if(cache.has(k)) return cache.get(k);

  const fuentes = await Promise.allSettled([
    fetch('https://aztro.sameerkumar.website/?sign=libra&day=today',{method:'POST'}).then(r=>r.json()).then(d=>d.description).catch(()=>null),
    (async()=>{ if(!NINJAS_KEY) return null; try{ const d=await fetch('https://api.api-ninjas.com/v1/horoscope?zodiac=libra',{headers:{'X-Api-Key':NINJAS_KEY}}).then(r=>r.json()); return d.horoscope; }catch{return null;} })(),
    askGPT('Horóscopo Libra global (3 líneas, español).',120,0.7),
    askGPT('Horóscopo Libra carrera/finanzas (3 líneas, español).',120,0.7),
    askGPT('Horóscopo Libra bienestar personal (3 líneas, español).',120,0.8)
  ]);

  const borradores = fuentes.filter(f=>f.status==='fulfilled'&&f.value).map(f=>f.value).join('\n\n');
  const prompt = `
Eres astrólogo maestro. Sintetiza los siguientes borradores en UN solo horóscopo unificado (4-5 líneas) en español.  
Incluye primero un titular en negrita. Luego el mensaje.  
Borradores:  
${borradores}
  `;
  const final = await askGPT(prompt,250,0.6);
  cache.set(k,final,21600);      // 6 h
  return final;
}

/* ─── Bonus Track ───────────────────────────────────────────────── */
async function bonusTrack() {
  const k='bonus'; if(cache.has(k)) return cache.get(k);

  const FEEDS = [
    // === Filosofía, Cultura y Ensayos (Similares a Aeon) ===
    'https://aeon.co/feed.rss',
    'https://psyche.co/feed',
    'https://www.noemamag.com/feed/',
    'https://longnow.org/ideas/feed/',
    'https://www.the-tls.co.uk/feed/', // The Times Literary Supplement
    'https://laphamsquarterly.org/rss.xml', // Lapham's Quarterly
    'https://www.nybooks.com/feed/', // The New York Review of Books
    'https://thepointmag.com/feed/', // The Point Magazine
    'https://thebaffler.com/feed', // The Baffler
    'https://quillette.com/feed/',
    'https://palladiummag.com/feed/',

    // === Ciencia y Tecnología (Profundo) ===
    'https://nautil.us/feed/', // Nautilus
    'https://www.quantamagazine.org/feed/', // Quanta Magazine
    'https://www.technologyreview.com/feed/', // MIT Technology Review
    'https://arstechnica.com/science/feed/', // Ars Technica (Science Section)
    'https://www.wired.com/feed/category/science/latest/rss', // WIRED (Science)
    'https://stratechery.com/feed/', // Stratechery by Ben Thompson (Tech Analysis)
    'https://knowingneurons.com/feed/', // Neuroscience

    // === Curiosidades Intelectuales y Cultura General ===
    'https://longreads.com/feed/', // Longreads
    'https://getpocket.com/explore/rss', // Pocket's "Must-Reads"
    'https://publicdomainreview.org/feed/', // The Public Domain Review
    'https://daily.jstor.org/feed/', // JSTOR Daily
    'https://bigthink.com/feed/',
    'https://sidebar.io/feed.xml', // 5 mejores artículos de diseño y tecnología del día

    // === En Español de Alta Calidad ===
    'https://elgatoylacaja.com/feed/',
    'https://www.agenciassinc.es/rss', // Agencia SINC (Ciencia)
    'https://ethic.es/feed/',
    'https://principia.io/feed/',
    'https://ctxt.es/es/rss.xml' // CTXT

  ];
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:'@_' });
  const xmls   = await Promise.all(FEEDS.map(u=>fetch(u).then(r=>r.text())));
  const items  = xmls.flatMap(x=>{ const f=parser.parse(x); return f.rss?f.rss.channel.item:f.feed?f.feed.entry:[]; });
  const pick   = items[Math.floor(Math.random()*Math.min(items.length,15))];
  const art    = { title: pick.title, link: typeof pick.link==='string'?pick.link:pick.link?.['@_href'] };

  const promptBonus = `
🔍 Ensayo detectado: «${art.title}».

1. Resume en 2-3 líneas su valor para un profesional ocupado.  
2. Relaciónalo con un interés extralaboral (filosofía/ciencia/historia).  
3. Termina con una pregunta provocadora.  
4. Cierra con (leer).

¡Redacta!`;
  const txt = await askGPT(promptBonus,200,0.75)
                 .replace('(leer)', `(leer)(${art.link})`);
  cache.set(k,txt,86400);        // 24 h
  return txt;
}

/* ─── Briefs ────────────────────────────────────────────────────── */
async function briefShort() {
  const [cl, rock, ag] = await Promise.all([weather(), bigRocks(), agenda()]);
  return [
    '⚡️ *Resumen rápido*',
    banner('Clima','🌦'), cl,
    banner('Big Rock','🚀'), rock.join('\n')||'_(No definido)_',
    banner('Agenda','📅'), ag.join('\n')||'_(Sin eventos)_'
  ].join('\n');
}

async function briefFull() {
  const [cl, ag, pend, rock, intel, horo, bonus] = await Promise.all([
    weather(), agenda(), pendientes(), bigRocks(), intelGlobal(), horoscopo(), bonusTrack()
  ]);

  /* — Análisis Estratégico del Día — */
  const promptCoach = `
⚔️ Actúa como un estratega militar con disciplina de monje estoico.
Responde en español con **exactamente tres viñetas**:
1️⃣ Foco Principal  
2️⃣ Riesgo a Mitigar  
3️⃣ Acción Clave  
Luego añade: «El éxito hoy se medirá por: ____».

Agenda:\n${ag.join('\n')||'—'}\n
Pendientes:\n${pend.join('\n')||'—'}\n
Big Rock:\n${rock.join('\n')||'—'}`;
  const analisis = await askGPT(promptCoach,250,0.65);

  return [
    '🗞️ *MORNING BRIEF JOYA ULTIMATE*',
    `> _${DateTime.local().setZone('America/Santiago').toFormat("cccc d 'de' LLLL yyyy")}_`,
    banner('Análisis Estratégico','🧠'), analisis,
    banner('Clima','🌦'), cl,
    banner('Agenda','📅'), ag.join('\n')||'_(Sin eventos)_',
    banner('Pendientes','🔥'), pend.join('\n')||'_(Sin pendientes)_',
    banner('Big Rock','🚀'), rock.join('\n')||'_(No definido)_',
    banner('Radar Inteligencia','🌍'), intel,
    banner('Horóscopo (Libra)','🔮'), horo,
    banner('Bonus Track','🎁'), bonus
  ].join('\n\n');
}

/* ─── Command Router ───────────────────────────────────────────── */
async function router(msg){
  const [cmd,...rest]=(msg.text||'').trim().split(' ');
  const arg=rest.join(' ').trim();
  switch(cmd){
    case '/start':
    case '/help':
      return '*JOYA* comandos:\n/brief /briefcompleto\n/addrock <t> /removerock <t>\n/addinteres <t> /removeinteres <t>';
    case '/brief':         return await briefShort();
    case '/briefcompleto': return await briefFull();
    case '/addrock':       return arg?await addUnique('BigRocks',arg):'✏️ Falta texto';
    case '/removerock':    return arg?await removeRow('BigRocks',arg):'✏️ Falta texto';
    case '/addinteres':    return arg?await addUnique('Intereses',arg):'✏️ Falta texto';
    case '/removeinteres': return arg?await removeRow('Intereses',arg):'✏️ Falta texto';
    default:               return '🤖 Comando desconocido. /help';
  }
}

/* ─── Routes & Server ──────────────────────────────────────────── */
app.post(`/webhook/${TELEGRAM_SECRET}`, async (req,res)=>{
  try{
    if(req.body.message?.text){
      await sendTelegram(req.body.message.chat.id, await router(req.body.message));
    }
    res.sendStatus(200);
  }catch(e){ console.error('Webhook:',e); res.sendStatus(500);}
});

app.get('/healthz',(_,res)=>res.send('ok'));

app.listen(PORT,()=>console.log(`🚀 Joya Ultimate corriendo en ${PORT}`));
