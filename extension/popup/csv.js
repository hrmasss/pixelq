function detectDelimiter(lines) {
  const sample = lines.slice(0, 5).join("\n");
  const options = [",", ";", "\t", "|"];
  let best = ",";
  let bestScore = -1;

  for (const delimiter of options) {
    const score = sample.split(delimiter).length;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }

  return best;
}

function splitRow(line, delimiter) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
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

export function parseCSV(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return { headers: [], rows: [], delimiter: "," };
  }

  const delimiter = detectDelimiter(lines);
  const [headerLine, ...bodyLines] = lines;
  const headers = splitRow(headerLine, delimiter).map((header, index) => header || `column_${index + 1}`);
  const rows = bodyLines.map((line, rowIndex) => {
    const values = splitRow(line, delimiter);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    row.__rowNumber = rowIndex + 2;
    return row;
  });

  return { headers, rows, delimiter };
}
