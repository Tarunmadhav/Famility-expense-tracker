// Reading an import file into rows of text: CSV and XLSX, no dependencies.
//
// Loaded on demand (see app.js) so the parser never sits in the first paint.
// Everything here is pure: pass bytes in, get rows out, which is what the tests do.

/** 2 MB is far more than a household ledger needs, and keeps the zip reader simple. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/** Rows excluding the header. Small enough to write in a single D1 transaction. */
export const MAX_IMPORT_ROWS = 500;

export function tooBig(bytes) {
  return bytes > MAX_IMPORT_BYTES;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripBom(text) {
  return String(text).replace(/^\ufeff/, '');
}

/** Pick the delimiter from the first line outside quotes: comma, semicolon or tab. */
export function sniffDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < firstLine.length; i += 1) {
    const c = firstLine[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c in counts) counts[c] += 1;
  }
  const best = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ',');
  return counts[best] ? best : ',';
}

/**
 * Split CSV text into rows. Quoted fields keep their commas, newlines and
 * doubled quotes; CRLF, LF and a lone CR all end a row.
 */
export function parseDelimited(text, delimiter = null) {
  const src = stripBom(text);
  const sep = delimiter || sniffDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === sep) {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // A file that ends with a newline should not gain a ghost row.
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* --------------------------------------------------------------- zip (xlsx) */

function u16(dv, at) {
  return dv.getUint16(at, true);
}

function u32(dv, at) {
  return dv.getUint32(at, true);
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a zip archive into { name: bytes }. XLSX files are zip archives; we only
 * need stored and deflated entries, which is all Excel writes for a workbook.
 */
export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= floor; i -= 1) {
    if (u32(dv, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('That file is not a readable .xlsx (no zip directory found)');
  const count = u16(dv, eocd + 10);
  let at = u32(dv, eocd + 16);
  const files = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > bytes.length || u32(dv, at) !== 0x02014b50) break;
    const method = u16(dv, at + 10);
    const compressedSize = u32(dv, at + 20);
    const nameLen = u16(dv, at + 28);
    const extraLen = u16(dv, at + 30);
    const commentLen = u16(dv, at + 32);
    const offset = u32(dv, at + 42);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (u32(dv, offset) !== 0x04034b50) continue;
    const localName = u16(dv, offset + 26);
    const localExtra = u16(dv, offset + 28);
    const start = offset + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + compressedSize);
    if (method === 0) files[name] = raw;
    else if (method === 8) files[name] = await inflateRaw(raw);
    // Other methods are never used inside a workbook.
  }
  return files;
}

/* -------------------------------------------------------------- xlsx (xml) */

function block(inner, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let m = re.exec(inner);
  while (m) {
    out.push(m[1]);
    m = re.exec(inner);
  }
  return out;
}

function attr(tagText, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[\\s/])${escaped}="([^"]*)"`).exec(String(tagText));
  return m ? decodeEntities(m[1]) : '';
}

function textRuns(xml) {
  return block(xml, 't')
    .map((t) => decodeEntities(t.replace(/<[^>]+>/g, '')))
    .join('');
}

