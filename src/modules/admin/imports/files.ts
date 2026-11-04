import { readSheet } from 'read-excel-file/node';
import type { ImportFormat } from '../../../db/schema/index.ts';
import { badRequest } from '../../../lib/errors.ts';
import { csvRecords, MAX_PRODUCTS, readProductTable, toTable, type Table } from './csv.ts';
import { isDarazBasic, isDarazPriceStock, readDaraz } from './daraz.ts';
import type { ImportProduct } from './types.ts';

export interface UploadedFile {
  name: string;
  buffer: Buffer;
}

const isExcel = (name: string) => /\.xlsx$/i.test(name);

/** Excel cells as text, like a CSV would have them. */
function cellText(value: unknown) {
  if (value === null || value === undefined) return '';
  // Excel dates have no time zone; the reader gives them as UTC. Keep the time as typed: "2026-12-01 00:00:00".
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  return String(value);
}

/** The first sheet of an Excel file, or the CSV file, as a table. */
async function readTable(file: UploadedFile): Promise<Table> {
  if (!isExcel(file.name)) return toTable(csvRecords(file.buffer));
  let rows;
  try {
    rows = await readSheet(file.buffer);
  } catch {
    throw badRequest(`"${file.name}" could not be read as an Excel file`, { file: 'Open it in Excel, save it again as .xlsx or CSV, and retry' });
  }
  return toTable(rows.map((cells) => cells.map(cellText)));
}

/**
 * Reads the uploaded file(s) and tells which format they are: our template or a WooCommerce
 * export (CSV or Excel, one file), or Daraz Seller Center exports (one or both of "basic" and
 * "price & stock").
 */
export async function readProductFiles(files: UploadedFile[]): Promise<{ format: ImportFormat; products: ImportProduct[] }> {
  const tables = await Promise.all(files.map(readTable));

  const basic = tables.find((t) => isDarazBasic(t.headers)) ?? null;
  const priceStock = tables.find((t) => isDarazPriceStock(t.headers)) ?? null;
  let result: { format: ImportFormat; products: ImportProduct[] } | null = null;

  if (basic || priceStock) {
    if (tables.length > (basic && priceStock ? 2 : 1)) {
      throw badRequest('Only Daraz files can be uploaded together', {
        file: 'Upload the Daraz "basic" and "price & stock" exports together, or one other file',
      });
    }
    result = { format: 'daraz', products: readDaraz(basic, priceStock) };
  } else {
    if (tables.length > 1) {
      throw badRequest('Upload one file at a time', { file: 'Only the two Daraz exports can be uploaded together' });
    }
    result = readProductTable(tables[0]!);
  }

  if (!result) {
    throw badRequest('This file is not a product file we know', {
      file: 'Use the PaperTree template, a WooCommerce product export or Daraz Seller Center exports (it needs at least "name" and "price" columns)',
    });
  }
  if (result.products.length > MAX_PRODUCTS) {
    throw badRequest(`The file has ${result.products.length} products. Import at most ${MAX_PRODUCTS} at a time.`, {
      file: `Split the file into parts of at most ${MAX_PRODUCTS} products`,
    });
  }
  return result;
}
