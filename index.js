/* ╔════════════════════════════════════════════════════════════════╗
 * ║      ASISTENTE JOYA ULTIMATE · v2025                           ║
 * ║    Telegram · Google Sheets · Calendar · OpenWeather · OpenAI   ║
 * ║    Node 18 (ESM) — preparado para Render PaaS                   ║
 * ╚════════════════════════════════════════════════════════════════╝ */

import express from 'express';
import NodeCache from 'node-cache';
import fetchPkg from 'node-fetch';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { XMLParser } from 'fast-xml-parser';
import ical from 'node-ical';
const singleton = fn => {
  let inst;
  return (...args) => inst ?? (inst = fn(...args));
};
// ─── Google Sheets client ───────────────────────────────────────────
const sheetsClient = singleton(async () => {
  return google.sheets({
    version: 'v4',
    // Scope para leer y escribir en Google Sheets
    auth: await googleClient(['https://www.googleapis.com/auth/spreadsheets'])
  });
});
// ─── Google Calendar client ─────────────────────────────────────────
const calendarClient = singleton(async () => {
  return google.calendar({
    version: 'v3',
    // Scope para leer y escribir en Google Calendar
    auth: await googleClient(['https://www.googleapis.com/auth/calendar'])
  });
});

const SHEET_RANGES = {
  BIG_ROCKS: 'BigRocks!A2:A',
  INTERESES: 'Intereses!A2:A',
  INTERESES_BONUS: 'InteresesBonus!A:A',
  PENDIENTES: 'Pendientes!A2:G'
};

// ───── POLYFILL fetch (Node 18 < 18.20) ───────────────────────────
if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch   = fetchPkg;
  globalThis.Headers = fetchPkg.Headers;
  globalThis.Request = fetchPkg.Request;
  globalThis.Response= fetchPkg.Response;
}

/* ─── ENV ───────────────────────────────────────────────────────── */
const {
  PORT = 3000,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_SECRET,
  OPENWEATHER_API_KEY,
  OPENAI_API_KEY,
  GEMINI_API_KEY,
  NINJAS_KEY,
  CIUDAD_CLIMA = 'Santiago,cl',
  DASHBOARD_SPREADSHEET_ID,
  AGENDA_SHEET_ID,
  GOOGLE_CREDENTIALS,
  GOOGLE_CREDENTIALS_B64,
  ADMIN_CHAT_ID = ''
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_SECRET) {
  throw new Error('❌ Debes definir TELEGRAM_BOT_TOKEN y TELEGRAM_SECRET en las env vars');
}
if (!DASHBOARD_SPREADSHEET_ID) {
  console.warn('⚠️ DASHBOARD_SPREADSHEET_ID no definido — funciones de Sheets fallarán');
}

/* ─── Express & caché ───────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '1mb' }));
const cache = new NodeCache({ stdTTL: 300 });
const TELE_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const banner   = (t, e) => `\n${e} *${t}*\n──────────────`;
const escapeMd = s => (s||'').replace(/([\\_*[\]()~`>#+\-=|{}.!])/g, '\\$1');

/* ─── fetchSafe ─────────────────────────────────────────────────── */
const fetchSafe = (url, ms = 3000) =>
  Promise.race([
    fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text()),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]).catch(() => null);

