import * as ExcelJS from 'exceljs';
import { clampForXlsx } from './row-serializer';

/** Excel's hard limit per sheet; a longer table continues in `name_2`, … */
export const XLSX_SHEET_ROW_LIMIT = 1_048_575;

export interface XlsxSheet {
  addRow(values: string[]): void;
  commit(): Promise<void>;
}

/**
 * The optional FinMatrix-Export.xlsx: one sheet per CSV, the same columns.
 *
 * Written with ExcelJS's streaming writer straight to a temp file, never
 * assembled in memory — a workbook holding a whole ledger would be larger
 * than the process. Styles and shared strings are off for the same reason.
 * A sheet that would exceed Excel's row limit overflows into a numbered
 * continuation sheet rather than failing the whole backup.
 */
export class XlsxSink {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;

  constructor(readonly filePath: string) {
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: filePath,
      useStyles: false,
      useSharedStrings: false,
    });
  }

  sheet(name: string, headers: string[]): XlsxSheet {
    let part = 1;
    let rowsInPart = 0;
    let current = this.open(name, part, headers);
    const committed: Promise<void>[] = [];
    return {
      addRow: (values: string[]) => {
        if (rowsInPart >= XLSX_SHEET_ROW_LIMIT) {
          committed.push(Promise.resolve(current.commit()));
          part += 1;
          rowsInPart = 0;
          current = this.open(name, part, headers);
        }
        current.addRow(values.map(clampForXlsx)).commit();
        rowsInPart += 1;
      },
      commit: async () => {
        await current.commit();
        await Promise.all(committed);
      },
    };
  }

  private open(name: string, part: number, headers: string[]) {
    const title = (part === 1 ? name : `${name}_${part}`).slice(0, 31);
    const ws = this.workbook.addWorksheet(title);
    ws.addRow(headers).commit();
    return ws;
  }

  async finish(): Promise<void> {
    await this.workbook.commit();
  }
}
