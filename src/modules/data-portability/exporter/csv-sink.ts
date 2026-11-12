import { createHash } from 'crypto';
import { PassThrough, Readable, Transform } from 'stream';
import { once } from 'events';
import { stringify } from 'csv-stringify';

export interface CsvStats {
  rows: number;
  bytes: number;
  sha256: string;
}

/**
 * A CSV being written row by row into a readable that a ZIP consumes.
 *
 * UTF-8 with a byte-order mark: without the BOM, Excel on Windows opens a CSV
 * as the system code page and every Urdu customer name becomes question
 * marks. With it, Excel reads the file as UTF-8 and the names show.
 *
 * The SHA-256 in the manifest is taken over the exact bytes that leave this
 * sink, so a reader can verify a file without knowing how it was produced.
 * write() honours backpressure, so a 1.25M-row ledger flows through at the
 * speed the ZIP is consumed and never piles up in memory.
 */
export class CsvSink {
  readonly readable: Readable;
  private readonly stringifier;
  private readonly hash = createHash('sha256');
  private rows = 0;
  private bytes = 0;
  private readonly finished: Promise<void>;

  constructor(headers: string[]) {
    this.stringifier = stringify({ header: true, columns: headers, bom: true });
    const tap = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        this.hash.update(chunk);
        this.bytes += chunk.length;
        cb(null, chunk);
      },
    });
    const out = new PassThrough();
    this.readable = out;
    this.finished = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      tap.on('error', reject);
      this.stringifier.on('error', reject);
    });
    this.stringifier.pipe(tap).pipe(out);
  }

  async write(values: string[]): Promise<void> {
    this.rows += 1;
    if (!this.stringifier.write(values)) {
      await once(this.stringifier, 'drain');
    }
  }

  async end(): Promise<CsvStats> {
    this.stringifier.end();
    await this.finished;
    return {
      rows: this.rows,
      bytes: this.bytes,
      sha256: this.hash.digest('hex'),
    };
  }
}
