// Die Steine: welche Buchstaben es gibt, wie oft und was sie zaehlen.
//
// Eigene Verteilung, eigene Werte – nicht abgeschrieben. „Scrabble“ ist Marke
// von Mattel/Hasbro; die Regeln eines Legespiels sind frei, die Zahlentabelle
// eines bestimmten Spiels ist Teil seines Aussehens. Diese hier ist an der
// Buchstabenhaeufigkeit des Deutschen gebaut und dann von Hand gerundet.
//
// Drei Entscheidungen, die nicht auf der Hand liegen:
//
//   Kein ß. In Grossbuchstaben schreibt man STRASSE, nicht STRAßE – die
//   Wortliste ist genau so normalisiert. Ein ß-Stein waere ein Stein, mit dem
//   man kein einziges Wort der Liste legen kann.
//
//   Kein Q, X, Y. Zusammen kommen sie im Deutschen auf keine 0,1 %. Auf 13x13
//   mit sieben Steinen auf dem Brett blockiert so ein Stein ein Regal die
//   halbe Partie, statt Punkte zu bringen. Wer sie vermisst, nimmt den Joker.
//
//   Der Wert richtet sich danach, wie leicht sich ein Buchstabe *unterbringen*
//   laesst, nicht allein danach, wie oft er vorkommt. Deshalb zaehlt H nur 2,
//   obwohl es viermal im Beutel liegt: es passt fast ueberall hinein.

/** Der Joker. Traegt keinen Wert und wird beim Legen zu einem Buchstaben. */
export const JOKER = "?";

/** So viele Steine hat jeder auf dem Regal. */
export const REGAL = 7;

/** Alle sieben Steine in einem Zug gelegt – das ist die Kunst, also Zuschlag. */
export const BINGO = 40;

/** Buchstabe, Anzahl im Beutel, Wert. Reihenfolge: haeufig zuerst. */
export const VERTEILUNG = [
  ["E", 11, 1],
  ["N", 8, 1],
  ["S", 6, 1],
  ["I", 6, 1],
  ["R", 5, 1],
  ["A", 5, 1],
  ["T", 4, 1],
  ["D", 4, 1],
  ["H", 4, 2],
  ["U", 3, 2],
  ["G", 3, 2],
  ["L", 3, 2],
  ["O", 3, 2],
  ["M", 3, 3],
  ["B", 2, 3],
  ["W", 2, 3],
  ["F", 2, 4],
  ["C", 2, 4],
  ["K", 1, 4],
  ["P", 1, 4],
  ["Z", 1, 5],
  ["V", 1, 6],
  ["Ä", 1, 6],
  ["Ü", 1, 6],
  ["J", 1, 8],
  ["Ö", 1, 8],
  [JOKER, 2, 0],
];

/** Buchstabe -> Wert. Der Joker steht mit 0 drin. */
export const WERT = Object.fromEntries(VERTEILUNG.map(([b, , w]) => [b, w]));

/** Alle legbaren Buchstaben ohne Joker – der Client baut daraus die Jokerwahl. */
export const BUCHSTABEN = VERTEILUNG.map(([b]) => b).filter((b) => b !== JOKER);

/** Wie viele Steine insgesamt im Beutel liegen. */
export const STEINE_GESAMT = VERTEILUNG.reduce((s, [, n]) => s + n, 0);

/** Ein voller, ungemischter Beutel. Das Mischen macht der Aufrufer. */
export function neuerBeutel() {
  const beutel = [];
  for (const [b, anzahl] of VERTEILUNG) {
    for (let i = 0; i < anzahl; i++) beutel.push(b);
  }
  return beutel;
}

/**
 * Was die Steine auf einem Regal zusammen wert sind. Am Ende der Partie zieht
 * sich das jeder von seinem Punktestand ab.
 */
export function regalWert(steine) {
  return steine.reduce((s, b) => s + (WERT[b] ?? 0), 0);
}
