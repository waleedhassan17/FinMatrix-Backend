import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import Decimal from 'decimal.js';
import { InventoryItem } from '../entities/inventory-item.entity';
import { InventoryService } from '../inventory.service';
import { Company } from '../../companies/entities/company.entity';
import { OperationalAuditService } from '../../../common/audit/operational-audit.service';
import { recordMovementAtAverage } from '../../../common/utils/inventory-movement.util';
import { assertNotFutureDate } from '../../../common/utils/date.util';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { cellToText } from './cell-value';
import { ImportSheet, RawImportRow, readImportFile } from './read-sheet';
import {
  ExistingItemSnapshot,
  ImportRole,
  ImportSummary,
  PlannedRow,
  planImport,
} from './plan-import';
import { buildItemsWorkbook } from './template';
import { CommitImportDto } from './import.dto';

export type ImportResultRow = Omit<PlannedRow, 'patch'>;

export interface ImportResult {
  fileName: string;
  sheetName: string;
  columns: { recognized: string[]; ignored: string[] };
  role: ImportRole;
  openingStockAllowed: boolean;
  booksLockedUntil: string | null;
  summary: ImportSummary;
  rows: ImportResultRow[];
  applied?: {
    created: number;
    updated: number;
    openingStockItems: number;
    openingStockValue: string;
    openingStockDate: string | null;
    journalEntryId: string | null;
    journalReference: string | null;
  };
}

export interface ImportFile {
  buffer: Buffer;
  originalname: string;
}

/**
 * Bulk create/update of inventory items from a spreadsheet.
 *
 * Two calls, both stateless: preview reads the file and returns the plan with
 * nothing written; commit is sent the SAME file, plans it again against rows
 * it has locked, and applies every valid row in one transaction. Rows with
 * errors are skipped and reported; the valid set is all-or-nothing.
 *
 * Re-sending a file is harmless by construction — values already in place
 * come back `unchanged`, and opening stock is refused once an item has stock —
 * so a retry after a dropped connection cannot double anything.
 */
@Injectable()
export class InventoryImportService {
  constructor(
    @InjectRepository(InventoryItem)
    private readonly itemRepo: Repository<InventoryItem>,
    private readonly dataSource: DataSource,
    private readonly inventory: InventoryService,
    private readonly audit: OperationalAuditService,
  ) {}

  /** The blank template, or (prefill) every item in the same columns. */
  async template(companyId: string, prefill: boolean): Promise<Buffer> {
    if (!prefill) return buildItemsWorkbook();
    const items = await this.itemRepo.find({
      where: { companyId },
      order: { sku: 'ASC' },
    });
    return buildItemsWorkbook(items);
  }

  async preview(
    companyId: string,
    user: AuthenticatedUser,
    file: ImportFile,
  ): Promise<ImportResult> {
    const sheet = await readImportFile(file.buffer);
    const role = importRole(user);
    const em = this.dataSource.manager;
    const { existing } = await this.snapshot(em, companyId, sheet.rows, false);
    const plan = planImport(sheet.rows, existing, { role });
    return this.result(
      file,
      sheet,
      role,
      await this.booksLockedUntil(em, companyId),
      plan.rows,
      plan.summary,
    );
  }

  async commit(
    companyId: string,
    user: AuthenticatedUser,
    file: ImportFile,
    dto: CommitImportDto,
  ): Promise<ImportResult> {
    const sheet = await readImportFile(file.buffer);
    const role = importRole(user);

    let result: ImportResult;
    try {
      result = await this.dataSource.transaction((em) =>
        this.apply(em, companyId, user, role, file, sheet, dto),
      );
    } catch (err) {
      const code =
        err instanceof QueryFailedError
          ? (err as QueryFailedError & { code?: string }).code
          : undefined;
      if (code === '23505' || code === '40P01') {
        throw new ConflictException({
          code: 'IMPORT_CONFLICT',
          message:
            'Someone changed these items while the import was running. Upload the file again.',
        });
      }
      throw err;
    }

    const applied = result.applied!;
    if (applied.created + applied.updated > 0) {
      await this.audit.record({
        companyId,
        actorUserId: user.id,
        action: 'inventory.import',
        targetType: 'inventory_import',
        targetId: applied.journalEntryId,
        details: {
          fileName: result.fileName,
          rows: result.summary.totalRows,
          created: applied.created,
          updated: applied.updated,
          skippedWithErrors: result.summary.error,
          openingStockItems: applied.openingStockItems,
          openingStockValue: applied.openingStockValue,
          openingStockDate: applied.openingStockDate,
          journalReference: applied.journalReference,
        },
      });
    }
    return result;
  }

