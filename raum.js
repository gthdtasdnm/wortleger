// ══════════════ Gemeinsame Raumverwaltung ══════════════ Anfang ═══════════
// ERZEUGT - NICHT HIER AENDERN. Quelle: /var/www/html/gemeinsam/raum.js
// Aendern, dann `node werkzeug/verteilen.mjs --nur <spiel>` - Spiel fuer
// Spiel, mit `deno task probe` dazwischen. Kein Build-Schritt, keine
// Abhaengigkeit: jedes Spiel behaelt seine eigene vollstaendige Kopie.
//
// Was hier drin ist, war in jedem Server-Spiel wortgleich noch einmal
// abgetippt: Raumcode, Host, Bereit-Zustand, Karenzzeit beim Verbindungs-
// abbruch, oeffentliche Raumliste, Senden an einen oder alle.
//
// Was NICHT hier drin ist: die Runde. Alles, was ein Spiel zu einem Spiel
// macht, bleibt in seinem server.js. Dieses Modul kennt keine Runden, keine
// Punkte und keine Karten - es reicht dafuer Haken durch.
// ──────────────────────────────────────────────────────────────────────────

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const token = () => crypto.randomUUID();

export function cleanName(raw) {
  // Steuerzeichen raus, sonst zerlegt ein Zeilenumbruch im Namen das Layout.
  // Die Regex steht bewusst mit \u-Escapes da - als rohe Zeichen geschrieben
  // landen echte Steuerzeichen in dieser Datei.
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return s.slice(0, 12) || "Spieler";
}

export function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * Legt die Raumverwaltung fuer ein Spiel an.
 *
 * Pflicht sind nur `maxPlayers`, `minPlayers` und `einstellungen`. Alle Haken
 * sind freiwillig; wer keinen angibt, bekommt das Verhalten von „Wer am
 * ehesten" - dem Spiel, aus dem dieser Code stammt.
 *
 * @param {object} o
 * @param {number} o.maxPlayers        obere Grenze, gilt auch fuer die Raumliste
 * @param {number} o.minPlayers        untere Grenze, geht in roomState mit
 * @param {object} o.einstellungen     Vorgabe je Raum (wird flach kopiert)
 * @param {number} [o.roomIdleMs]      leerer Raum wird danach abgeraeumt
 * @param {number} [o.seatGraceMs]     so lange bleibt ein Platz nach Abbruch
 * @param {() => object} [o.raumfelder]        zusaetzliche Felder je Raum
 * @param {() => object} [o.spielerfelder]     zusaetzliche Felder je Spieler
 * @param {(room) => object} [o.zustandZusatz] zusaetzliche Felder in roomState
 * @param {(room) => object} [o.listeneintrag] zusaetzliche Felder in der Liste
 * @param {(room, player) => void} [o.beimBeitritt]  nach dem Verbinden
 * @param {(room, player) => void} [o.beimVerlassen] Abbruch, vor pushState
 * @param {(room, player) => void} [o.nachVerlassen] Abbruch, nach pushState
 * @param {(room, id) => void} [o.beimPlatzfrei]     Platz ist endgueltig weg
 * @param {(room) => void} [o.zurueckZurLobby]       letzte Person ist raus
 */
