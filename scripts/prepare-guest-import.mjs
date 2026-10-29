import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_HEADERS = ['Name', '人數', '分類', '喜餅', '確認', '素食', '備註'];
export const GUEST_HEADERS = ['賓客ID', '顯示姓名', '新郎/新娘方', '桌號', '備註'];

export function parseCsv(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV 有未關閉的雙引號');
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function safeSheetText(value) {
  const text = String(value ?? '').trim();
  return /^[=+@-]/.test(text) ? `'${text}` : text;
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLocaleLowerCase('zh-TW');
}

export function prepareGuestImport(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw new Error('CSV 沒有資料');

  const headers = rows[0].map(value => String(value || '').trim());
  const duplicateHeaders = headers.filter((header, index) => header && headers.indexOf(header) !== index);
  if (duplicateHeaders.length) throw new Error(`CSV 欄位重複：${[...new Set(duplicateHeaders)].join('、')}`);

  const missingHeaders = SOURCE_HEADERS.filter(header => !headers.includes(header));
  if (missingHeaders.length) throw new Error(`CSV 缺少欄位：${missingHeaders.join('、')}`);

  const index = Object.fromEntries(headers.map((header, column) => [header, column]));
  const guests = [];
  const seen = new Map();
  const duplicateGuests = [];
  const categories = new Map();
  const confirmations = new Map();
  let excludedNotAttending = 0;

  rows.slice(1).forEach((sourceRow, offset) => {
    if (sourceRow.every(value => String(value || '').trim() === '')) return;
    const sourceLine = offset + 2;
    const confirmation = String(sourceRow[index['確認']] || '').trim() || '(空白)';
    confirmations.set(confirmation, (confirmations.get(confirmation) || 0) + 1);
    if (confirmation === '不參加') {
      excludedNotAttending++;
      return;
    }

    const name = String(sourceRow[index.Name] || '').trim();
    const category = String(sourceRow[index['分類']] || '').trim();
    if (!name) throw new Error(`第 ${sourceLine} 列缺少 Name`);
    if (!category) throw new Error(`第 ${sourceLine} 列缺少 分類`);

    const identity = `${normalizeName(name)}\u0000${category}`;
    if (seen.has(identity)) duplicateGuests.push({ name, category, lines: [seen.get(identity), sourceLine] });
    else seen.set(identity, sourceLine);

    categories.set(category, (categories.get(category) || 0) + 1);

    guests.push([
      '',
      safeSheetText(name),
      safeSheetText(category),
      '',
      safeSheetText(sourceRow[index['備註']] || ''),
    ]);
  });

  return {
    rows: [GUEST_HEADERS, ...guests],
    summary: {
      sourceRows: rows.length - 1,
      guestRows: guests.length,
      excludedNotAttending,
      duplicateGuests,
      categories: Object.fromEntries(categories),
      confirmations: Object.fromEntries(confirmations),
    },
  };
}

export function serializeCsv(rows) {
  const escape = value => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `\uFEFF${rows.map(row => row.map(escape).join(',')).join('\r\n')}\r\n`;
}

export async function writeGuestImport(inputPath, outputPath) {
  const source = await fs.readFile(inputPath, 'utf8');
  const result = prepareGuestImport(source);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, serializeCsv(result.rows), 'utf8');
  return result.summary;
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    throw new Error('用法：node scripts/prepare-guest-import.mjs <來源.csv> <輸出.csv>');
  }
  const summary = await writeGuestImport(path.resolve(inputPath), path.resolve(outputPath));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