  private async apply(
    em: EntityManager,
    companyId: string,
    user: AuthenticatedUser,
    role: ImportRole,
    file: ImportFile,
    sheet: ImportSheet,
    dto: CommitImportDto,
  ): Promise<ImportResult> {
    // Plan again against LOCKED rows: the preview the user confirmed may be
    // minutes old, and a sale in between can have given an item stock.
    const { existing, items } = await this.snapshot(
      em,
      companyId,
      sheet.rows,
      true,
    );
    const plan = planImport(sheet.rows, existing, { role });
    const booksLockedUntil = await this.booksLockedUntil(em, companyId);
    const opening = plan.summary.openingStock;

    // The owner confirmed a value in the preview. If the plan no longer
    // produces it, they would be posting a figure they never saw.
    const confirmed = dto.confirmOpeningStockValue;
    const expected = new Decimal(opening.value);
    if (
      (opening.items > 0 && confirmed === undefined) ||
      (confirmed !== undefined && !new Decimal(confirmed).equals(expected))
    ) {
      throw new ConflictException({
        code: 'IMPORT_PREVIEW_STALE',
        message: `The opening stock value is now Rs ${expected.toFixed(2)}, not what the preview showed. Review the preview again before importing.`,
      });
    }

    let date: string | null = null;
    if (opening.items > 0) {
      date = dto.openingStockDate ?? null;
      if (!date) {
        throw new BadRequestException({
          code: 'OPENING_STOCK_DATE_REQUIRED',
          message: 'Choose the date the opening stock is recorded on.',
        });
      }
      assertNotFutureDate(date, 'Opening stock');
      // PostingService enforces this too, but only after every item is
      // written; checking first gives the same answer without the work.
      if (booksLockedUntil && date <= booksLockedUntil) {
        throw new BadRequestException({
          code: 'PERIOD_LOCKED',
          message: `The accounting period is closed through ${booksLockedUntil}. Postings dated on or before that date are not allowed.`,
        });
      }
    }

    const itemRepo = em.getRepository(InventoryItem);
    const openingEntries: Array<{ item: InventoryItem; quantity: Decimal }> =
      [];

    const creates = plan.rows.filter((r) => r.action === 'create');
    const created = creates.map((r) =>
      itemRepo.create({
        ...(r.patch as Partial<InventoryItem>),
        companyId,
        costMethod: 'average',
        quantityOnHand: r.openingStock
          ? new Decimal(r.openingStock.quantity).toFixed(4)
          : '0',
        quantityOnOrder: '0',
        quantityCommitted: '0',
      }),
    );
    await itemRepo.save(created, { chunk: 200 });
    creates.forEach((r, i) => {
      r.itemId = created[i].id;
      if (r.openingStock)
        openingEntries.push({
          item: created[i],
          quantity: new Decimal(r.openingStock.quantity),
        });
    });

    const updates = plan.rows.filter((r) => r.action === 'update');
    for (const r of updates) {
      const item = items.get(r.itemId!)!;
      const patch: Partial<InventoryItem> = {
        ...(r.patch as Partial<InventoryItem>),
      };
      if (r.openingStock)
        patch.quantityOnHand = new Decimal(r.openingStock.quantity).toFixed(4);
      Object.assign(item, patch);
      await itemRepo.update({ id: item.id, companyId }, patch);
      if (r.openingStock)
        openingEntries.push({
          item,
          quantity: new Decimal(r.openingStock.quantity),
        });
    }

    let journal: { id: string; reference: string } | null = null;
    if (openingEntries.length > 0 && date) {
      journal = await this.inventory.postOpeningStockBatchJe(
        em,
        companyId,
        user.id,
        openingEntries,
        date,
        `Opening stock — ${openingEntries.length} item${openingEntries.length === 1 ? '' : 's'} imported from ${file.originalname}`.slice(
          0,
          255,
        ),
      );
      for (const { item, quantity } of openingEntries) {
        await recordMovementAtAverage(em, item, {
          date,
          type: 'adjustment',
          quantityChange: quantity,
          balanceAfter: quantity,
          description: 'Opening stock (import)',
          reference: journal?.reference ?? null,
          sourceType: 'opening_stock',
          sourceId: item.id,
          createdBy: user.id,
        });
      }
    }

    return {
      ...this.result(
        file,
        sheet,
        role,
        booksLockedUntil,
        plan.rows,
        plan.summary,
      ),
      applied: {
        created: creates.length,
        updated: updates.length,
        openingStockItems: openingEntries.length,
        openingStockValue: opening.value,
        openingStockDate: openingEntries.length > 0 ? date : null,
        journalEntryId: journal?.id ?? null,
        journalReference: journal?.reference ?? null,
      },
    };
  }

