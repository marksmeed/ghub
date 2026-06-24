import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const runBinary = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const OCR_BIN_PATH = path.resolve(moduleDir, '..', 'vendor', 'ocr', 'ocr-bin');

const TEXT_TRUNCATION_LIMIT = 500_000;
const OCR_TIMEOUT_MS = 30_000;
const MAX_FILENAME_LENGTH = 200;

export interface AttachmentMetadata {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  isInline: boolean;
}

export type ExtractionMethod =
  | 'pdf-parse'
  | 'mammoth'
  | 'exceljs'
  | 'officeparser'
  | 'utf8'
  | 'ocr-vision'
  | 'none';

export interface ExtractionResult {
  text: string | null;
  extractionMethod: ExtractionMethod;
  textTruncated?: boolean;
  extractionError?: string;
}

export interface AttachmentContent extends AttachmentMetadata {
  savedPath: string;
  text: string | null;
  extractionMethod: ExtractionMethod;
  textTruncated?: boolean;
  extractionError?: string;
  attachmentType?: 'file' | 'item' | 'reference';
  referenceUrl?: string;
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function getSaveDir(): string {
  const env = process.env.MCP_ATTACHMENTS_DIR?.trim();
  if (env) return path.resolve(expandHome(env));
  return path.join(os.homedir(), 'Downloads', 'mcp-attachments');
}

export async function ensureSaveDir(): Promise<string> {
  const dir = getSaveDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function sanitizeFilename(raw: string): string {
  if (typeof raw !== 'string' || !raw) return 'attachment';

  const withoutTraversal = raw.replace(/\.{2,}/g, '.');
  // eslint-disable-next-line no-control-regex
  const cleaned = withoutTraversal
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'attachment';
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  const ext = path.extname(cleaned);
  const base = cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length);
  return base + ext;
}

export function buildSavePath(attachmentId: string, filename: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const shortId = (attachmentId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'att';
  const safe = sanitizeFilename(filename);
  return path.join(getSaveDir(), `${today}-${shortId}-${safe}`);
}

export async function saveAttachment(
  bytes: Buffer,
  attachmentId: string,
  filename: string,
): Promise<string> {
  await ensureSaveDir();
  const outPath = buildSavePath(attachmentId, filename);
  await fs.writeFile(outPath, bytes);
  return outPath;
}

function truncate(text: string): { text: string; textTruncated?: boolean } {
  if (text.length <= TEXT_TRUNCATION_LIMIT) return { text };
  return { text: text.slice(0, TEXT_TRUNCATION_LIMIT), textTruncated: true };
}

function isTextLikeMime(contentType: string, ext: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('text/')) return true;
  if (ct === 'application/json') return true;
  if (ct === 'application/xml') return true;
  if (['.txt', '.md', '.csv', '.json', '.xml', '.log'].includes(ext)) return true;
  return false;
}

function isImageMime(contentType: string, ext: string): boolean {
  if (contentType.toLowerCase().startsWith('image/')) return true;
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tiff', '.heic'].includes(ext);
}

async function extractPdf(savedPath: string): Promise<ExtractionResult> {
  try {
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    const buf = await fs.readFile(savedPath);
    const result = await pdfParse(buf);
    const text = (result.text ?? '').trim();
    if (!text) {
      return {
        text: null,
        extractionMethod: 'pdf-parse',
        extractionError: 'PDF appears to be scanned or image-based (no extractable text).',
      };
    }
    const trimmed = truncate(text);
    return {
      text: trimmed.text,
      extractionMethod: 'pdf-parse',
      textTruncated: trimmed.textTruncated,
    };
  } catch (err) {
    return {
      text: null,
      extractionMethod: 'pdf-parse',
      extractionError: `PDF parse failed: ${(err as Error).message}`,
    };
  }
}

async function extractDocx(savedPath: string): Promise<ExtractionResult> {
  try {
    const mammoth = await import('mammoth');
    const buf = await fs.readFile(savedPath);
    const result = await mammoth.extractRawText({ buffer: buf });
    const trimmed = truncate(result.value ?? '');
    return {
      text: trimmed.text,
      extractionMethod: 'mammoth',
      textTruncated: trimmed.textTruncated,
    };
  } catch (err) {
    return {
      text: null,
      extractionMethod: 'mammoth',
      extractionError: `DOCX parse failed: ${(err as Error).message}`,
    };
  }
}

// CSV-escape a cell value: quote it when it contains a comma, quote, or newline,
// doubling any embedded quotes (RFC 4180).
function escapeCsvValue(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function extractXlsx(savedPath: string): Promise<ExtractionResult> {
  try {
    // ExcelJS only writes the first worksheet to CSV natively, so build the CSV
    // for every sheet by hand from each cell's display text.
    // ExcelJS is CommonJS; under ESM its Workbook lives on the default export.
    const { default: ExcelJS } = await import('exceljs');
    const buf = await fs.readFile(savedPath);
    const workbook = new ExcelJS.Workbook();
    // ExcelJS ships its own global `Buffer` type that is incompatible with
    // Node's; cast to exactly the type load() expects. The value is a real
    // Node Buffer at runtime.
    await workbook.xlsx.load(buf as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    const sheets: string[] = [];
    workbook.eachSheet((worksheet) => {
      const rows: string[] = [];
      worksheet.eachRow({ includeEmpty: true }, (row) => {
        const cells: string[] = [];
        for (let col = 1; col <= worksheet.columnCount; col += 1) {
          cells.push(escapeCsvValue(row.getCell(col).text ?? ''));
        }
        rows.push(cells.join(','));
      });
      sheets.push(`=== ${worksheet.name} ===\n${rows.join('\n')}`);
    });

    const trimmed = truncate(sheets.join('\n\n'));
    return {
      text: trimmed.text,
      extractionMethod: 'exceljs',
      textTruncated: trimmed.textTruncated,
    };
  } catch (err) {
    return {
      text: null,
      extractionMethod: 'exceljs',
      extractionError: `XLSX parse failed: ${(err as Error).message}`,
    };
  }
}

async function extractPptx(savedPath: string): Promise<ExtractionResult> {
  try {
    // officeparser 7 returns an AST from parseOffice; convert() yields plain
    // text directly, inferring the file type from the path extension.
    const { convert } = await import('officeparser');
    const { value } = await convert(savedPath, 'text');
    const trimmed = truncate(typeof value === 'string' ? value : '');
    return {
      text: trimmed.text,
      extractionMethod: 'officeparser',
      textTruncated: trimmed.textTruncated,
    };
  } catch (err) {
    return {
      text: null,
      extractionMethod: 'officeparser',
      extractionError: `PPTX parse failed: ${(err as Error).message}`,
    };
  }
}

async function readTextPlain(savedPath: string): Promise<ExtractionResult> {
  try {
    const content = await fs.readFile(savedPath, 'utf8');
    const trimmed = truncate(content);
    return {
      text: trimmed.text,
      extractionMethod: 'utf8',
      textTruncated: trimmed.textTruncated,
    };
  } catch (err) {
    return {
      text: null,
      extractionMethod: 'utf8',
      extractionError: `Text read failed: ${(err as Error).message}`,
    };
  }
}

async function extractImageOcr(savedPath: string): Promise<ExtractionResult> {
  try {
    await fs.access(OCR_BIN_PATH);
  } catch {
    return {
      text: null,
      extractionMethod: 'none',
      extractionError:
        'OCR binary unavailable — built by scripts/build-ocr.mjs on macOS only (requires swiftc).',
    };
  }
  try {
    const { stdout } = await runBinary(OCR_BIN_PATH, [savedPath], {
      timeout: OCR_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const trimmedRaw = (stdout ?? '').trim();
    if (!trimmedRaw) {
      return {
        text: null,
        extractionMethod: 'ocr-vision',
        extractionError: 'OCR returned no text.',
      };
    }
    const trimmed = truncate(trimmedRaw);
    return {
      text: trimmed.text,
      extractionMethod: 'ocr-vision',
      textTruncated: trimmed.textTruncated,
    };
  } catch (err) {
    return {
      text: null,
      extractionMethod: 'ocr-vision',
      extractionError: `OCR failed: ${(err as Error).message}`,
    };
  }
}

export async function extractText(
  savedPath: string,
  contentType: string,
): Promise<ExtractionResult> {
  const ext = path.extname(savedPath).toLowerCase();
  const ct = (contentType ?? '').toLowerCase();

  if (ct === 'application/pdf' || ext === '.pdf') {
    return extractPdf(savedPath);
  }

  if (
    ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    return extractDocx(savedPath);
  }

  if (
    ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ct === 'application/vnd.ms-excel' ||
    ext === '.xlsx' ||
    ext === '.xls'
  ) {
    return extractXlsx(savedPath);
  }

  if (
    ct === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    ext === '.pptx'
  ) {
    return extractPptx(savedPath);
  }

  if (isImageMime(ct, ext)) {
    return extractImageOcr(savedPath);
  }

  if (isTextLikeMime(ct, ext)) {
    return readTextPlain(savedPath);
  }

  return { text: null, extractionMethod: 'none' };
}

export async function saveAndExtract(
  bytes: Buffer,
  metadata: AttachmentMetadata,
): Promise<AttachmentContent> {
  const savedPath = await saveAttachment(bytes, metadata.id, metadata.filename);
  const result = await extractText(savedPath, metadata.contentType);
  return {
    ...metadata,
    savedPath,
    text: result.text,
    extractionMethod: result.extractionMethod,
    textTruncated: result.textTruncated,
    extractionError: result.extractionError,
  };
}
