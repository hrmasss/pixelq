import type { CsvRow } from "../types";

function detectDelimiter(lines: string[]) {
  const sample = lines.slice(0, 5).join("\n");
  const options = [",", ";", "\t", "|"];
  let best = ",";
  let score = -1;

  for (const delimiter of options) {
    const next = sample.split(delimiter).length;
    if (next > score) {
      score = next;
      best = delimiter;
    }
  }

  return best;
}

function splitCsvRow(line: string, delimiter: string) {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

export function parseCSV(text: string) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] as CsvRow[] };

  const delimiter = detectDelimiter(lines);
  const [headerLine, ...bodyLines] = lines;
  const headers = splitCsvRow(headerLine, delimiter).map((header, index) => header || `column_${index + 1}`);
  const rows = bodyLines.map((line, rowIndex) => {
    const values = splitCsvRow(line, delimiter);
    const row: CsvRow = { __rowNumber: rowIndex + 2 };
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });

  return { headers, rows };
}
