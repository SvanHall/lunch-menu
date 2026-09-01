import * as cheerio from "cheerio";
// Imported from the internal path, not the package root: pdf-parse's own
// index.js runs a debug test-harness on import under ESM that tries to read
// a sample PDF from its own package folder and throws ENOENT -- a known bug
// this sidesteps entirely.
import pdf from "pdf-parse/lib/pdf-parse.js";
import { readFile, writeFile } from "node:fs/promises";

const OUTPUT_PATH = new URL("../menu.json", import.meta.url);

const DAYS = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag"];

const RESTAURANTS = [
  {
    id: "bricks",
    name: "Bricks Eatery",
    page: "https://brickseatery.se/lunch/",
    stop: "VÅRA ÖPPETTIDER",
    load: loadHtml,
  },
  {
    id: "eatery",
    name: "Eatery Lund",
    page: "https://eatery.se/anlaggningar/lund",
    stop: "GENERÖS SALLADSBUFFÉ",
    load: loadEatery,
  },
  {
    id: "kantin",
    name: "Kantin Lund",
    page: "https://www.kantinlund.se/",
    stop: "Hitta till",
    load: loadHtml,
  },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Case-insensitive "first index of, searching from a given position" -- used
// to find where a stop word appears after the last day heading, so we know
// where to cut the menu off. Searching forward from that position (rather
// than taking the LAST occurrence anywhere) matters because some pages
// repeat the stop word further down, e.g. in a footer.
function firstIndexAfter(text, needle, from) {
  const re = new RegExp(escapeRegExp(needle), "gi");
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : -1;
}

// The menu pages just list "Måndag ... Tisdag ... Fredag" as plain text with
// no machine-readable structure, so we find each day name and take
// everything up to the next one (or a stop word marking the menu's end).
function splitByDays(text, stopWord) {
  const hits = DAYS.map((day) => {
    const re = new RegExp(day, "i");
    const m = re.exec(text);
    return m ? { day, pos: m.index } : null;
  })
    .filter(Boolean)
    .sort((a, b) => a.pos - b.pos);

  if (hits.length === 0) return {};

  let end = text.length;
  if (stopWord) {
    const cut = firstIndexAfter(text, stopWord, hits[hits.length - 1].pos);
    if (cut !== -1) end = cut;
  }

  const result = {};
  hits.forEach((h, i) => {
    const segEnd = i + 1 < hits.length ? hits[i + 1].pos : end;
    let block = text.slice(h.pos + h.day.length, segEnd).trim();
    block = block.replace(/^[\s:–-]*\d{1,2}\/\d{1,2}\s*/, ""); // e.g. "17/8" after "Måndag"
    result[h.day] = block;
  });
  return result;
}

// A wrapped continuation line starts with a lowercase letter -- a genuine new
// dish always starts with a capital letter in these menus, so lowercase can
// only mean "this is the rest of the previous line".
function mergeWrappedLines(blocks) {
  const merged = [];
  for (const b of blocks) {
    if (merged.length && /^[a-zåäö]/.test(b)) merged[merged.length - 1] += " " + b;
    else merged.push(b);
  }
  return merged;
}

// Both sources lay a day's menu out the same way once split into blocks (by a
// blank line for the HTML pages, by a single line break for the PDF): either
// a "Label 115:-" heading followed by its description, or a single plain
// block with no price at all (Kantin's daily special, Eatery's dishes, or an
// announcement like an apple pie giveaway). Pairing each price heading with
// the block right after it -- instead of grabbing everything up to the next
// price heading -- stops a trailing announcement from bleeding into the
// previous dish.
function splitDishes(text) {
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const priceHead =
    /^([A-ZÅÄÖ][\wåäöÅÄÖ /-]{1,24})\s+(\d{2,3}:-)(?:\s*ink\.?\s*Kaffe\.?)?\s*$/;

  let blocks = (/\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split(/\n+/))
    .map(clean)
    .filter(Boolean);
  blocks = mergeWrappedLines(blocks);

  // Worst case: no line breaks survived at all, so the whole day is one
  // blob. Fall back to Swedish sentence case: each dish starts with exactly
  // one capitalized word followed by lowercase words, so a capitalized word
  // right after another word's lowercase ending marks a new dish. This can
  // mistake a two-capitalized-word proper noun (e.g. "Grana Padano") for a
  // new dish, so short fragments get folded back onto the previous one.
  if (blocks.length === 1 && !priceHead.test(blocks[0])) {
    blocks = blocks[0]
      .split(/(?<=[a-zåäö])\s+(?=[A-ZÅÄÖ][a-zåäö]+(?:\s|$))/)
      .map(clean)
      .filter(Boolean);
    const merged = [];
    for (const b of blocks) {
      const short = b.split(" ").length <= 2 && b.length <= 20;
      if (short && merged.length) merged[merged.length - 1] += " " + b;
      else merged.push(b);
    }
    blocks = merged;
  }

  const dishes = [];
  for (let i = 0; i < blocks.length; i++) {
    const head = blocks[i].match(priceHead);
    if (!head) {
      dishes.push({ label: null, desc: blocks[i] });
      continue;
    }
    const next = blocks[i + 1];
    const desc = next && !priceHead.test(next) ? blocks[++i] : "";
    dishes.push({ label: head[1], price: head[2], desc });
  }
  return dishes;
}

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

async function fetchText(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + url);
  return await res.text();
}

function htmlToText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  return $("body").text().replace(/\n{3,}/g, "\n\n").trim();
}

async function loadHtml(r) {
  const html = await fetchText(r.page);
  return splitByDays(htmlToText(html), r.stop);
}

// Eatery Lund states the menu as a linked PDF rather than page text. Scan
// the page text for any .pdf URL and pick the Swedish one -- the site also
// links an English and a café menu, so those are excluded.
function findMenuPdf(text) {
  const urls = text.match(/https?:\/\/[^\s")]+\.pdf[^\s")]*/gi) || [];
  return urls.find((u) => !/eng|cafe|café/i.test(u)) || null;
}

async function loadEatery(r) {
  const pageHtml = await fetchText(r.page);
  const pdfUrl = findMenuPdf(pageHtml);
  if (!pdfUrl) throw new Error("no pdf link found on page");

  const res = await fetch(pdfUrl, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error("HTTP " + res.status + " fetching pdf");
  const buf = Buffer.from(await res.arrayBuffer());
  const { text } = await pdf(buf);

  return splitByDays(text, r.stop);
}

async function readExisting() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    return { restaurants: {} };
  }
}

async function main() {
  const existing = await readExisting();
  const restaurants = {};

  for (const r of RESTAURANTS) {
    try {
      const days = Object.fromEntries(
        Object.entries(await r.load(r)).map(([day, text]) => [day, splitDishes(text)]),
      );
      if (Object.keys(days).length === 0) throw new Error("no days parsed");

      restaurants[r.id] = { name: r.name, page: r.page, days, updatedAt: new Date().toISOString() };
      console.log(`${r.name}: OK (${Object.keys(days).length} days)`);
    } catch (e) {
      console.error(`${r.name}: FAILED - ${e.message}`);
      // Keep yesterday's data rather than wiping out a working menu because
      // of one bad fetch -- a stale menu beats none at all.
      restaurants[r.id] = existing.restaurants[r.id] ?? {
        name: r.name,
        page: r.page,
        days: {},
      };
    }
  }

  await writeFile(
    OUTPUT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), restaurants }, null, 2) + "\n",
  );
}

main();
