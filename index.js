// ==================================================================
// ASISTENTE JOYA ULTIMATE – VERSIÓN CONSOLIDADA PARA RENDER (Node 18)
// Integración completa: Google Sheets + Calendar, OpenWeather, Telegram
// Cumple recomendaciones de seguridad, caché, Markdown >4 kB y Singleton
// ==================================================================
import express from 'express';
import fetchOrig, { Headers, Request, Response } from 'node-fetch';
import NodeCache from 'node-cache';
import { google } from 'googleapis';
import { DateTime } from 'luxon';

// --- Polyfill global fetch (node‑fetch v3 no la expone) -------------
globalThis.fetch   = fetchOrig;
globalThis.Headers = Headers;
globalThis.Request = Request;
globalThis.Response= Response;

// ---------------- ENV & CONSTANTES ----------------------------------
const {
  PORT = 3000,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_SECRET = 'hook',            // añade valor random en Render para endurecer endpoint
  OPENAI_API_KEY,                      // ← para próximas features IA
  OPENWEATHER_API_KEY,
  CIUDAD_CLIMA = 'Santiago,cl',
  DASHBOARD_SPREADSHEET_ID,
  GOOGLE_CREDENTIALS,                  // JSON plano
  GOOGLE_CREDENTIALS_B64               // alternativa Base‑64 (recomendada)
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error('❌ Falta TELEGRAM_BOT_TOKEN');
if (!DASHBOARD_SPREADSHEET_ID) console.warn('⚠️  Falta DASHBOARD_SPREADSHEET_ID – algunas funciones fallarán');

// ------------- Express & caché en memoria ---------------------------
const app   = express();
app.use(express.json({ limit: '1mb' }));
const cache = new NodeCache({ stdTTL: 300 });          // 5 min por defecto
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const banner = (title, emoji) => `\n${emoji} *${title}*\n──────────────`;

// ===================================================================
// 1.  Google Auth SINGLETON  (sheets & calendar comparten cliente)
// ===================================================================
function makeSingleton(fn){ let inst; return async(...a)=> inst ?? (inst = await fn(...a)); }

const googleClient = makeSingleton(async scopes => {
  const rawCreds = GOOGLE_CREDENTIALS || (GOOGLE_CREDENTIALS_B64
                    ? Buffer.from(GOOGLE_CREDENTIALS_B64,'base64').toString('utf8')
                    : null);
  if(!rawCreds) throw new Error('❌ Falta GOOGLE_CREDENTIALS(_B64)');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(rawCreds),
    scopes
  });
  return auth.getClient();
});

export const sheetsClient = makeSingleton(async () =>
  google.sheets({ version:'v4', auth: await googleClient(['https://www.googleapis.com/auth/spreadsheets']) }));

export const calendarClient = makeSingleton(async () =>
  google.calendar({ version:'v3', auth: await googleClient(['https://www.googleapis.com/auth/calendar.readonly']) }));

// ===================================================================
// 2.  Utilidades varias
// ===================================================================
function escapeMdV2(str){return str.replace(/([\\_*[\]()~`>#+\-=|{}.!])/g,'\\$1');}

async function telegramSend(chatId, raw){
  const CHUNK = 4000;                   // margen de seguridad
  for(let i=0;i<raw.length;i+=CHUNK){
    const part = raw.slice(i,i+CHUNK);
    await fetch(`${TELEGRAM_API}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        chat_id: chatId,
        text: escapeMdV2(part),
        parse_mode:'MarkdownV2'
      })
    }).catch(e=>console.error('Telegram error:',e.message));
  }
}

// ===================================================================
// 3.  CLIMA  –  pronóstico min/max del día
// ===================================================================
async function getCityCoords(city){
  const key=`coords_${city}`;
  if(cache.has(key)) return cache.get(key);
  if(!OPENWEATHER_API_KEY) return null;
  const url=`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_API_KEY}`;
  const [data] = await fetch(url).then(r=>r.json());
  if(data){
    cache.set(key,{lat:data.lat,lon:data.lon},86400);   // 24 h
    return {lat:data.lat,lon:data.lon};
  }
  return null;
}

async function getWeatherForecast(){
  const key=`forecast_${CIUDAD_CLIMA}`;
  if(cache.has(key)) return cache.get(key);
  if(!OPENWEATHER_API_KEY) return 'Clima no disponible';
  const coords = await getCityCoords(CIUDAD_CLIMA);
  if(!coords) return 'Clima no disponible';
  const url=`https://api.openweathermap.org/data/2.5/forecast?lat=${coords.lat}&lon=${coords.lon}&units=metric&lang=es&appid=${OPENWEATHER_API_KEY}`;
  const data=await fetch(url).then(r=>r.json());
  const today = DateTime.local().toISODate();
  const todayItems = data.list.filter(i=>i.dt_txt.startsWith(today));
  if(!todayItems.length) return 'Pronóstico no disponible';
  const min = Math.round(Math.min(...todayItems.map(i=>i.main.temp_min)));
  const max = Math.round(Math.max(...todayItems.map(i=>i.main.temp_max)));
  const desc= todayItems[Math.floor(todayItems.length/2)].weather[0].description;
  const out = `📉 Mín: ${min}°C · 📈 Máx: ${max}°C · ${desc.charAt(0).toUpperCase()+desc.slice(1)}`;
  cache.set(key,out,10800); // 3 h
  return out;
}

