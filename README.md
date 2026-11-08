# Set & Sound AI API

Este backend recibe consultas desde la dashboard y las envía a Gemini o Claude.

## 1) Instalar dependencias

En la carpeta del proyecto, ejecuta:

```bash
npm install
```

## 2) Configurar variables privadas

Copia este archivo y renómbralo a `.env`:

```bash
cp .env.example .env
```

Luego rellena tus claves reales:

```bash
PORT=3001
GEMINI_API_KEY=tu_clave_de_gemini
CLAUDE_API_KEY=tu_clave_de_claude
```

IMPORTANTE:
- `.env` debe quedarse en tu equipo o en el servidor.
- Nunca lo subas a GitHub Pages.
- Nunca metas la clave en `index.html`.

## 3) Probar localmente

```bash
npm start
```

Luego abre:

```bash
http://localhost:3001/health
```

Si ves `{ "ok": true, ... }`, todo está bien.

## 4) Hacer llamada de prueba

Puedes probar con curl:

```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "gemini",
    "message": "Crea una checklist rápida para una noche de producción audiovisual"
  }'
```

## 5) Alojamiento online

Necesitas desplegar este backend en un host que soporte Node.js.

Recomendación fácil para empezar:
- Render
- Railway

Esto te dará una URL pública tipo:

```text
https://set-sound-ai-api.onrender.com
```

## 6) Conectar el frontend

En tu `index.html`, cambia la variable:

```js
const API_ENDPOINT = 'https://tu-backend-url.com';
```

Eso le dice a la página dónde enviar las consultas.

## 7) Importante

GitHub Pages sirve contenido estático. La página puede estar allí, pero la parte de IA debe vivir en el backend.