export function raumverwaltung({
  maxPlayers,
  minPlayers,
  einstellungen,
  roomIdleMs = 5 * 60_000,
  seatGraceMs = 60_000,
  raumfelder = () => ({}),
  spielerfelder = () => ({}),
  zustandZusatz = () => ({}),
  listeneintrag = () => ({}),
  beimBeitritt = () => {},
  beimVerlassen = () => {},
  nachVerlassen = () => {},
  beimPlatzfrei = () => {},
  zurueckZurLobby = () => {},
}) {
  /** code -> Raum */
  const rooms = new Map();
  /** Sockets, die noch in keinem Raum sind und die Liste sehen wollen. */
  const browsing = new Set();

  function newCode() {
    for (let i = 0; i < 500; i++) {
      let c = "";
      for (let k = 0; k < 4; k++) {
        c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!rooms.has(c)) return c;
    }
    return "R" + Date.now().toString(36).slice(-3).toUpperCase();
  }

  function createRoom(isPublic) {
    const room = {
      code: newCode(),
      isPublic: !!isPublic,
      phase: "lobby",
      hostId: null,
      players: new Map(),
      settings: { ...einstellungen },
      rundeNr: 0,
      aktuell: null,
      timers: new Set(),
      idleTimer: null,
      lastActivity: Date.now(),
      ...raumfelder(),
    };
    rooms.set(room.code, room);
    return room;
  }

  function scheduleIdleClose(room) {
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => {
      if (room.players.size === 0) destroyRoom(room);
    }, roomIdleMs);
  }

  function cancelIdleClose(room) {
    if (room.idleTimer) { clearTimeout(room.idleTimer); room.idleTimer = null; }
  }

  function clearTimers(room) {
    for (const id of room.timers) clearTimeout(id);
    room.timers.clear();
  }

  function destroyRoom(room) {
    clearTimers(room);
    cancelIdleClose(room);
    for (const p of room.players.values()) {
      if (p.dropTimer) clearTimeout(p.dropTimer);
    }
    rooms.delete(room.code);
    pushRoomList();
  }

  function ensureHost(room) {
    const current = room.players.get(room.hostId);
    if (current?.connected) return;
    const all = [...room.players.values()];
    const next = all.find((p) => p.connected) ?? all[0];
    room.hostId = next ? next.id : null;
  }

  const anwesende = (room) =>
    [...room.players.values()].filter((p) => p.connected);

  // -------------------------------------------------------------------------
  // Senden
  // -------------------------------------------------------------------------

  function send(player, msg) {
    const ws = player.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch { /* Verbindung stirbt gleich sowieso */ }
    }
  }

  function raw(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch { /* egal */ }
    }
  }

  function broadcast(room, msg) {
    for (const p of room.players.values()) send(p, msg);
  }

  function publicPlayers(room) {
    return [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      punkte: p.punkte,
      ready: p.ready,
      connected: p.connected,
      host: p.id === room.hostId,
    }));
  }

  function roomState(room) {
    return {
      t: "room",
      code: room.code,
      isPublic: room.isPublic,
      phase: room.phase,
      hostId: room.hostId,
      settings: room.settings,
      players: publicPlayers(room),
      rundeNr: room.rundeNr,
      maxPlayers,
      minPlayers,
      ...zustandZusatz(room),
    };
  }

  function pushState(room) {
    broadcast(room, roomState(room));
    if (room.isPublic) pushRoomList();
  }

  function roomList() {
    return [...rooms.values()]
      .map((r) => ({ room: r, count: anwesende(r).length }))
      .filter(({ room, count }) =>
        room.isPublic && room.phase === "lobby" &&
        count > 0 && room.players.size < maxPlayers
      )
      .map(({ room, count }) => ({
        code: room.code,
        host: room.players.get(room.hostId)?.name ?? "?",
        count,
        max: maxPlayers,
        ...listeneintrag(room),
      }))
      .sort((a, b) => b.count - a.count);
  }

  function pushRoomList() {
    const msg = { t: "rooms", rooms: roomList() };
    for (const ws of browsing) raw(ws, msg);
  }

  // -------------------------------------------------------------------------
  // Kommen und Gehen
  // -------------------------------------------------------------------------

  function makePlayer(name, ready) {
    return {
      id: token(),
      token: token(),
      name: cleanName(name),
      ws: null,
      dropTimer: null,
      punkte: 0,
      ready,
      connected: true,
      ...spielerfelder(),
    };
  }

  function attach(ws, room, player) {
    browsing.delete(ws);
    cancelIdleClose(room);
    if (player.dropTimer) { clearTimeout(player.dropTimer); player.dropTimer = null; }
    ws._room = room;
    ws._player = player;
    player.ws = ws;
    player.connected = true;
    ensureHost(room);
    send(player, {
      t: "joined",
      you: player.id,
      token: player.token,
      code: room.code,
    });
    send(player, roomState(room));
    beimBeitritt(room, player);
  }

  /**
   * Verbindung weg. In der Lobby ist der Platz sofort frei; in einer laufenden
   * Partie bleibt er `seatGraceMs` lang stehen, damit ein Netzwechsel oder ein
   * Neuladen nicht aus der Runde wirft.
   */
  function dropPlayer(ws, { immediate = false } = {}) {
    const room = ws._room;
    const player = ws._player;
    browsing.delete(ws);
    if (!room || !player) return;
    ws._room = null;
    ws._player = null;

    player.connected = false;
    player.ws = null;
    player.ready = false;

    if (immediate || room.phase === "lobby") {
      releaseSeat(room, player.id);
      return;
    }

    if (player.dropTimer) clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => releaseSeat(room, player.id), seatGraceMs);

    ensureHost(room);
    // Zwei Haken, und die Reihenfolge ist Absicht: erst den Zustand richtig
    // stellen (die Stimme der Person zaehlt nicht mehr mit), dann den neuen
    // Raumzustand schicken, dann die Runde nachziehen - denn die kann sich
    // durch den Abgang bereits aufloesen und schickt dann selbst.
    beimVerlassen(room, player);
    pushState(room);
    nachVerlassen(room, player);
    pushRoomList();
  }

  function releaseSeat(room, id) {
    const player = room.players.get(id);
    if (!player) return;
    if (player.dropTimer) { clearTimeout(player.dropTimer); player.dropTimer = null; }
    room.players.delete(id);
    ensureHost(room);

    if (room.players.size === 0) {
      zurueckZurLobby(room);
      scheduleIdleClose(room);
      pushRoomList();
      return;
    }

    beimPlatzfrei(room, id);

    pushState(room);
    pushRoomList();
  }

  /** Raeume abraeumen, in denen seit zehn Minuten niemand mehr war. */
  function starteAufraeumen(intervall = 60_000) {
    return setInterval(() => {
      const now = Date.now();
      for (const room of rooms.values()) {
        if (!anwesende(room).length && now - room.lastActivity > 10 * 60_000) {
          destroyRoom(room);
        }
      }
    }, intervall);
  }

  return {
    rooms, browsing, maxPlayers, minPlayers,
    newCode, createRoom, destroyRoom,
    scheduleIdleClose, cancelIdleClose, clearTimers,
    ensureHost, anwesende,
    send, raw, broadcast,
    publicPlayers, roomState, pushState, roomList, pushRoomList,
    makePlayer, attach, dropPlayer, releaseSeat,
    starteAufraeumen,
  };
}

// ══════════════ Gemeinsame Raumverwaltung ══════════════ Ende ═════════════
