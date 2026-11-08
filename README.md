# Set & Sound AI API

Este backend recibe consultas de la dashboard y las envía a Gemini o Claude. Las claves de API se guardan como variables privadas en el servicio de alojamiento; nunca las pongas en `index.html` ni las publiques en GitHub.

## Para desplegar en Render

1. Inicia sesión en Render con GitHub.
2. Elige **New +** → **Web Service**.
3. Conecta el repositorio `ignacioleytonprod-droid/set-sound-command-center`.
4. Usa la rama `main`, la carpeta raíz, Runtime `Node` y estos comandos:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. En **Environment**, configura `ALLOWED_ORIGINS` con el origen exacto de GitHub Pages (sin ruta final), por ejemplo `https://ignacioleytonprod-droid.github.io`.
6. Cuando exista el servicio, añade las claves como variables privadas en Render. No las compartas en mensajes ni las guardes en el repositorio.

Variables de entorno:

- `GEMINI_API_KEY` — opcional hasta que actives Gemini.
- `CLAUDE_API_KEY` — opcional hasta que actives Claude.
- `GEMINI_MODEL` — modelo disponible en la cuenta de Google AI Studio. Si no se define, se intenta usar `gemini-1.5-flash`.
- `CLAUDE_MODEL` — modelo disponible en la cuenta de Anthropic. Si no se define, se intenta usar `claude-3-5-sonnet-20241022`.
- `ALLOWED_ORIGINS` — dominio del sitio GitHub Pages; se permiten localhost para pruebas.
- `PORT` lo asigna Render automáticamente.

El endpoint de estado será `https://TU-SERVICIO.onrender.com/health`. El chat usa `POST https://TU-SERVICIO.onrender.com/api/chat`.

## Protecciones incluidas

- CORS limitado a orígenes permitidos.
- Máximo 10 consultas por dirección IP en 15 minutos.
- Consultas limitadas a 4000 caracteres.
- Claves no incluidas en la respuesta ni en los logs de error.

Como el sitio es público, el límite de consultas reduce el abuso pero no sustituye un inicio de sesión. Revisa el uso y los costos de API en las consolas de los proveedores.
