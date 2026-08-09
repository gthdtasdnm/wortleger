// Die Wortliste – der eigentliche Kern dieses Spiels.
//
// Herkunft: `enz/german-wordlist`, gepflegt fuer das freie Wortspiel Tanglet,
// nach Legespiel-Regeln gefuehrt (keine Eigennamen, keine Abkuerzungen) und
// unter **CC0 1.0** veroeffentlicht, also gemeinfrei. Das ist der Grund fuer
// genau diese Liste und keine andere: bei den Alternativen steht entweder
// Copyleft drauf (igerman98, GPL) oder eine MIT-Angabe ueber Material aus
// Wiktionary, das CC-BY-SA ist. Herkunft und Lizenz stehen in `README.md`.
//
// Aufbereitet wurde sie einmalig:
//   ß -> SS, alles gross, sortiert, ohne Doppelte, und gestrichen wird alles,
//   was sich mit diesem Steinsatz gar nicht legen laesst:
//     163 384 Woerter laenger als 13 – so breit ist das Brett;
//      24 866 Woerter mit Q, X oder Y – dafuer gibt es keinen Stein, und auch
//             der Joker wird nur zu einem Buchstaben, den es gibt;
//       9 195 Doppelte, die erst durch ß->SS und Grossschreibung entstanden.
//   685 789 Zeilen roh -> 488 344 Woerter, 5,4 MB.
// Damit gilt: jedes Wort in dieser Datei ist auch wirklich legbar. `probe.js`
// prueft das nach – die Liste und `steine.js` duerfen nicht auseinanderlaufen.
//
// ── Warum kein Set ──────────────────────────────────────────────────────────
// Gemessen auf diesem Server, gleiche Datei, gleicher Deno:
//
//   new Set(text.split("\n"))   291 ms Start   128 MB RSS
//   dieser Bytepuffer            19 ms Start    62 MB RSS
//
// Der laufende Dienst braucht damit 25 MB (`systemctl show wortleger -p
// MemoryCurrent`) gegenueber 17 MB bei den Spielen ohne Wortliste. Auf einer
// Kiste, die neben elf Spielen auch Nextcloud und zwei Bots traegt, ist der
// Unterschied zum Set je Neustart deutlich – und `Restart=always` startet
// oefter als man denkt. Der Puffer bleibt die rohe UTF-8-Datei; dazu kommt nur eine
// Uint32Array mit den Zeilenanfaengen. Gesucht wird binaer, Byte fuer Byte.
// Eine Abfrage kostet gemessene 1,1 Mikrosekunden – bei hoechstens ein paar
// Woertern je Zug ist das nicht messbar.

const NEUE_ZEILE = 10;

/**
 * Laedt die Wortliste und gibt die Nachschlagefunktion zurueck.
 *
 * @param {URL|string} pfad Datei mit einem Wort je Zeile, sortiert, UTF-8
 * @returns {Promise<{kennt: (wort: string) => boolean, anzahl: number}>}
 */
export async function ladeWoerter(pfad) {
  const bytes = await Deno.readFile(pfad);

  // Zeilenanfaenge einsammeln. Einmal durch die Datei, danach steht die
  // Position jedes Wortes fest und die binaere Suche kann springen.
  let zeilen = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === NEUE_ZEILE) zeilen++;
  }
  const anfang = new Uint32Array(zeilen);
  let n = 0;
  if (bytes.length > 0) anfang[n++] = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === NEUE_ZEILE) anfang[n++] = i + 1;
  }

  const geber = new TextEncoder();

  /** Vergleicht die Zeile bei `start` mit `ziel`: -1, 0 oder 1. */
  function vergleiche(start, ziel) {
    for (let k = 0;; k++) {
      const a = bytes[start + k];
      const b = k < ziel.length ? ziel[k] : -1;
      // Zeilenende und Wortende zugleich: gleich.
      if (a === NEUE_ZEILE || a === undefined) return b === -1 ? 0 : -1;
      if (b === -1) return 1;
      if (a !== b) return a < b ? -1 : 1;
    }
  }

  /**
   * Steht das Wort in der Liste? Erwartet Grossbuchstaben ohne ß – genau die
   * Form, in der das Brett seine Steine fuehrt.
   */
  function kennt(wort) {
    if (typeof wort !== "string" || wort.length < 2) return false;
    const ziel = geber.encode(wort);
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mitte = (lo + hi) >> 1;
      const d = vergleiche(anfang[mitte], ziel);
      if (d === 0) return true;
      if (d < 0) lo = mitte + 1;
      else hi = mitte - 1;
    }
    return false;
  }

  return { kennt, anzahl: n };
}
