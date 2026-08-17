// ══════════════ Gemeinsamer Einstieg ══════════════ Anfang ════════════════
// ERZEUGT - NICHT HIER AENDERN. Quelle: /var/www/html/gemeinsam/statisch.js
// Aendern, dann `node werkzeug/verteilen.mjs --nur <spiel>`.
//
// Statische Dateien ausliefern, WebSockets annehmen, die Bremse davorhaengen.
// Das war in jedem Server-Spiel dieselben 88 Zeilen - Wort fuer Wort, bis auf
// die letzte Zeile mit dem Namen.
//
// `./bremse.js` liegt daneben im selben Spielordner. Beide Dateien kommen aus
// gemeinsam/, aber geladen wird immer die Kopie des Spiels: faellt dieser
// Ordner weg, laeuft das Spiel weiter.
// ──────────────────────────────────────────────────────────────────────────

import { absender, darfVerbinden, verbindungAuf, verbindungZu } from "./bremse.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/**
 * Datei aus dem oeffentlichen Ordner ausliefern.
 *
 * Zwei Riegel gegen Ausbrechen: `..` als Pfadteil fliegt raus, und die
 * aufgeloeste URL muss unterhalb von `publicDir` liegen. Der zweite faengt
 * auch, was der erste durchlaesst - codierte Trenner etwa.
 */
async function serveStatic(publicDir, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (rel.split("/").some((seg) => seg === "..")) {
    return new Response("Nope", { status: 400 });
  }
  const url = new URL(rel, publicDir);
  if (!url.href.startsWith(publicDir.href)) {
    return new Response("Nope", { status: 400 });
  }
  try {
    const body = await Deno.readFile(url);
    const ext = rel.slice(rel.lastIndexOf("."));
    return new Response(body, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return new Response("Nicht gefunden", { status: 404 });
  }
}

/**
 * Server starten. Blockiert nicht - `Deno.serve` laeuft im Hintergrund weiter.
 *
 * @param {object} o
 * @param {number} o.port
 * @param {string} o.host
 * @param {URL} o.publicDir      meist `new URL("./public/", import.meta.url)`
 * @param {string} o.titel       nur fuer die Startmeldung im Journal
 * @param {(ws, msg) => void} o.handle       eine eingegangene Nachricht
 * @param {(ws, opt?) => void} o.dropPlayer  Verbindung ist weg
 */
export function starte({ port, host, publicDir, titel, handle, dropPlayer }) {
  const server = Deno.serve({ port, hostname: host }, (req, info) => {
    const url = new URL(req.url);

    if (url.pathname === "/ws" || url.pathname.endsWith("/ws")) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket erwartet", { status: 400 });
      }
      const ip = absender(req, info);
      if (!darfVerbinden(ip)) {
        return new Response("Zu viele Verbindungen", { status: 429 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket._ip = ip;
      // Nur eine offene Verbindung darf beim Schliessen abgezogen werden,
      // sonst zaehlt ein Fehler *und* ein Schliessen doppelt - und die IP
      // sperrt sich mit der Zeit selbst aus.
      let gezaehlt = false;
      const abmelden = () => {
        if (!gezaehlt) return;
        gezaehlt = false;
        verbindungZu(ip);
      };
      socket.onopen = () => { gezaehlt = true; verbindungAuf(ip); };
      socket.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg && typeof msg.t === "string") {
          // Lebenszeichen. Der Client schickt alle 25 s einen `ping`, auch wenn
          // niemand spielt; die Geisterwache in `raum.js` raeumt anhand dieses
          // Stempels Sockets ab, die offen aussehen und keine mehr sind. Hier
          // und nicht im Spiel, damit kein Spiel es vergessen kann.
          if (socket._player) socket._player.lastSeen = Date.now();
          try {
            handle(socket, msg);
          } catch (err) {
            console.error("Fehler beim Verarbeiten:", err);
          }
        }
      };
      socket.onclose = () => { abmelden(); dropPlayer(socket); };
      socket.onerror = () => { abmelden(); dropPlayer(socket); };
      return response;
    }

    return serveStatic(publicDir, url.pathname);
  });

  console.log(`${titel} laeuft auf http://${host}:${port}/`);
  return server;
}

// ══════════════ Gemeinsamer Einstieg ══════════════ Ende ══════════════════
