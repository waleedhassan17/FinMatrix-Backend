/**
 * Writes the Migration Center golden fixtures into this folder:
 *
 *   npx ts-node -r tsconfig-paths/register test/fixtures/migration/build-fixtures.ts
 *
 * The files are committed so a reviewer can open them in Excel; this script
 * is how they were made and how to remake them after a template change.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  arMismatchBooks,
  buildMessyGenericXlsx,
  buildStarterXlsx,
  cleanBooks,
  duplicatesAndAmbiguousBooks,
  stockMismatchBooks,
  unbalancedBooks,
} from './workbook-builder';

async function main() {
  const dir = __dirname;
  const files: Array<[string, Promise<Buffer>]> = [
    ['a-clean-starter.xlsx', buildStarterXlsx(cleanBooks())],
    ['b-unbalanced-tb.xlsx', buildStarterXlsx(unbalancedBooks())],
    ['c-ar-mismatch.xlsx', buildStarterXlsx(arMismatchBooks())],
    ['d-stock-mismatch.xlsx', buildStarterXlsx(stockMismatchBooks())],
    [
      'e-duplicates-ambiguous-dates.xlsx',
      buildStarterXlsx(duplicatesAndAmbiguousBooks()),
    ],
    ['f-messy-generic.xlsx', buildMessyGenericXlsx()],
  ];
  for (const [name, p] of files) {
    fs.writeFileSync(path.join(dir, name), await p);
    console.log(`wrote ${name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