// ─── Google Auth Singleton con validación de JSON ────────────
const googleClient = singleton(async (scopes) => {
  const raw = GOOGLE_CREDENTIALS ||
    (GOOGLE_CREDENTIALS_B64 && Buffer.from(GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8'));
  if (!raw) {
    throw new Error('❌ Debes definir GOOGLE_CREDENTIALS o GOOGLE_CREDENTIALS_B64 en las vars de entorno');
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    console.error('❌ Falló JSON.parse de GOOGLE_CREDENTIALS:', raw);
    throw new Error('Credenciales de Google inválidas: JSON mal formado');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: scopes
  });
  return auth.getClient();
});

/* ─── Telegram helper ───────────────────────────────────────────── */
async function sendTelegram(chatId, txt) {
  // Si no hay destinatario o texto, no hacemos nada.
  if (!chatId || !txt) return;

  const CHUNK = 4090; // Límite oficial 4096, dejamos un pequeño margen de seguridad.

  for (let i = 0; i < txt.length; i += CHUNK) {
    const part = txt.slice(i, i + CHUNK);
    
    await fetch(`${TELE_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: part,             // 1. Se envía el texto directamente, sin escaparlo.
        parse_mode: 'Markdown'  // 2. Usamos 'Markdown' estándar, es más flexible para la IA.
      })
    }).catch(e => console.error('Telegram send error:', e.message));
  }
}

/* ─── OpenWeather ──────────────────────────────────────────────── */
async function cityCoords(city) {
  const key = `coords_${city}`;
  if (cache.has(key)) return cache.get(key);
  if (!OPENWEATHER_API_KEY) return null;
  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_API_KEY}`;
  const [d] = await fetch(url).then(r => r.json()).catch(() => []);
  if (!d) return null;
  const coords = { lat:d.lat, lon:d.lon };
  cache.set(key, coords, 86400);
  return coords;
}

async function getWeather() {
  const key = `weather_${CIUDAD_CLIMA}`;
  if (cache.has(key)) return cache.get(key);
  const coords = await cityCoords(CIUDAD_CLIMA);
  if (!coords) return 'Clima no disponible';
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${coords.lat}&lon=${coords.lon}&units=metric&lang=es&appid=${OPENWEATHER_API_KEY}`;
  const data = await fetch(url).then(r => r.json()).catch(() => null);
  if (!data) return 'Clima no disponible';
  const today = DateTime.local().toISODate();
  const hits  = data.list.filter(i => i.dt_txt.startsWith(today));
  if (!hits.length) return 'Pronóstico no disponible';
  const min   = Math.round(Math.min(...hits.map(i=>i.main.temp_min)));
  const max   = Math.round(Math.max(...hits.map(i=>i.main.temp_max)));
  const desc  = hits[Math.floor(hits.length/2)].weather[0].description;
  const out   = `📉 Mín: ${min}°C · 📈 Máx: ${max}°C · ${desc[0].toUpperCase()+desc.slice(1)}`;
  cache.set(key, out, 10800);
  return out;
}

/* ─── Google Sheets Utils ─────────────────────────────────────── */
async function col(sheetName, col='A') {
  const gs = await sheetsClient();
  const res = await gs.spreadsheets.values.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    range: `${sheetName}!${col}:${col}`
  });
  return res.data.values?.flat()||[];
}

async function appendRow(sheetName, row) {
  const gs = await sheetsClient();
  await gs.spreadsheets.values.append({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] }
  });
}

const getSheetId = singleton(async sheetName => {
  const gs = await sheetsClient();
  const meta = await gs.spreadsheets.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    fields: 'sheets.properties'
  });
  const sh = meta.data.sheets.find(s=>s.properties.title===sheetName);
  if (!sh) throw new Error(`Sheet "${sheetName}" no encontrado`);
  return sh.properties.sheetId;
});

async function addUnique(sheetName, text) {
  const values = await col(sheetName);
  if (values.some(v=>v?.toLowerCase()===text.toLowerCase())) {
    return `ℹ️ "${text}" ya existe en "${sheetName}".`;
  }
  await appendRow(sheetName, [text]);
  return `✅ Agregado a "${sheetName}": ${text}`;
}

async function removeRow(sheetName, text) {
  try {
    const values = await col(sheetName);
    const idx = values.findIndex(v=>v?.toLowerCase()===text.toLowerCase());
    if (idx===-1) return `ℹ️ No se encontró "${text}" en "${sheetName}".`;
    const gs = await sheetsClient();
    await gs.spreadsheets.batchUpdate({
      spreadsheetId: DASHBOARD_SPREADSHEET_ID,
      requestBody: {
        requests:[{
          deleteDimension:{
            range:{
              sheetId: await getSheetId(sheetName),
              dimension:'ROWS',
              startIndex: idx,
              endIndex: idx+1
            }
          }
        }]
      }
    });
    return `🗑️ Eliminado de "${sheetName}": ${text}`;
  } catch(e) {
    console.error('removeRow error:', e.message);
    return `❌ Error al eliminar en "${sheetName}".`;
  }
}

async function findAndRemoveWithAI(sheetName, userQuery) {
  try {
    // Paso 1: Obtener la lista completa de items desde la hoja.
    // Asumimos que la primera columna (A) contiene el texto a buscar.
    const items = await col(sheetName, 'A');
    if (!items.length) {
      return `ℹ️ La lista "${sheetName}" está vacía.`;
    }

    // Paso 2: Crear el prompt para la IA.
    const prompt = `
      Eres un asistente de normalización de datos. Tu tarea es encontrar una coincidencia exacta en una lista.
      Basado en la petición del usuario de eliminar "${userQuery}", ¿cuál de los siguientes items de la lista es el que quiere eliminar?

      Lista de Items:
      - ${items.join('\n- ')}

      Responde SOLAMENTE con el texto exacto del item de la lista que coincida.
      Si no hay una coincidencia clara o es ambiguo, responde EXACTAMENTE con la palabra "NULL".
    `;

    // Paso 3: Consultar a la IA.
    const itemToDelete = await askAI(prompt, 100, 0.4); // Usamos baja temperatura para respuestas precisas.

    // Paso 4: Procesar la respuesta de la IA.
    if (itemToDelete === 'NULL' || itemToDelete.startsWith('[')) {
      return `🤔 No pude determinar con seguridad qué item eliminar con "${userQuery}". Intenta ser un poco más específico.`;
    }

    // Paso 5: Usar la función de eliminación original con el texto exacto.
    return await removeRow(sheetName, itemToDelete);

  } catch (e) {
    console.error(`Error en findAndRemoveWithAI para "${sheetName}":`, e.message);
    return `❌ Ocurrió un error al intentar la eliminación inteligente.`;
  }
}



/* ─── Big Rocks, Intereses, Pendientes, Agenda ─────────────────── */

async function getBigRocks() {
  const key = 'bigRocks';
  if (cache.has(key)) return cache.get(key);
  try {
    const list = (await col(SHEET_RANGES.BIG_ROCKS.split('!')[0])).filter(Boolean).map(t => '• ' + t.trim());
    cache.set(key, list, 120);
    return list;
  } catch (e) {
    console.error('getBigRocks error:', e.message);
    return ['(Error al obtener Big Rocks)'];
  }
}

async function getIntereses() {
  const key = 'intereses';
  if (cache.has(key)) return cache.get(key);
  try {
    const list = (await col(SHEET_RANGES.INTERESES.split('!')[0])).slice(1).filter(Boolean).map(t => t.trim());
    cache.set(key, list, 600);
    return list;
  } catch (e) {
    console.error('getIntereses error:', e.message);
    return [];
  }
}

async function getPendientes() {
  const key = 'pendientes';
  // 1. La caché ahora funciona correctamente: primero busca el dato guardado.
  if (cache.has(key)) {
    console.log('Usando pendientes desde la caché.');
    return cache.get(key);
  }

  console.log('Iniciando getPendientes (leyendo desde Google Sheets)...');

  try {
    const gs = await sheetsClient();
    const res = await gs.spreadsheets.values.get({
      spreadsheetId: DASHBOARD_SPREADSHEET_ID,
      // 2. Usamos la constante para mayor seguridad y fácil mantenimiento.
      range: SHEET_RANGES.PENDIENTES 
    });

    const rows = res.data.values || [];
    console.log(`- Filas obtenidas de Google Sheets: ${rows.length}`);
    if (rows.length === 0) return [];

    const today = DateTime.local().startOf('day');

    const pendientesProcesados = rows.map((r, index) => {
      const estado = (r[4] || '').toLowerCase().trim();
      return {
        tarea: r[1] || `(Tarea sin descripción en fila ${index + 2})`,
        vence: r[2] ? DateTime.fromISO(new Date(r[2]).toISOString()) : null,
        estado: estado,
        score: (Number(r[5]) || 2) * 2 + (Number(r[6]) || 2)
      };
    });

    const pendientesFiltrados = pendientesProcesados.filter(p => 
      !['done', 'discarded', 'waiting'].includes(p.estado)
    );
    console.log(`- Filas después de filtrar por estado: ${pendientesFiltrados.length}`);

    if (pendientesFiltrados.length === 0) {
      return []; // No hay pendientes activos, devolvemos una lista vacía.
    }

    const listaFinal = pendientesFiltrados
      .map(p => ({
        ...p,
        atras: p.vence && p.vence.isValid && p.vence < today
      }))
      .sort((a, b) => (b.atras - a.atras) || (b.score - a.score))
      .slice(0, 5)
      .map(p => {
        const fecha = p.vence && p.vence.isValid ? ` (${p.vence.toFormat('dd-MMM')})` : '';
        return `${p.atras ? '🔴' : '•'} ${p.tarea}${fecha}`;
      });

    console.log(`- Lista final de pendientes para mostrar: ${listaFinal.length}`);
    
    // 3. Guardamos en caché solo si el resultado es bueno.
    if (listaFinal.length > 0) {
      cache.set(key, listaFinal, 120); // Cache por 2 minutos
    }

     return listaFinal;

  } catch (e) {
    console.error('Error CRÍTICO en getPendientes:', e.message);
    return [`❌ Error en Pendientes: ${e.message}`];
  }
}

//======================================================================
// FUNCIÓN PARA LEER LOS NUEVOS INTERESES DEL BONUS TRACK
//======================================================================
async function getInteresesBonus() {
  const key = 'interesesBonus';
  if (cache.has(key)) return cache.get(key);
  try {
    const gs = await sheetsClient();
    const res = await gs.spreadsheets.values.get({
      spreadsheetId: DASHBOARD_SPREADSHEET_ID,
      range: SHEET_RANGES.INTERESES_BONUS
    });
    const list = (res.data.values?.flat() || []).filter(Boolean).map(t => t.trim());
    console.log(`Intereses "Bonus" cargados: ${list.join(', ')}`);
    cache.set(key, list, 600); // Cache por 10 minutos
    return list;
  } catch (e) {
    console.error('getInteresesBonus error:', e.message);
    return []; // Devuelve un array vacío si falla
  }
}

// REEMPLAZA TU getAgenda() CON ESTA VERSIÓN iCal
async function getAgenda() {
  const cacheKey = 'agenda_ical_separada';
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const urlPersonal = process.env.GCAL_ICAL_URL_PERSONAL;
  const urlProfesional = process.env.GCAL_ICAL_URL_PROFESIONAL;

  // Función auxiliar para procesar una URL de iCal
  const procesarURL = async (url) => {
    if (!url) return []; // Si la URL no está definida, devuelve una lista vacía
    
    const events = await ical.async.fromURL(url);
    const todayStart = DateTime.local().setZone('America/Santiago').startOf('day');
    const todayEnd = DateTime.local().setZone('America/Santiago').endOf('day');
    const todaysEvents = [];

    for (const event of Object.values(events)) {
      if (event.type === 'VEVENT') {
        const start = DateTime.fromJSDate(event.start).setZone('America/Santiago');
        if (start >= todayStart && start <= todayEnd) {
          todaysEvents.push({ summary: event.summary, start: start });
        }
      }
    }
    return todaysEvents;
  };

  try {
    // Hacemos ambas llamadas en paralelo para máxima eficiencia
    const [eventosPersonales, eventosProfesionales] = await Promise.all([
      procesarURL(urlPersonal),
      procesarURL(urlProfesional)
    ]);

    // Función auxiliar para formatear la lista de eventos
    const formatEventList = (eventList) => {
      if (!eventList || eventList.length === 0) return [];
      eventList.sort((a, b) => a.start - b.start);
      return eventList.map(e => `• ${e.start.toFormat('HH:mm')} – ${e.summary || '(sin título)'}`);
    };
    
    const agendaData = {
      personal: formatEventList(eventosPersonales),
      profesional: formatEventList(eventosProfesionales)
    };

    cache.set(cacheKey, agendaData, 300);
    return agendaData;

  } catch (e) {
    console.error('getAgenda (iCal múltiple) error:', e.message);
    return { personal: [], profesional: [`(Error al leer iCal: ${e.message})`] };
  }
}

/* ─── AI helpers (GPT & Gemini) ────────────────────────────────── */
// ⚠️ Nota: Asegúrate de que OPENAI_API_KEY y GEMINI_API_KEY estén definidos en tus variables de entorno.

const { AI_MODEL = 'gemini' } = process.env; // Usa 'gemini' por defecto, cámbialo si prefieres 'gpt'

// 1. **Primero** define la función para OpenAI
async function askGPT(prompt, max_tokens = 300, temperature = 0.6) {
    if (!OPENAI_API_KEY) return '[OPENAI_API_KEY faltante]';
    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4.1',
                messages: [{
                    role: 'user',
                    content: prompt
                }],
                max_tokens,
                temperature
            })
        });
        if (!res.ok) {
            console.error('GPT error:', res.statusText);
            return `[GPT error: ${res.statusText}]`;
        }
        const j = await res.json();
        return j.choices?.[0]?.message?.content?.trim() || '[GPT vacío]';
    } catch (e) {
        console.error('GPT fetch error:', e.message);
        return `[GPT error: ${e.message}]`;
    }
}

// 2. **Luego** define la función para Google Gemini
async function askGemini(prompt, max_tokens = 300, temperature = 0.6) {
    if (!GEMINI_API_KEY) return '[GEMINI_API_KEY faltante]';
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [{
                        text: prompt
                    }]
                }],
                generationConfig: {
                    maxOutputTokens: max_tokens,
                    temperature: temperature
                }
            })
        });
        if (!res.ok) {
            const errorBody = await res.text();
            console.error('Gemini error:', res.status, errorBody);
            return `[Gemini error: ${res.statusText}]`;
        }
        const j = await res.json();
        return j.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[Gemini vacío]';
    } catch (e) {
        console.error('Gemini fetch error:', e.message);
        return `[Gemini error: ${e.message}]`;
    }
}

// ─── Helper opcional: timeout para llamadas a IA ───────────────────────────
const withTimeout = (promise, ms, label = 'AI') =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms))
  ]);

// ─── askAI (modo paralelo con conciliación y preferencia) ──────────────────
// Usa AI_MODEL = 'gemini' o 'gpt' (env var) para decidir quién concilia.
// Llama a ambos en paralelo; si uno falla, usa el otro; si ambos responden, concilia.
async function askAI(prompt, max_tokens = 300, temperature = 0.6) {
  const prefer = (process.env.AI_MODEL || 'gemini').toLowerCase();

  // 1) Ejecutar ambos modelos en paralelo con timeout suave
  const [resultGemini, resultGPT] = await Promise.allSettled([
    withTimeout(askGemini(prompt, max_tokens, temperature), 12000, 'Gemini'),
    withTimeout(askGPT(prompt, max_tokens, temperature),   12000, 'GPT')
  ]);

  // 2) Normalizar resultados (string con posible "[... error ...]" si falló)
  const responseGemini =
    resultGemini.status === 'fulfilled'
      ? resultGemini.value
      : `[Gemini error: ${resultGemini.reason?.message || 'Promise rejected'}]`;

  const responseGPT =
    resultGPT.status === 'fulfilled'
      ? resultGPT.value
      : `[GPT error: ${resultGPT.reason?.message || 'Promise rejected'}]`;

  const geminiFailed = typeof responseGemini === 'string' && responseGemini.startsWith('[Gemini error');
  const gptFailed    = typeof responseGPT   === 'string' && responseGPT.startsWith('[GPT error');

  // Caso A: ambos fallan
  if (geminiFailed && gptFailed) {
    return `[Error de IA] ${responseGemini} | ${responseGPT}`;
  }

  // Caso B: solo uno falla → usa el que sirvió
  if (geminiFailed) return responseGPT;
  if (gptFailed)    return responseGemini;

  // Caso C: ambos respondieron → conciliar con el preferido
  const reconciliationPrompt = `
Eres un editor experto. Has recibido dos borradores para el mismo prompt.
Combina las siguientes dos respuestas en una sola, concisa y fluida.
Mantén la información más relevante y el tono profesional.
---
Respuesta 1 (Gemini):
${responseGemini}
---
Respuesta 2 (GPT):
${responseGPT}
`.trim();

  const reconciled =
    prefer === 'gpt'
      ? await askGPT(reconciliationPrompt, max_tokens, 0.5)
      : await askGemini(reconciliationPrompt, max_tokens, 0.5);

  // Si la conciliación falla, devuelve la respuesta del modelo preferido
  const reconFailed = typeof reconciled === 'string' &&
    (reconciled.startsWith('[Gemini error') || reconciled.startsWith('[GPT error'));

  if (reconFailed) {
    return prefer === 'gpt' ? responseGPT : responseGemini;
  }
  return reconciled;
}

/* ─── Radar Inteligencia Global (v2: Con Filtro de Fecha y Traducción) ── */
async function intelGlobal() {
  const key = 'intelGlobal_v2';
  if (cache.has(key)) return cache.get(key);
  
  const FEEDS = [ /* ... tu lista de feeds se mantiene igual ... */ ];

  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const xmls = (await Promise.all(FEEDS.map(url => fetchSafe(url, 5000)))).filter(Boolean);
    
    const unDiaAtras = DateTime.local().minus({ days: 1 });
    let articles = [];

    xmls.forEach(xml => {
      const feed = parser.parse(xml);
      const items = feed.rss ? feed.rss.channel.item : (feed.feed ? feed.feed.entry : []);
      if (items) articles.push(...items);
    });

    const candidates = articles
      .map((item, i) => {
        // Normalizamos los diferentes formatos de fecha de los RSS
        const pubDateStr = item.pubDate || item.published || item.updated;
        const pubDate = pubDateStr ? DateTime.fromRFC2822(pubDateStr) : DateTime.local();
        return {
          id: i + 1,
          title: item.title,
          link: typeof item.link === 'string' ? item.link : item.link?.['@_href'],
          date: pubDate
        };
      })
      // --- FILTRO DE FECHA: Solo noticias de las últimas 24 horas ---
      .filter(c => c.link && c.title && c.date >= unDiaAtras);

    if (candidates.length < 4) return '_(No se encontraron suficientes noticias recientes)_';

    const intereses = (await getIntereses()).join(', ') || 'geopolítica, tecnología';
    
    const promptSeleccion = `
      From the following list of recent headlines, pick the 4 most strategically important ones for an executive interested in: ${intereses}.
      For each of the 4, respond ONLY with its title.
      
      Headlines:
      ${candidates.map(c => `- ${c.title}`).join('\n')}
    `;
    const seleccionEnIngles = await askAI(promptSeleccion, 400, 0.5);

    // --- TRADUCCIÓN CON IA ---
    const promptTraduccion = `
      You are a professional translator for an executive intelligence briefing.
      Translate the following 4 headlines and their summaries into Spanish.
      Keep the tone professional and concise. For each, add a link at the end in Markdown format.

      For each of the 4 headlines below, find its corresponding article from the provided list and generate a 1-2 sentence summary.
      
      Selected Headlines:
      ${seleccionEnIngles}

      Full Article List (for context and summaries):
      ${candidates.map(c => `- Title: ${c.title}\n  Link: ${c.link}`).join('\n\n')}
      
      Respond in Spanish. For each item, use the format:
      *<Título en Español>*
      <Resumen en Español> ([Leer más](URL))
    `;
    
    const resultadoFinal = await askAI(promptTraduccion, 800, 0.7);

    cache.set(key, resultadoFinal, 3600); // Cache por 1 hora
    return resultadoFinal;

  } catch (e) {
    console.error('Error en intelGlobal_v2:', e.message);
    return '_(Error al procesar las noticias)_';
  }
}

/* ─── Horóscopo Supremo (Enfoque Diario y Múltiples Fuentes) ─── */
async function getHoroscopo() {
  const key = 'horoscopo_diario';
  if (cache.has(key)) return cache.get(key);

  // --- FUENTES DE DATOS PARA EL HORÓSCOPO ---
  const fuentes = [
    // Fuente 1: API Aztro (simple y directa)
    fetchSafe('https://aztro.sameerkumar.website/?sign=libra&day=today')
      .then(t => t && JSON.parse(t).description).catch(() => null),
      
    // Fuente 2: API Ninjas (si la clave está configurada)
    process.env.NINJAS_KEY
      ? fetch('https://api.api-ninjas.com/v1/horoscope?zodiac=libra', { headers: { 'X-Api-Key': process.env.NINJAS_KEY } })
          .then(r => r.json()).then(d => d.horoscope).catch(() => null)
      : null,
      
    // Fuente 3: IA con enfoque general para hoy
    askAI('Horóscopo para Libra enfocado específicamente en el día de HOY (3 líneas, español).', 120, 0.7),
    
    // Fuente 4: IA con enfoque en carrera y finanzas para hoy
    askAI('Consejo de carrera/finanzas para Libra para HOY (3 líneas, español).', 120, 0.7),

    // Fuente 5: IA con enfoque en bienestar personal para hoy
    askAI('Consejo de bienestar personal y relaciones para Libra para HOY (3 líneas, español).', 120, 0.8)
  ];
  
  const results = await Promise.allSettled(fuentes.filter(Boolean)); // Filtramos nulos si NINJAS_KEY no existe
  const drafts = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value).join('\n\n');
  
  if (!drafts) return 'Horóscopo no disponible.';

  // Prompt final que sintetiza todas las fuentes en una sola respuesta coherente
  const prompt = `
    Eres un astrólogo maestro. Sintetiza estos borradores en UN solo horóscopo para el día de HOY.
    El resultado debe tener un titular corto en negrita y un párrafo cohesionado de 4-5 líneas. Responde en español.

    Borradores de referencia:
    ${drafts}
  `;
  const final = await askAI(prompt, 250, 0.6);
  cache.set(key, final, 21600); // Cache por 6 horas
  return final;
}

/* ─── Bonus Track (con Fuentes, Filtro de Antigüedad y Formato) ─── */
async function bonusTrack() {
  const key = 'bonusTrack_v2';
  if (cache.has(key)) return cache.get(key);
  
  // --- FUENTES DE DATOS PARA EL BONUS TRACK (FEEDS RSS) ---
  const FEEDS = [
    'https://www.wired.com/feed/rss', 
    'https://www.theverge.com/rss/index.xml',
    'http://feeds.feedburner.com/TechCrunch/', 
    'https://www.technologyreview.com/feed/',
    'https://restofworld.org/feed/latest/', 
    'https://arstechnica.com/science/feed/',
    'https://aeon.co/feed.rss', 
    'https://psyche.co/feed',
    'https://www.noemamag.com/feed/', 
    'https://longreads.com/feed/',
    'https://getpocket.com/explore/rss', 
    'https://sidebar.io/feed.xml',
    'https://elgatoylacaja.com/feed/', 
    'https://hipertextual.com/feed'
  ];

  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const xmls = (await Promise.all(FEEDS.map(url => fetchSafe(url, 7000)))).filter(Boolean);
    
    let articles = [];
    xmls.forEach(xml => {
      const feed = parser.parse(xml);
      const items = feed.rss ? feed.rss.channel.item : (feed.feed ? feed.entry : []);
      if (items) articles.push(...items);
    });

    const tresSemanasAtras = DateTime.local().minus({ weeks: 3 });

    const candidates = articles
      .map((item, i) => {
        const pubDateStr = item.pubDate || item.published || item.updated;
        const pubDate = pubDateStr ? DateTime.fromRFC2822(pubDateStr).setZone('utc') : DateTime.local();
        return {
          id: i + 1,
          title: String(item.title),
          link: typeof item.link === 'string' ? item.link : item.link?.['@_href'],
          date: pubDate
        };
      })
      .filter(c => c.link && c.title && c.date >= tresSemanasAtras);

    if (candidates.length === 0) throw new Error("No se encontraron artículos suficientemente recientes.");

    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    const intereses = (await getInteresesBonus()).join(', ');
    if (!intereses) throw new Error("No hay intereses bonus definidos.");

    const prompt = `
      Basado en los intereses (${intereses}), elige el artículo MÁS interesante de la siguiente lista.
      Tu respuesta debe seguir ESTRICTAMENTE este formato:
      *<TÍTULO DEL ARTÍCULO ORIGINAL>*
      <RESUMEN DE MÁXIMO 140 CARACTERES>
      [Leer más](<URL_DEL_ARTÍCULO>)

      Artículos candidatos:
      ${candidates.slice(0, 20).map(c => `- Título: ${c.title}\n  URL: ${c.link}`).join('\n\n')}
    `;
    
    const finalBonus = await askAI(prompt, 200, 0.7);
    if (finalBonus.startsWith('[')) throw new Error(`La IA falló: ${finalBonus}`);

    cache.set(key, finalBonus, 21600);
    return finalBonus;

  } catch (e) {
    console.error('Error en bonusTrack_v2:', e.message);
    return '_(No se pudo generar una recomendación de Bonus Track hoy)_';
  }
}

/* ─── Briefs ────────────────────────────────────────────────────── */
async function briefShort() {
  // Obtenemos todos los datos en paralelo
  const [clima, bigRocks, agendaData, pendientesList] = await Promise.all([
    getWeather(), 
    getBigRocks(), 
    getAgenda(), // Devuelve { personal: [], profesional: [] }
    getPendientes()
  ]);

  // Lógica para unir las agendas para el resumen
  const agendaUnificada = [...agendaData.profesional, ...agendaData.personal];
  
  return [
    '⚡️ *Resumen Rápido*',
    banner('Clima','🌦️'), 
    clima,
    banner('Misión Principal (Big Rock)','🚀'), 
    bigRocks.length > 0 ? bigRocks.join('\n') : '_(No definido)_',
    banner('Focos Críticos (Pendientes)','🔥'), 
    pendientesList.length > 0 ? pendientesList.join('\n') : '_(Sin pendientes)_',
    banner('Agenda del Día','📅'), 
    agendaUnificada.length > 0 ? agendaUnificada.join('\n') : '_(Sin eventos)_'
  ].join('\n\n');
}
async function briefFull() {
  // await addWorkAgendaToPersonalCalendar(); // <-- Confirmamos que esta línea está inactiva
  
  const [clima, agendaData, pendientesList, bigRocks, intel, horo, bonus] = await Promise.all([
    getWeather(), 
    getAgenda(), // Devuelve { personal: [], profesional: [] }
    getPendientes(), 
    getBigRocks(), 
    intelGlobal(), 
    getHoroscopo(), 
    bonusTrack()
  ]);

  // --- Lógica para formatear la agenda en subsecciones ---
  let agendaFormatted = '';
  const profesionalEvents = agendaData.profesional || [];
  const personalEvents = agendaData.personal || [];

  // Siempre mostramos la sección profesional
  agendaFormatted += `*Agenda Profesional:*\n`;
  if (profesionalEvents.length > 0) {
    agendaFormatted += profesionalEvents.join('\n');
  } else {
    agendaFormatted += '_(Sin eventos profesionales)_';
  }

  // Lógica CONDICIONAL para la agenda personal
  if (personalEvents.length > 0) {
    agendaFormatted += `\n\n*Agenda Personal:*\n`;
    agendaFormatted += personalEvents.join('\n');
  }
  // ---------------------------------------------------

  const promptCoach = `
    ⚔️ Actúa como mi "Jefe de Gabinete" y coach estratégico personal.
    Tu respuesta en 4 puntos, cada uno de no más de 55 caracteres.
    1. **Foco Principal:** ...
    2. **Riesgo a Mitigar:** ...
    3. **Acción Clave:** ...
    4. **Métrica de Éxito:** "El éxito hoy se medirá por: ..."
    ---
    Agenda Profesional:
    ${profesionalEvents.join('\n') || '—'}
    Agenda Personal:
    ${personalEvents.join('\n') || '—'}
    Pendientes:
    ${pendientesList.join('\n') || '—'}
    Big Rock:
    ${bigRocks.join('\n') || '—'}
  `;
  const analisis = await askAI(promptCoach, 350, 0.7);

  return [
    '🗞️ *MORNING BRIEF JOYA ULTIMATE*',
    `> _${DateTime.local().setZone('America/Santiago').toFormat("cccc d 'de' LLLL yyyy")}_`,
    banner('Análisis Estratégico', '🧠'), analisis,
    banner('Clima', '🌦️'), clima,
    banner('Agenda', '📅'), agendaFormatted, // Usamos nuestra nueva variable formateada
    banner('Pendientes Críticos', '🔥'), pendientesList.length > 0 ? pendientesList.join('\n') : '_(Sin pendientes activos)_',
    banner('Tu Misión Principal (Big Rock)', '🚀'), bigRocks.length > 0 ? bigRocks.join('\n') : '_(No definido)_',
    banner('Radar Inteligencia Global', '🌍'), intel,
    banner('Horóscopo (Libra)', '🔮'), horo,
    banner('Bonus Track', '🎁'), bonus
  ].join('\n\n');
}
/* ─── Estado del Sistema ───────────────────────────────────────── */
async function getSystemStatus() {
  const checks = await Promise.allSettled([
    sheetsClient().then(()=>`✅ Google Sheets`),
    calendarClient().then(()=>`✅ Google Calendar`),
    askAI('test',1).then(r=>r.includes('[')?`❌ OpenAI (${r})`:`✅ OpenAI`),
    getWeather().then(r=>r.includes('disponible')?`❌ OpenWeather`:`✅ OpenWeather`)
  ]);
  return `*Estado del Sistema Asistente JOYA*\n──────────────\n` +
    checks.map(r=> r.status==='fulfilled'? r.value : `❌ ${r.reason.message}`).join('\n');
}

/* ─── Command Router (Versión Final con Todas las Funciones) ─── */

// 1. Objeto que mapea cada comando a la función que debe ejecutar.
const commands = {
  '/brief': briefShort,
  '/briefcompleto': briefFull,
  '/status': getSystemStatus,
  
  // Comandos para Big Rocks
  '/addrock': (arg) => arg ? addUnique('BigRocks', arg) : '✏️ Falta la tarea.',
  '/removerock': (arg) => arg ? findAndRemoveWithAI('BigRocks', arg) : '✏️ ¿Qué tarea quieres eliminar?',
  
  // Comandos para Intereses Profesionales (Radar Global)
  '/addinteres': (arg) => arg ? addUnique('Intereses', arg) : '✏️ Falta el interés profesional.',
  '/removeinteres': (arg) => arg ? findAndRemoveWithAI('Intereses', arg) : '✏️ ¿Qué interés profesional quieres eliminar?',
  
  // --- NUEVOS COMANDOS PARA INTERESES DEL BONUS TRACK ---
  '/addbonus': (arg) => arg ? addUnique('InteresesBonus', arg) : '✏️ Falta el interés personal/bonus.',
  '/removebonus': (arg) => arg ? findAndRemoveWithAI('InteresesBonus', arg) : '✏️ ¿Qué interés personal/bonus quieres eliminar?',
  
  // Comandos para Pendientes
  '/addpendiente': (arg) => {
    if (!arg) return '✏️ Falta la descripción del pendiente.';
    // Formato de la fila: [ID, Tarea, Vence, Responsable, Estado, Impacto, Urgencia]
    appendRow('Pendientes', [null, arg, null, null, 'Todo', 3, 3]);
    return `✅ Pendiente añadido: "${arg}"`;
  },
  '/removependiente': (arg) => {
    if (!arg) return '✏️ ¿Qué pendiente quieres eliminar?';
    return findAndRemoveWithAI('Pendientes', arg);
  }
};

// 2. La función router, que interpreta los comandos del usuario.
async function router(msg) {
  const [cmd, ...rest] = (msg.text || '').trim().split(' ');
  const arg = rest.join(' ').trim();

  // Manejo especial para /start y /help, que ahora genera la ayuda automáticamente.
  if (cmd === '/start' || cmd === '/help') {
    const commandList = Object.keys(commands).join('\n');
    return `*Asistente JOYA · Comandos Disponibles*\n──────────────\n${commandList}`;
  }

  const commandFunction = commands[cmd];

  // Si el comando existe en nuestro objeto, lo ejecutamos.
  if (commandFunction) {
    // Le pasamos el argumento (arg) a la función correspondiente.
    return await commandFunction(arg);
  }
  
  // Si el comando no se encuentra, devolvemos un mensaje de error.
  return '🤖 Comando no reconocido. Usa /help para ver la lista de comandos.';
}

/* ─── Webhook & Server ─────────────────────────────────────────── */
app.post(`/webhook/${TELEGRAM_SECRET}`, (req, res) => {
  res.sendStatus(200);
  (async()=> {
    const msg = req.body.message;
    try {
      if (msg?.text) {
        const reply = await router(msg);
        await sendTelegram(msg.chat.id, reply);
      }
    } catch(err) {
      console.error('Webhook async error:', err);
      if (ADMIN_CHAT_ID) {
        await sendTelegram(ADMIN_CHAT_ID,
          `🔴 *Error crítico*\nComando: \`${msg.text}\`\nError: \`${err.message}\``);
      }
    }
  })();
});

app.get('/healthz', (_,res) => res.send('ok'));
app.listen(PORT, ()=> console.log(`🚀 Joya Ultimate escuchando en puerto ${PORT}`));

/**
 * Encuentra un item en una hoja de cálculo usando IA para fuzzy matching y lo elimina.
 * @param {string} sheetName El nombre de la hoja (ej. 'BigRocks').
 * @param {string} userQuery El texto parcial que el usuario proveyó (ej. 'tratado').
 * @returns {Promise<string>} Un mensaje de confirmación o error.
 */