// ===================================================================
// 4.  BIG ROCKS & PENDIENTES  (Sheets)
// ===================================================================
async function readColumn(sheet, col='A'){
  const sh = await sheetsClient();
  const res = await sh.spreadsheets.values.get({spreadsheetId: DASHBOARD_SPREADSHEET_ID, range: `${sheet}!${col}:${col}`});
  return res.data.values?.flat()||[];
}

async function appendRow(sheet, values){
  const sh = await sheetsClient();
  await sh.spreadsheets.values.append({spreadsheetId: DASHBOARD_SPREADSHEET_ID, range:`${sheet}!A1`, valueInputOption:'USER_ENTERED', resource:{values:[values]}});
}

export async function agregarFilaSinDuplicar(sheet, texto){
  const vals = (await readColumn(sheet)).map(v=>v.toLowerCase());
  if(vals.includes(texto.toLowerCase())) return `ℹ️ "${texto}" ya existe en "${sheet}".`;
  await appendRow(sheet,[texto]);
  return `✅ Agregado a "${sheet}": ${texto}`;
}

async function getSheetId(sheet){
  const sh = await sheetsClient();
  const meta = await sh.spreadsheets.get({spreadsheetId: DASHBOARD_SPREADSHEET_ID, fields:'sheets.properties'});
  const obj= meta.data.sheets.find(s=>s.properties.title===sheet);
  if(!obj) throw new Error(`Sheet ${sheet} no encontrado`);
  return obj.properties.sheetId;
}

export async function removerFilaSiExiste(sheet, texto){
  const col = await readColumn(sheet);
  const idx = col.findIndex(v=>v?.toLowerCase?.()===texto.toLowerCase());
  if(idx===-1) return `ℹ️ "${texto}" no estaba en "${sheet}".`;
  const sh = await sheetsClient();
  await sh.spreadsheets.batchUpdate({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    requestBody:{requests:[{deleteDimension:{range:{sheetId: await getSheetId(sheet), dimension:'ROWS', startIndex:idx, endIndex:idx+1}}}]}
  });
  return `🗑 Eliminado de "${sheet}": ${texto}`;
}

async function getBigRock(){
  const key='bigrock'; if(cache.has(key)) return cache.get(key);
  const list=(await readColumn('BigRocks')).slice(1).filter(Boolean).map(t=>'• '+t.trim());
  cache.set(key,list,120); return list;
}

function scoreRow(imp,urg){return (Number(imp)||2)*2+(Number(urg)||2);}  // mismo criterio GAS

async function getPendientesClave(){
  const key='pendientes'; if(cache.has(key)) return cache.get(key);
  try{
    const sh = await sheetsClient();
    const res = await sh.spreadsheets.values.get({spreadsheetId: DASHBOARD_SPREADSHEET_ID, range:'Pendientes!A1:E'});
    const rows = res.data.values||[]; if(rows.length<=1) return [];
    const head= rows[0].map(h=>h.toLowerCase());
    const idx = {t:head.indexOf('tarea'), v:head.indexOf('vence'), s:head.indexOf('estado'), i:head.indexOf('impacto'), u:head.indexOf('urgencia')};
    const today = DateTime.local().startOf('day');
    const lista=[];
    rows.slice(1).forEach(r=>{
      const estado =(r[idx.s]||'').toLowerCase();
      if(['done','discarded','waiting'].includes(estado)) return;
      const vence  = r[idx.v]? DateTime.fromISO(r[idx.v]):null;
      lista.push({
        tarea:r[idx.t]||'(sin descripción)',
        vence,
        atras: vence && vence < today,
        score: scoreRow(r[idx.i],r[idx.u])
      });
    });
    lista.sort((a,b)=> a.atras!==b.atras ? (a.atras?-1:1) : b.score-a.score);
    const out = lista.slice(0,5).map(p=>{
      const fecha = p.vence? p.vence.toFormat('dd-MMM') : '';
      return `${p.atras?'⚠️':'•'} ${p.tarea}${fecha?' ('+fecha+')':''}`;});
    cache.set(key,out,120);
    return out;
  }catch(e){ console.error('Pendientes:',e.message); return ['(error pendientes)']; }
}

