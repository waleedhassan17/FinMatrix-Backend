import { BillsService } from '../../modules/bills/bills.service';

/**
 * A payment voucher for seeded bill payments.
 *
 * BillsService.pay refuses a payment it cannot find a proof for, and claims
 * that proof against the payment so one upload can never back two. That is an
 * internal control over cash going out — evidence for every disbursement — not
 * a form field, so seeded history has to satisfy it the way a real payment
 * does rather than route around it. Seeds that called pay() without a proofId
 * either died outright (tier-demos) or had the failure swallowed by a
 * try/catch and left the bill unpaid (metromatrix-ledger), which quietly
 * overstated both Accounts Payable and cash in the demo books.
 *
 * Mint one per payment: a proof is consumed by the payment that uses it, so
 * reusing an id across two payments would be refused with
 * PAYMENT_PROOF_ALREADY_USED.
 *
 * The file is a 1x1 PNG rather than a text stub so the stored proof is
 * something the app's proof viewer can actually render, and so its MIME type
 * is one the upload route would have accepted.
 */

/** Smallest valid PNG: one transparent pixel. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Uploads a voucher and returns the proofId to hand to BillsService.pay.
 *
 * @param reference appears in the stored filename, so a seeded proof can be
 *                  traced back to the bill it evidences.
 */
export async function seedPaymentVoucher(
  bills: BillsService,
  companyId: string,
  userId: string,
  reference: string,
): Promise<string> {
  const safe = reference.replace(/[^A-Za-z0-9._-]/g, '-');
  const proof = await bills.createPaymentProof(companyId, userId, {
    buffer: ONE_PIXEL_PNG,
    mimetype: 'image/png',
    originalname: `voucher-${safe}.png`,
    size: ONE_PIXEL_PNG.length,
  });
  return proof.id;
}