/** "AB12" -> 27 (zero-based column index). */
export function columnIndex(ref) {
  const letters = String(ref).replace(/[^A-Za-z]/g, '').toUpperCase();
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code) {
  const bare = String(code || '')
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  if (/^(general|@|0(\.0+)?|#,##0(\.0+)?)$/i.test(bare.trim())) return false;
  return /[dmy]/i.test(bare) && !/^(hh?:?mm(:?ss)?)$/i.test(bare.trim());
}

/** Which cellXfs index (the `s=` attribute) is a date. */
function dateStyles(stylesXml) {
  const flags = [];
  if (!stylesXml) return flags;
  const custom = {};
  // numFmt entries are self-closing, so read the opening tags rather than blocks.
  const numFmtRe = /<numFmt\s([^>]*)\/?>/g;
  let nm = numFmtRe.exec(stylesXml);
  while (nm) {
    const id = Number(attr(nm[1], 'numFmtId'));
    const code = attr(nm[1], 'formatCode');
    if (id) custom[id] = isDateFormat(code);
    nm = numFmtRe.exec(stylesXml);
  }
  const xfBlock = block(stylesXml, 'cellXfs')[0] || '';
  const xfRe = /<xf\s([^>]*?)(?:\/>|>)/g;
  let xf = xfRe.exec(xfBlock);
  while (xf) {
    const id = Number(attr(xf[1], 'numFmtId'));
    flags.push(BUILTIN_DATE_FORMATS.has(id) || custom[id] === true);
    xf = xfRe.exec(xfBlock);
  }
  return flags;
}

/** Excel keeps dates as days since 1899-12-30; 1900's leap year is why it is not the 31st. */
export function serialToDate(serial) {
  const days = Math.floor(Number(serial));
  if (!Number.isFinite(days)) return '';
  const ms = Date.UTC(1899, 11, 30) + days * 86400000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function firstSheetPath(files) {
  const wb = files['xl/workbook.xml'] ? new TextDecoder().decode(files['xl/workbook.xml']) : '';
  const rels = files['xl/_rels/workbook.xml.rels']
    ? new TextDecoder().decode(files['xl/_rels/workbook.xml.rels'])
    : '';
  const sheet = /<sheet\s([^>]*?)\/?>/.exec(wb);
  if (sheet && rels) {
    const rid = attr(sheet[1], 'r:id') || attr(sheet[1], 'id');
    const relRe = /<Relationship\s([^>]*?)\/?>/g;
    let rel = relRe.exec(rels);
    while (rel) {
      if (attr(rel[1], 'Id') === rid) {
        const target = attr(rel[1], 'Target').replace(/^\/?xl\//, '').replace(/^\.\.\//, '');
        const path = `xl/${target}`.replace(/\/\.\//g, '/');
        if (files[path]) return path;
        const guess = Object.keys(files).find((k) => k.endsWith(target));
        if (guess) return guess;
      }
      rel = relRe.exec(rels);
    }
  }
  const named = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d*\.xml$/.test(k)).sort();
  return named[0] || '';
}

/** Turn the first worksheet of a workbook into rows of text. */
export async function readXlsx(buffer) {
  const files = await unzip(buffer);
  const sheetPath = firstSheetPath(files);
  if (!sheetPath || !files[sheetPath]) throw new Error('That .xlsx has no worksheet in it');
  const dec = new TextDecoder();
  const sheet = dec.decode(files[sheetPath]);
  const shared = files['xl/sharedStrings.xml']
    ? block(dec.decode(files['xl/sharedStrings.xml']), 'si').map(textRuns)
    : [];
  const dates = dateStyles(files['xl/styles.xml'] ? dec.decode(files['xl/styles.xml']) : '');

  const rows = [];
  const rowRe = /<row\s([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm = rowRe.exec(sheet);
  while (rm) {
    const inner = rm[2] || '';
    const cells = [];
    const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm = cellRe.exec(inner);
    while (cm) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const ref = attr(attrs, 'r');
      const type = attr(attrs, 't');
      const style = Number(attr(attrs, 's') || -1);
      const at = ref ? columnIndex(ref) : cells.length;
      let value = '';
      if (type === 'inlineStr') {
        value = textRuns(block(body, 'is')[0] || body);
      } else {
        const v = block(body, 'v')[0];
        const raw = v == null ? '' : decodeEntities(v);
        if (type === 's') value = shared[Number(raw)] || '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e') value = raw;
        else if (/^-?\d+(\.\d+)?$/.test(raw) && dates[style]) value = serialToDate(Number(raw));
        else value = raw;
      }
      cells[at] = value;
      cm = cellRe.exec(inner);
    }
    while (cells.length && (cells[cells.length - 1] == null || cells[cells.length - 1] === '')) cells.pop();
    if (cells.some((c) => String(c == null ? '' : c).trim() !== '')) {
      rows.push(Array.from(cells, (c) => (c == null ? '' : String(c))));
    }
    rm = rowRe.exec(sheet);
  }
  return rows;
}

/**
 * Read the picked file into rows. Throws a readable Error for anything the
 * reader cannot handle, so the caller can show the reason instead of nothing.
 */
/**
 * An .xlsx is a zip archive, so it starts with "PK". A workbook saved with a
 * .csv name (or renamed by a download manager) must still be read as a workbook
 * instead of being turned into one column of binary noise.
 */
export function looksLikeZip(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return (bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06);
}

export async function readImportFile(file) {
  if (!file) throw new Error('No file chosen');
  if (tooBig(file.size)) {
    throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${MAX_IMPORT_BYTES / 1048576} MB`);
  }
  const name = String(file.name || '');
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer()).slice(0, 4);
  const isXlsx = looksLikeZip(head) || /\.(xlsx|xlsm)$/i.test(name) || /spreadsheetml/i.test(file.type || '');
  const rows = isXlsx ? await readXlsx(await file.arrayBuffer()) : parseDelimited(await file.text());
  if (!rows.length) throw new Error('That file is empty');
  return { rows, isXlsx };
}
