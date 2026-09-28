import { BadRequestException } from '@nestjs/common';
import { assertMoneyAccount } from './money-account.util';

describe('assertMoneyAccount — what a payment may move money through', () => {
  const account = (over: Record<string, unknown>) =>
    ({
      type: 'asset',
      subType: 'Bank',
      isActive: true,
      accountNumber: '1010',
      name: 'Business Checking',
      ...over,
    }) as Parameters<typeof assertMoneyAccount>[0];

  it('accepts an active cash or bank account', () => {
    expect(() => assertMoneyAccount(account({}))).not.toThrow();
    expect(() =>
      assertMoneyAccount(
        account({ subType: 'Cash', accountNumber: '1000', name: 'Cash' }),
      ),
    ).not.toThrow();
  });

  it.each([
    [
      'an expense account',
      {
        type: 'expense',
        subType: 'Operating',
        accountNumber: '6000',
        name: 'Rent',
      },
    ],
    [
      'accounts payable',
      {
        type: 'liability',
        subType: 'Accounts Payable',
        accountNumber: '2000',
        name: 'Accounts Payable',
      },
    ],
    [
      'accounts receivable',
      {
        type: 'asset',
        subType: 'Accounts Receivable',
        accountNumber: '1100',
        name: 'A/R',
      },
    ],
    [
      'inventory',
      {
        type: 'asset',
        subType: 'Inventory',
        accountNumber: '1200',
        name: 'Inventory',
      },
    ],
  ])('refuses %s', (_label, over) => {
    expect(() => assertMoneyAccount(account(over))).toThrow(
      BadRequestException,
    );
    try {
      assertMoneyAccount(account(over));
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_PAYMENT_ACCOUNT',
      });
    }
  });

  it('refuses an inactive bank account', () => {
    expect(() => assertMoneyAccount(account({ isActive: false }))).toThrow(
      /inactive/,
    );
  });
});
