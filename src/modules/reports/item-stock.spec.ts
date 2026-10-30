import {
  daysOfCover,
  isDeadStock,
  itemStockStatus,
  suggestedOrderQty,
} from './item-stock';

describe('itemStockStatus — the Health tab rule, for one item', () => {
  it.each([
    [0, 20, 'out'],
    [-3, 20, 'out'],
    [0, 0, 'out'],
    [20, 20, 'low'],
    [5, 20, 'low'],
    [21, 20, 'ok'],
    // No reorder point set: never low, only in or out of stock.
    [1, 0, 'ok'],
  ])('%d on hand, reorder point %d → %s', (qty, point, status) => {
    expect(itemStockStatus(qty, point)).toBe(status);
  });
});

describe('suggestedOrderQty', () => {
  it('orders the reorder quantity, or the shortfall when that is more', () => {
    expect(suggestedOrderQty(25, 30, 50)).toBe(50);
    expect(suggestedOrderQty(0, 30, 10)).toBe(30);
    expect(suggestedOrderQty(-4, 30, 10)).toBe(34);
  });

  it('suggests nothing above the reorder point, or with none set', () => {
    expect(suggestedOrderQty(31, 30, 50)).toBeNull();
    expect(suggestedOrderQty(0, 0, 50)).toBeNull();
  });
});

describe('daysOfCover — the same arithmetic as the web and the app', () => {
  // The clients' own fixtures (itemExplorer.test.ts, itemExplorerModel.test.ts).
  const START = '2026-09-01';
  const END = '2026-09-30';
  const TODAY = '2026-09-10'; // 10 days into the month

  it('counts only the days that have happened', () => {
    // 20 sold in 10 days is 2 a day; 30 on hand lasts 15 days.
    expect(daysOfCover(30, 20, START, END, TODAY)).toBe(15);
  });

  it('counts the whole window once it has passed', () => {
    // 30 days, 60 sold: 2 a day; 45 on hand lasts 23 (22.5, rounded).
    expect(daysOfCover(45, 60, START, END, '2026-10-28')).toBe(23);
  });

  it('has no rate to divide by without sales, and nothing to cover without stock', () => {
    expect(daysOfCover(30, 0, START, END, TODAY)).toBeNull();
    expect(daysOfCover(30, -2, START, END, TODAY)).toBeNull();
    expect(daysOfCover(0, 20, START, END, TODAY)).toBe(0);
  });

  it('says nothing about an item out of stock that nobody is buying', () => {
    // Not "under a week of cover": there is no demand to run out against.
    expect(daysOfCover(0, 0, START, END, TODAY)).toBeNull();
  });
});

describe('isDeadStock — nothing out in 180 days', () => {
  const TODAY = '2026-10-28';

  it('is dead stock with nothing out in more than 180 days, or ever', () => {
    expect(isDeadStock(10, null, TODAY)).toBe(true);
    expect(isDeadStock(10, '2026-04-30', TODAY)).toBe(true); // 181 days
  });

  it('is not dead stock at exactly 180 days, or with nothing on hand', () => {
    expect(isDeadStock(10, '2026-05-01', TODAY)).toBe(false); // 180 days
    expect(isDeadStock(10, '2026-07-24', TODAY)).toBe(false);
    expect(isDeadStock(0, null, TODAY)).toBe(false);
  });
});