// ===================================================================
// 5.  AGENDA       (Calendar API v3 + Luxon)
// ===================================================================
async function getAgenda(){
  const key='agenda'; if(cache.has(key)) return cache.get(key);
  try{
    const cal = await calendarClient();
    const tz  = 'America/Santiago';
    const now = DateTime.local().setZone(tz);
    const end = now.endOf('day');
    const res = await cal.events.list({calendarId:'primary',timeMin:now.toISO(),timeMax:end.toISO(),singleEvents:true,orderBy:'startTime'});
    const ban  = ['office'];
    const list = (res.data.items||[])
        .filter(e=>!ban.some(b=> (e.summary||'').toLowerCase().includes(b)))
        .map(e=>{
          const hora = e.start.dateTime? DateTime.fromISO(e.start.dateTime,{zone:tz}).toFormat('HH:mm'):'Todo el día';
          return `• ${hora} – ${e.summary||'(sin título)'}`;});
    cache.set(key,list,300);
    return list;
  }catch(e){ console.error('Agenda:',e.message); return ['(Error agenda)']; }
}

// ===================================================================
// 6.  BRIEFS
// ===================================================================
async function getBriefCorto(){
  const [clima, bigrock, agenda] = await Promise.all([
    getWeatherForecast(),
    getBigRock(),
    getAgenda()
  ]);
  return [
    '⚡️ *Resumen rápido*',
    banner('Clima', '🌦'),
    clima,
    banner('Big Rock', '🚀'),
    bigrock.length?bigrock.join('\n'):'_(No definido)_',
    banner('Agenda', '📅'),
    agenda.length?agenda.join('\n'):'_(Sin eventos)_'
  ].join('\n');
}

async function generateMorningBriefString(){
  const [clima, agenda, pendientes, bigrock] = await Promise.all([
    getWeatherForecast(), getAgenda(), getPendientesClave(), getBigRock()
  ]);
  const subtitulo = '“Actúa, no esperes.”'; // placeholder IA
  const titulares = ['• (Titulares IA próximamente)'];
  const horoscopo = 'Libra: día para la acción.'; // stub
  const bonus     = 'Lectura: "How to sharpen pencils"';

  return [
    '🗞️ *MORNING BRIEF JOYA ULTIMATE*',
    `_${subtitulo}_`,
    banner(`Clima en ${CIUDAD_CLIMA.split(',')[0]}`,'🌦'),
    clima,
    banner('Agenda del Día','📅'),
    agenda.length?agenda.join('\n'):'_(Sin eventos)_',
    banner('Pendientes Clave','🔥'),
    pendientes.length?pendientes.join('\n'):'_(Sin pendientes)_',
    banner('Big Rock','🚀'),
    bigrock.length?bigrock.map(t=>'▫️ '+t.replace('• ','')).join('\n'):'_(No definido)_',
    banner('Inteligencia Global','🌍'),
    titulares.join('\n'),
    banner('Horóscopo (Libra)','🔮'),
    horoscopo,
    banner('Bonus Track','🎁'),
    bonus
  ].join('\n');
}

// ===================================================================
// 7.  MANEJADOR DE COMANDOS
// ===================================================================
async function manejarComando(msg){
  const text = (msg.text||'').trim();
  const [cmd,...rest] = text.split(' ');
  const arg = rest.join(' ').trim();
  switch(cmd){
    case '/start':
    case '/help':
      return '*Asistente JOYA* – comandos:\n/brief – Resumen rápido\n/briefcompleto – Brief completo\n/addrock <texto>\n/removerock <texto>\n/addinteres <texto>\n/removeinteres <texto>';
    case '/brief':
      return await getBriefCorto();
    case '/briefcompleto':
      return await generateMorningBriefString();
    case '/addrock':
      return arg? await agregarFilaSinDuplicar('BigRocks',arg):'✏️ Falta la tarea';
    case '/removerock':
      return arg? await removerFilaSiExiste('BigRocks',arg):'✏️ Falta la tarea';
    case '/addinteres':
      return arg? await agregarFilaSinDuplicar('Intereses',arg):'✏️ Falta el interés';
    case '/removeinteres':
      return arg? await removerFilaSiExiste('Intereses',arg):'✏️ Falta el interés';
    default:
      return '🤖 Comando no reconocido. Usa /help';
  }
}

// ===================================================================
// 8.  ROUTES & HEALTHCHECK
// ===================================================================
app.post(`/webhook/${TELEGRAM_SECRET}`, async (req,res)=>{
  try{
    const message=req.body.message;
    if(message?.text){
      const reply = await manejarComando(message);
      await telegramSend(message.chat.id, reply);
    }
    res.sendStatus(200);
  }catch(e){ console.error('Webhook:',e.message); res.sendStatus(500);} });

app.get('/healthz',(_,res)=>res.send('ok'));

app.listen(PORT,()=>console.log(`🚀 Joya Ultimate escuchando en ${PORT}`));
