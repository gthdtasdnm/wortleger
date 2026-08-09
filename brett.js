// Das Brett: 13x13 Felder und wo die Boni liegen.
//
// Eigenes Muster. Das Feldmuster eines bekannten Legespiels ist dessen
// Aussehen und damit geschuetzt – die Regel „doppelter Buchstabe, dreifaches
// Wort“ ist es nicht. Deshalb steht hier eine eigene Anordnung:
//
//   * Vier dreifache Woerter, und zwar in der Mitte jeder Kante, nicht in den
//     Ecken. Wer sie will, muss sich vom Zentrum bis an den Rand vorarbeiten.
//   * Die Ecken sind doppelte Woerter. Ein Wort quer durch die Ecke trifft
//     nie zwei davon – die Diagonale ist bewusst leer geblieben.
//   * Um den Stern liegt ein Kranz aus vier doppelten Buchstaben. Damit lohnt
//     sich der Eroeffnungszug, ohne dass er die Partie entscheidet: die vier
//     dreifachen Buchstaben liegen drei Felder weiter aussen.
//
// 13 statt 15 Felder: auf einem Handy sind 15 Spalten nebeneinander nicht mehr
// zu treffen, und eine Partie zu viert dauert sonst laenger als ein Abend.
//
// Das Muster ist punktsymmetrisch *und* spiegelsymmetrisch zur Diagonale –
// waagerecht zu legen bringt also genau so viel wie senkrecht. `probe.js`
// rechnet das nach, statt es zu glauben.

export const GROESSE = 13;

/** Mitte des Bretts. Das erste Wort der Partie muss hier durch. */
export const MITTE = 6;

/**
 * Zeichen im Muster:
 *   .  gewoehnliches Feld
 *   d  doppelter Buchstabe
 *   t  dreifacher Buchstabe
 *   D  doppeltes Wort
 *   T  dreifaches Wort
 *   *  der Stern in der Mitte, zaehlt wie ein doppeltes Wort
 */
export const MUSTER = [
  "D..t..T..t..D",
  "..d.......d..",
  ".d..D...D..d.",
  "t.....t.....t",
  "..D..d.d..D..",
  "....d.d.d....",
  "T..t.d*d.t..T",
  "....d.d.d....",
  "..D..d.d..D..",
  "t.....t.....t",
  ".d..D...D..d.",
  "..d.......d..",
  "D..t..T..t..D",
];

/** Bonus eines Feldes als Zeichen aus MUSTER, "." wenn keiner. */
export function bonusAn(r, c) {
  return MUSTER[r][c];
}

/** Faktor, mit dem ein *neu gelegter* Stein auf diesem Feld zaehlt. */
export function buchstabenFaktor(zeichen) {
  if (zeichen === "d") return 2;
  if (zeichen === "t") return 3;
  return 1;
}

/** Faktor, mit dem ein Wort ueber dieses *neu belegte* Feld zaehlt. */
export function wortFaktor(zeichen) {
  if (zeichen === "D" || zeichen === "*") return 2;
  if (zeichen === "T") return 3;
  return 1;
}

/** Liegt (r,c) ueberhaupt auf dem Brett? */
export function aufDemBrett(r, c) {
  return Number.isInteger(r) && Number.isInteger(c) &&
    r >= 0 && r < GROESSE && c >= 0 && c < GROESSE;
}

/** Ein leeres Brett: GROESSE x GROESSE Felder, alle `null`. */
export function leeresBrett() {
  return Array.from({ length: GROESSE }, () => new Array(GROESSE).fill(null));
}
