/** 区切り行の各セルの形式（`---` / `:---` / `---:` / `:---:`） */
const DELIMITER_CELL_PATTERN = /^:?-+:?$/;

/** フェンスドコードブロックの開始/終了行（3スペースまでのインデントを許容） */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** セル内改行を表す`<br>`系タグ（前後の空白ごと置換する） */
const LINE_BREAK_TAG_PATTERN = /\s*<br\s*\/?>\s*/gi;

/** インデントコードブロックとみなすインデント幅 */
const INDENTED_CODE_WIDTH = 4;

/**
 * Markdown文字列から唯一のテーブル（GFM形式）を読み取る
 *
 * ヘッダ行を先頭とし、データ行を続けた2次元配列を返す（区切り行は含まない）。
 * テーブル外の見出し・本文・コードブロックは無視する。
 * チェック項目の黙った欠落を防ぐため、テーブルが複数存在する場合はエラーとする。
 */
export function parseMarkdownTable(markdown: string): string[][] {
  if (markdown.trim() === '') {
    throw new Error('Markdown checklist must not be empty');
  }

  const lines = markdown
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const tables: string[][][] = [];
  let fence: { char: string; length: number } | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // フェンスドコードブロック内はテーブルとして解釈しない
    if (fence !== null) {
      if (isFenceClose(line, fence)) {
        fence = null;
      }
      i++;
      continue;
    }
    const fenceOpen = matchFenceOpen(line);
    if (fenceOpen !== null) {
      fence = fenceOpen;
      i++;
      continue;
    }

    const header = parseHeaderRow(line, lines[i + 1]);
    if (header === null) {
      i++;
      continue;
    }

    // ヘッダ行・区切り行の後に続くデータ行を読み取る
    const rows: string[][] = [header];
    i += 2;
    while (i < lines.length && isTableRowLine(lines[i]!)) {
      const cells = normalizeRowLength(splitRow(lines[i]!), header.length);
      if (cells.some((cell) => cell !== '')) {
        rows.push(cells);
      }
      i++;
    }
    tables.push(rows);
  }

  if (tables.length === 0) {
    throw new Error('Markdown checklist must contain a table (header row and delimiter row)');
  }
  if (tables.length > 1) {
    throw new Error(`Markdown checklist must contain exactly one table, found ${tables.length}`);
  }
  return tables[0]!;
}

/**
 * ヘッダ行候補と次行（区切り行候補）からテーブルのヘッダを判定する
 * テーブルの開始でない場合はnullを返す
 */
function parseHeaderRow(line: string, nextLine: string | undefined): string[] | null {
  if (nextLine === undefined) return null;
  if (!line.includes('|') || isIndentedCode(line) || isIndentedCode(nextLine)) return null;

  const header = splitRow(line);
  const delimiter = splitRow(nextLine);
  if (header.length !== delimiter.length) return null;
  if (!delimiter.every((cell) => DELIMITER_CELL_PATTERN.test(cell))) return null;
  return header;
}

/**
 * テーブルのデータ行として継続する行か判定する
 * 空行・パイプを含まない行・フェンス開始行でテーブルは終了する
 */
function isTableRowLine(line: string): boolean {
  return line.trim() !== '' && line.includes('|') && matchFenceOpen(line) === null;
}

/**
 * テーブル行をセルに分割する
 * 先頭・末尾のパイプは任意。`\|`はセル区切りではなくリテラルの`|`として扱う
 */
function splitRow(line: string): string[] {
  let content = line.trim();
  if (content.startsWith('|')) {
    content = content.slice(1);
  }
  if (content.endsWith('|') && !content.endsWith('\\|')) {
    content = content.slice(0, -1);
  }

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    if (char === '\\' && content[i + 1] === '|') {
      current += '|';
      i++;
    } else if (char === '|') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);

  return cells.map(normalizeCell);
}

/**
 * セル値を正規化する（`<br>`系タグを改行に変換し、前後の空白を除去）
 */
function normalizeCell(cell: string): string {
  return cell.replace(LINE_BREAK_TAG_PATTERN, '\n').trim();
}

/**
 * セル数をヘッダの列数に揃える（不足分は空文字で補完、超過分は無視）
 */
function normalizeRowLength(cells: string[], length: number): string[] {
  return Array.from({ length }, (_, i) => cells[i] ?? '');
}

/**
 * インデントコードブロックの行か判定する（タブは4スペースとして扱う）
 */
function isIndentedCode(line: string): boolean {
  let width = 0;
  for (const char of line) {
    if (char === ' ') {
      width++;
    } else if (char === '\t') {
      width += INDENTED_CODE_WIDTH - (width % INDENTED_CODE_WIDTH);
    } else {
      break;
    }
  }
  return width >= INDENTED_CODE_WIDTH;
}

/**
 * フェンスドコードブロックの開始行であればフェンス情報を返す
 * バッククォートのフェンスでは情報文字列にバッククォートを含められない（CommonMark準拠）
 */
function matchFenceOpen(line: string): { char: string; length: number } | null {
  const match = FENCE_PATTERN.exec(line);
  if (match === null) return null;
  const marker = match[1]!;
  const char = marker[0]!;
  if (char === '`' && match[2]!.includes('`')) return null;
  return { char, length: marker.length };
}

/**
 * フェンスドコードブロックの終了行か判定する
 * 開始と同じ文字で、開始以上の長さのフェンスのみ（後続は空白のみ）が終了となる
 */
function isFenceClose(line: string, fence: { char: string; length: number }): boolean {
  const match = FENCE_PATTERN.exec(line);
  if (match === null) return false;
  const marker = match[1]!;
  return marker[0] === fence.char && marker.length >= fence.length && match[2]!.trim() === '';
}
