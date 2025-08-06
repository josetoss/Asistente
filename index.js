const express = require('express');
const app = express();
app.use(express.json());

// --- Lógica del Bot (aquí pegaremos el resto de tus funciones más adelante) ---
function manejarComando(message) {
  const text = message.text ? message.text.trim() : '';
  const command = text.split(' ')[0];
  let responseText = `Comando '${command}' recibido. ¡La conexión desde Render funciona!`;

  if (command === '/start' || command === '/help') {
    responseText = `¡Hola! Soy el Asistente Joya, ahora viviendo en Render. 🚀`;
  }
  return responseText;
}

// --- Webhook que escucha a Telegram ---
app.post('/webhook', (req, res) => {
  const message = req.body.message;
  if (message) {
    console.log("Mensaje recibido:", message.text);
    const responseText = manejarComando(message);
    const chatId = message.chat.id;
    // Usamos process.env para leer la clave secreta de forma segura
    const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    fetch(telegramApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: responseText }),
    })
    .catch(error => console.error("Error al enviar a Telegram:", error));
  }
  // Respondemos a Telegram para confirmar la recepción
  res.sendStatus(200);
});

// --- Iniciar el servidor ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`El servidor del Asistente Joya está escuchando en el puerto ${PORT}.`);
});