// Every case here is a real file name or tag from a real library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookTitle, cleanName, firstAuthor, nameKey, parseName, parseSeries, parseSeriesLabel, safeSegment, seriesKey, stripPartNumber } from "../server/naming.ts";

test("titles lose series and edition noise, but keep what tells editions apart", () => {
  assert.equal(bookTitle("Hunger Games #2: Catching Fire"), "Catching Fire");
  assert.equal(bookTitle("Dungeon Crawler Carl, Book 2 - Carl's Doomsday Scenario"), "Carl's Doomsday Scenario");
  assert.equal(bookTitle("The Wishing Spell: The Land of Stories, Book 1"), "The Wishing Spell");
  assert.equal(bookTitle("A Parade of Horribles: Dungeon Crawler Carl, Book 8"), "A Parade of Horribles");
  assert.equal(bookTitle("The Lost World - Book Two in the Jurassic Park Series"), "The Lost World");
  assert.equal(bookTitle("Airframe: A Novel"), "Airframe");
  assert.equal(bookTitle("The Ballad of Songbirds and Snakes: A Hunger Games Novel"), "The Ballad of Songbirds and Snakes");
  assert.equal(bookTitle("The Kissing Bug: A True Story of a Family, an Insect, and a Nation’s Neglect of a Deadly Disease"), "The Kissing Bug");
  assert.equal(bookTitle("Artemis (Unabridged)"), "Artemis");
  assert.equal(bookTitle("Harry Potter and the Philosopher’s Stone (Full-Cast Edition) (Unabridged)"), "Harry Potter and the Philosopher's Stone (Full-Cast Edition)");
  assert.equal(bookTitle("Diary of a Wimpy Kid 01 - Diary of a Wimpy Kid"), "Diary of a Wimpy Kid");
  // Not a series number.
  assert.equal(bookTitle("Fahrenheit 451"), "Fahrenheit 451");
  assert.equal(bookTitle("Catch-22"), "Catch-22");
});

test("the first real author, not the narrator", () => {
  assert.equal(firstAuthor("John Green, Kate Rudd", ["Kate Rudd"]), "John Green");
  assert.equal(firstAuthor("Michael Crichton/Scott Brick", ["Scott Brick"]), "Michael Crichton");
  assert.equal(firstAuthor("Bonnie Jo Campbell, Susan Bennett", ["Susan Bennett"]), "Bonnie Jo Campbell");
  // Authors reading their own books still count.
  assert.equal(firstAuthor("Barbara Kingsolver", ["Barbara Kingsolver"]), "Barbara Kingsolver");
  assert.equal(firstAuthor("King, Stephen"), "Stephen King");
  assert.equal(firstAuthor("Narrator Frankie Corzo"), null);
  assert.equal(firstAuthor("Unknown Artist"), null);
  assert.equal(firstAuthor(undefined), null);
});

test("file and folder names", () => {
  assert.deepEqual(pick(parseName("Suzanne Collins - Catching Fire.m4b")), ["Suzanne Collins", "Catching Fire"]);
  assert.deepEqual(pick(parseName("Andy Weir - Project Hail Mary  - Project Hail Mary.m4b")), ["Andy Weir", "Project Hail Mary"]);
  assert.deepEqual(pick(parseName("Mayci Neeley -   - Told You So.mp3")), ["Mayci Neeley", "Told You So"]);
  assert.deepEqual(pick(parseName("The Thursday Murder Club by Richard Osman.m4b")), ["Richard Osman", "The Thursday Murder Club"]);
  assert.deepEqual(pick(parseName("It (2016) (Stephen King) {ASIN.B019WPM4ZM} [H2OKing]")), ["Stephen King", "It"]);
  assert.deepEqual(pick(parseName("John Green - The Fault in Our Stars (Read by Kate Rudd) {B09VQ572P3}")), ["John Green", "The Fault in Our Stars"]);
  assert.equal(parseName("John Green - The Fault in Our Stars (Read by Kate Rudd) {B09VQ572P3}").narrator, "Kate Rudd");
  assert.equal(parseName("2011 - Once Upon a River").title, "Once Upon a River");
  assert.equal(parseName("2011 - Once Upon a River").year, "2011");
  assert.equal(parseName("Where the Crawdads Sing [1405543043].m4b").title, "Where the Crawdads Sing");
  // An edition in brackets isn't an author.
  assert.equal(parseName("Harry Potter and the Philosopher's Stone (Full-Cast Edition).m4b").author, undefined);
  assert.equal(parseName("01 Dune.m4b").title, "Dune");
  assert.equal(cleanName("Life_Of_Pi_by_Yann_Martel_(96_kbps_chapterized)"), "Life Of Pi by Yann Martel (96 kbps chapterized)");
});

test("part numbers come off, and real names are safe on any disk", () => {
  assert.equal(stripPartNumber("Once Upon a River (2011) - pt01"), "Once Upon a River (2011)");
  assert.equal(stripPartNumber("Children of Time - 021"), "Children of Time");
  assert.equal(stripPartNumber("The Lost World - Part 01"), "The Lost World");
  assert.equal(safeSegment("Diary of a Wimpy Kid: Big Shot"), "Diary of a Wimpy Kid - Big Shot");
  assert.equal(safeSegment("../../etc/passwd"), "etc passwd");
  assert.equal(safeSegment(".."), "Unknown");
  assert.equal(safeSegment("Who? What/When"), "Who What When");
  assert.equal(nameKey("Daisy Hernández"), nameKey("daisy hernandez"));
  assert.equal(nameKey("J.K. Rowling"), nameKey("J K Rowling"));
});

test("series named inside titles", () => {
  const s = (t: string) => {
    const r = parseSeries(t);
    return r && [r.name, r.sequence];
  };
  assert.deepEqual(s("Dungeon Crawler Carl, Book 2 - Carl's Doomsday Scenario"), ["Dungeon Crawler Carl", "2"]);
  assert.deepEqual(s("The Gate of the Feral Gods: Dungeon Crawler Carl, Book 4"), ["Dungeon Crawler Carl", "4"]);
  assert.deepEqual(s("A Parade of Horribles: Dungeon Crawler Carl, Book 8"), ["Dungeon Crawler Carl", "8"]);
  assert.deepEqual(s("Hunger Games #2: Catching Fire"), ["Hunger Games", "2"]);
  assert.deepEqual(s("Diary of a Wimpy Kid 16 - Diary of a Wimpy Kid: Big Shot"), ["Diary of a Wimpy Kid", "16"]);
  assert.deepEqual(s("Diary of a Wimpy Kid 01 - Diary of a Wimpy Kid"), ["Diary of a Wimpy Kid", "1"]);
  assert.deepEqual(s("The Wishing Spell: The Land of Stories, Book 1"), ["The Land of Stories", "1"]);
  assert.deepEqual(s("The Lost World - Book Two in the Jurassic Park Series"), ["Jurassic Park", "2"]);
  // Not series.
  assert.equal(s("Project Hail Mary"), null);
  assert.equal(s("Fahrenheit 451"), null);
  assert.equal(s("Airframe: A Novel"), null);
  assert.equal(s("Tuesdays with Morrie"), null);
  assert.deepEqual(parseSeriesLabel("Dungeon Crawler Carl #1"), { name: "Dungeon Crawler Carl", sequence: "1" });
  assert.deepEqual(parseSeriesLabel("Dune"), { name: "Dune", sequence: null });
  assert.equal(seriesKey("The Hunger Games"), seriesKey("Hunger Games"));
});

function pick(p: { author?: string; title?: string }) {
  return [p.author, p.title];
}
