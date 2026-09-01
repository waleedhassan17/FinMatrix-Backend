import { BadRequestException, Injectable } from '@nestjs/common';
import { InventoryService } from '../inventory/inventory.service';
import { JournalEntriesService } from '../journal-entries/journal-entries.service';
import { CreditMemosService } from '../credit-memos/credit-memos.service';
import { VendorCreditsService } from '../vendor-credits/vendor-credits.service';
import { BillsService } from '../bills/bills.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { InvoicesService } from '../invoices/invoices.service';
import { InventoryApprovalsService } from '../inventory-approvals/inventory-approvals.service';
import { ApprovalType } from './entities/approval-request.entity';

/** What the dispatch produced, recorded on the approval row. */
export interface DispatchResult {
  /** The journal entry posted, when the action posts one. */
  journalEntryId?: string | null;
  /** The document created (PO, credit memo, payment, …). */
  id?: string | null;
}

type Payload = Record<string, any>;

/**
 * Replays an approved request against the service that owns the action.
 *
 * This is the ONLY place a pending request turns into real work, and every
 * entry routes to a method that already existed. Nothing here writes a journal
 * line, computes a balance, or touches PostingService directly: the posting
 * engine stays exactly as it was, and an approved request posts through the
 * same code path an owner's direct action does. That is what guarantees the
 * two produce identical accounting.
 */
@Injectable()
export class ApprovalDispatcher {
  constructor(
    private readonly inventory: InventoryService,
    private readonly journals: JournalEntriesService,
    private readonly creditMemos: CreditMemosService,
    private readonly vendorCredits: VendorCreditsService,
    private readonly bills: BillsService,
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly invoices: InvoicesService,
    private readonly deliveryApprovals: InventoryApprovalsService,
  ) {}

  async dispatch(
    type: ApprovalType,
    payload: Payload,
    companyId: string,
    reviewerId: string,
  ): Promise<DispatchResult> {
    switch (type) {
      // ── Dr/Cr Inventory against the reason's offset account ──────────────
      case 'adjustment': {
        const result = await this.inventory.adjust(
          companyId,
          payload as any,
          reviewerId,
        );
        return {
          id: (result as any)?.id ?? null,
          journalEntryId: (result as any)?.journalEntryId ?? null,
        };
      }

      // ── A manual journal, created and then posted ────────────────────────
      case 'journal': {
        const created = await this.journals.create(
          companyId,
          reviewerId,
          // Force 'posted': a request to post a journal that approves into a
          // draft would leave the owner thinking they had posted it.
          { ...(payload as any), status: 'posted' },
        );
        return { id: created.id, journalEntryId: created.id };
      }

      // ── Customer return / correction ─────────────────────────────────────
      case 'credit_memo': {
        const { action = 'create', creditMemoId, ...rest } = payload;
        if (action === 'apply') {
          const memo = await this.creditMemos.applyToInvoice(
            companyId,
            this.requireId(creditMemoId, 'creditMemoId'),
            rest as any,
          );
          return { id: memo.id, journalEntryId: (memo as any)?.journalEntryId ?? null };
        }
        if (action === 'refund') {
          const memo = await this.creditMemos.refund(
            companyId,
            this.requireId(creditMemoId, 'creditMemoId'),
            reviewerId,
          );
          return { id: memo.id, journalEntryId: (memo as any)?.journalEntryId ?? null };
        }
        const memo = await this.creditMemos.create(companyId, reviewerId, rest as any);
        return { id: memo.id, journalEntryId: (memo as any)?.journalEntryId ?? null };
      }

      // ── Supplier return / correction ─────────────────────────────────────
      case 'vendor_credit': {
        const { action = 'create', vendorCreditId, ...rest } = payload;
        if (action === 'apply') {
          const credit = await this.vendorCredits.applyToBill(
            companyId,
            this.requireId(vendorCreditId, 'vendorCreditId'),
            rest as any,
          );
          return { id: credit.id, journalEntryId: (credit as any)?.journalEntryId ?? null };
        }
        const credit = await this.vendorCredits.create(companyId, reviewerId, rest as any);
        return { id: credit.id, journalEntryId: (credit as any)?.journalEntryId ?? null };
      }

      // ── Reverse something already posted ─────────────────────────────────
      // Voids reverse, never delete: each of these posts a balancing entry.
      case 'void': {
        const { entity, targetId } = payload;
        const id = this.requireId(targetId, 'targetId');
        switch (entity) {
          case 'journal': {
            await this.journals.void(companyId, id, reviewerId, payload as any);
            return { id };
          }
          case 'invoice': {
            await this.invoices.void(companyId, id, reviewerId, payload as any);
            return { id };
          }
          case 'credit_memo': {
            await this.creditMemos.void(companyId, id, reviewerId);
            return { id };
          }
          case 'vendor_credit': {
            await this.vendorCredits.void(companyId, id, reviewerId);
            return { id };
          }
          default:
            throw new BadRequestException({
              code: 'UNKNOWN_VOID_TARGET',
              message: `Cannot void an unrecognised entity: ${String(entity)}`,
            });
        }
      }

      // ── Cash out: Dr Accounts Payable / Cr Bank ──────────────────────────
      case 'bill_payment': {
        const payment = await this.bills.pay(companyId, reviewerId, payload as any);
        return {
          id: payment.id,
          journalEntryId: (payment as any)?.journalEntryId ?? null,
        };
      }

      // ── Non-posting: a commitment, not a transaction ─────────────────────
      // Nothing exists until this runs, which is why a pending PO request has
      // no effect of any kind to unwind.
      case 'po': {
        const po = await this.purchaseOrders.create(companyId, payload as any);
        return { id: po.id, journalEntryId: null };
      }

      // ── Reverse an approved delivery ─────────────────────────────────────
      // Unwinds recognised revenue, so the owner decides. undoApproval posts
      // the reversal by swapping Dr/Cr of the original lines, dated today —
      // which is what puts it under the period lock.
      case 'delivery_undo': {
        const requestId = this.requireId(payload.requestId, 'requestId');
        await this.deliveryApprovals.undoApproval(companyId, requestId, reviewerId);
        // journalEntryId stays null on purpose: undoApproval posts its
        // reversal and then clears the link on the inventory_update_request,
        // returning the formatted request rather than the new entry's id. The
        // reversal is findable by its source_type ('delivery_approval_undo')
        // and source_id, so nothing is lost by not duplicating it here.
        return { id: requestId, journalEntryId: null };
      }

      default: {
        // Exhaustiveness: adding a type to ApprovalType without wiring it here
        // is a compile error, not a request that silently approves into
        // nothing.
        const unreachable: never = type;
        throw new BadRequestException({
          code: 'UNKNOWN_APPROVAL_TYPE',
          message: `No handler for approval type ${String(unreachable)}`,
        });
      }
    }
  }

  private requireId(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value) {
      throw new BadRequestException({
        code: 'MALFORMED_PAYLOAD',
        message: `This request is missing ${field} and cannot be approved.`,
      });
    }
    return value;
  }
}
