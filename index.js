// =====================================================================
// ASISTENTE JOYA ULTIMATE – VERSIÓN RENDER (Node.js 18)
// =====================================================================
import express from 'express';
import fetch from 'node-fetch';
import NodeCache from 'node-cache';
import { google } from 'googleapis';

// ---------- CONFIG GLOBAL ------------------------------------------------
const {
  PORT = 3000,
  TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY,
  GEMINI_API_KEY,
  OPENWEATHER_API_KEY,
  NINJAS_KEY,
  DASHBOARD_SPREADSHEET_ID,
  GOOGLE_CREDENTIALS,
  CIUDAD_CLIMA = 'Santiago,cl'
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN falta en las variables de entorno');

// ---------- APP & UTILIDADES --------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
const cache = new NodeCache({ stdTTL: 300 }); // 5 min default

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function safeFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${txt.slice(0, 120)}`);
  }
  return res.json();
}

// ---------- OPENAI & GEMINI ---------------------------------------------
// (Aquí irían tus funciones getGpt y getGemini que ya tienes)
// ...

// ---------- CLIMA (OpenWeather) -----------------------------------------
async function getWeather() {
  const key = `weather-${CIUDAD_CLIMA}`;
  if (cache.has(key)) return cache.get(key);
  if (!OPENWEATHER_API_KEY) return 'Clima no disponible';
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(CIUDAD_CLIMA)}&units=metric&lang=es&appid=${OPENWEATHER_API_KEY}`;
    const data = await safeFetch(url);
    const desc = data.weather?.[0]?.description || '';
    const temp = Math.round(data.main?.temp);
    const out = `🌡️ ${temp}°C, ${desc}`;
    cache.set(key, out, 900); // Cache por 15 min
    return out;
  } catch (e) {
    console.error('getWeather:', e.message);
    return 'Clima no disponible';
  }
}

// ---------- GOOGLE SHEETS ------------------------------------------------
const sheetsClient = (() => {
  if (!GOOGLE_CREDENTIALS) return null;
  let instance;
  return async () => {
    if (instance) return instance;
    const creds = JSON.parse(GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    instance = google.sheets({ version: 'v4', auth: await auth.getClient() });
    return instance;
  };
})();

async function readColumn(sheetName, col = 'A') {
  const sheets = await sheetsClient();
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    range: `${sheetName}!${col}:${col}`
  });
  return res.data.values?.flat() || [];
}

async function appendRow(sheetName, values) {
  const sheets = await sheetsClient();
  if (!sheets) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: DASHBOARD_SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] }
  });
}

// ---------- BIG ROCKS & INTERESES ---------------------------------------
async function agregarFilaSinDuplicar(sheetName, texto) {
  try {
    const existentes = (await readColumn(sheetName)).map(v => String(v).toLowerCase());
    if (existentes.includes(texto.toLowerCase()))
      return `ℹ️ "${texto}" ya existe en "${sheetName}".`;
    await appendRow(sheetName, [texto]);
    return `✅ Agregado a "${sheetName}": ${texto}`;
  } catch (e) {
    console.error('agregarFila:', e.message);
    return `❌ Error al agregar en "${sheetName}".`;
  }
}

// TODO: Aquí añadiremos las funciones que faltan (remover, getPendientes, etc.)

// ---------- BOT TELEGRAM -------------------------------------------------
async function enviarMensajeTelegram(chatId, text, md = true) {
  // ... (código para enviar mensajes, se mantiene igual)
}

async function manejarComando(message) {
  const text = (message.text || '').trim();
  const [cmd, ...rest] = text.split(' ');
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '/start':
    case '/help':
      return `*Asistente JOYA* – comandos:\n/brief\n/addrock <texto>\n/removerock <texto>\n/addinteres <texto>`;
    
    case '/brief':
      const clima = await getWeather();
      return `*Resumen Rápido:*\n\n${clima}`;
      
    case '/addrock':
      return arg ? await agregarFilaSinDuplicar('BigRocks', arg) : '✏️ Debes indicar la tarea.';

    // TODO: Añadir casos para /removerock, /addinteres, /removeinteres, /briefcompleto

    default:
      return '🤖 Comando no reconocido. Usa /help';
  }
}

// ---------- WEBHOOK ------------------------------------------------------
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (message?.text) {
      console.log('Mensaje:', message.text);
      const reply = await manejarComando(message);
      await enviarMensajeTelegram(message.chat.id, reply);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.sendStatus(500);
  }
});

// ---------- HEALTHCHECK & START -----------------------------------------
app.get('/healthz', (_, res) => res.send('ok'));
app.listen(PORT, () => console.log(`Joya Ultimate 🔥 en puerto ${PORT}`));