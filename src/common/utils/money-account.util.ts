import { BadRequestException } from '@nestjs/common';

/** Sub-types of an asset account that hold money a payment can move. */
export const MONEY_ACCOUNT_SUB_TYPES = ['Cash', 'Bank'] as const;

/**
 * Refuse to post a payment against anything but a cash or bank account.
 *
 * Receipts and bill payments took any account id as their "bank" side, so an
 * expense account — or Accounts Payable itself — could stand in for the cash
 * that moved, and the entry would post without complaint. Both clients already
 * offer only cash and bank accounts; this is the server holding the same line.
 */
export function assertMoneyAccount(account: {
  type: string;
  subType: string | null;
  isActive?: boolean;
  accountNumber?: string;
  name?: string;
}): void {
  const label =
    [account.accountNumber, account.name].filter(Boolean).join(' · ') ||
    'That account';
  if (
    account.type !== 'asset' ||
    !(MONEY_ACCOUNT_SUB_TYPES as readonly string[]).includes(
      account.subType ?? '',
    )
  ) {
    throw new BadRequestException({
      code: 'INVALID_PAYMENT_ACCOUNT',
      message: `${label} is not a cash or bank account. Choose the account the money moved through.`,
    });
  }
  if (account.isActive === false) {
    throw new BadRequestException({
      code: 'INVALID_PAYMENT_ACCOUNT',
      message: `${label} is inactive. Choose an active cash or bank account.`,
    });
  }
}