  /** The existing items the file's SKUs name (case-insensitively). */
  private async snapshot(
    em: EntityManager,
    companyId: string,
    rows: RawImportRow[],
    lock: boolean,
  ): Promise<{
    existing: ExistingItemSnapshot[];
    items: Map<string, InventoryItem>;
  }> {
    const skus = [
      ...new Set(
        rows.map((r) => skuKey(r.cells.sku)).filter((s): s is string => !!s),
      ),
    ];
    if (skus.length === 0) return { existing: [], items: new Map() };

    const qb = em
      .getRepository(InventoryItem)
      .createQueryBuilder('i')
      .where('i.companyId = :cid', { cid: companyId })
      .andWhere('lower(i.sku) IN (:...skus)', { skus })
      // A fixed lock order, so two imports touching the same items queue
      // behind each other instead of deadlocking.
      .orderBy('i.id', 'ASC');
    if (lock) qb.setLock('pessimistic_write');
    const items = await qb.getMany();

    const moved = new Set<string>();
    if (items.length > 0) {
      const rowsWithHistory: Array<{ item_id: string }> = await em.query(
        `SELECT DISTINCT item_id FROM inventory_movements WHERE company_id = $1 AND item_id = ANY($2::uuid[])`,
        [companyId, items.map((i) => i.id)],
      );
      for (const r of rowsWithHistory) moved.add(r.item_id);
    }

    return {
      existing: items.map((i) => ({
        id: i.id,
        sku: i.sku,
        name: i.name,
        description: i.description,
        category: i.category,
        unitOfMeasure: i.unitOfMeasure,
        unitCost: i.unitCost,
        sellingPrice: i.sellingPrice,
        reorderPoint: i.reorderPoint,
        reorderQuantity: i.reorderQuantity,
        minStock: i.minStock,
        maxStock: i.maxStock,
        barcodeData: i.barcodeData,
        isActive: i.isActive,
        quantityOnHand: i.quantityOnHand,
        hasMovements: moved.has(i.id),
      })),
      items: new Map(items.map((i) => [i.id, i])),
    };
  }

  private async booksLockedUntil(
    em: EntityManager,
    companyId: string,
  ): Promise<string | null> {
    const company = await em.findOne(Company, {
      where: { id: companyId },
      select: { id: true, booksLockedUntil: true },
    });
    return company?.booksLockedUntil ?? null;
  }

  private result(
    file: ImportFile,
    sheet: ImportSheet,
    role: ImportRole,
    booksLockedUntil: string | null,
    rows: PlannedRow[],
    summary: ImportSummary,
  ): ImportResult {
    return {
      fileName: file.originalname,
      sheetName: sheet.sheetName,
      columns: { recognized: sheet.recognized, ignored: sheet.ignored },
      role,
      openingStockAllowed: role === 'admin',
      booksLockedUntil,
      summary,
      // The wire shape, field by field — `patch` stays on the server.
      rows: rows.map((r) => ({
        rowNumber: r.rowNumber,
        sku: r.sku,
        name: r.name,
        action: r.action,
        itemId: r.itemId,
        changes: r.changes,
        openingStock: r.openingStock,
        errors: r.errors,
        warnings: r.warnings,
      })),
    };
  }
}

const importRole = (user: AuthenticatedUser): ImportRole =>
  user.role === 'admin' ? 'admin' : 'staff';

function skuKey(value: unknown): string | null {
  try {
    return cellToText(value)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
