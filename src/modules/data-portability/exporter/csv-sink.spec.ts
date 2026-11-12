import { createHash } from 'crypto';
import { CsvSink } from './csv-sink';

const collect = async (sink: CsvSink) => {
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    sink.readable.on('data', (c: Buffer) => chunks.push(c));
    sink.readable.on('end', resolve);
    sink.readable.on('error', reject);
  });
  return { done, bytes: () => Buffer.concat(chunks) };
};

describe('CsvSink', () => {
  it('starts with a UTF-8 BOM and the header, even with no rows', async () => {
    const sink = new CsvSink(['id', 'name']);
    const out = await collect(sink);
    const stats = await sink.end();
    await out.done;
    const bytes = out.bytes();
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.subarray(3).toString('utf8')).toBe('id,name\n');
    expect(stats.rows).toBe(0);
    expect(stats.bytes).toBe(bytes.length);
  });

  it('writes rows exactly, quotes what needs quoting, and hashes the bytes', async () => {
    const sink = new CsvSink(['id', 'name', 'amount']);
    const out = await collect(sink);
    await sink.write(['1', 'Al-Noor Traders, Lahore', '1200.5000']);
    await sink.write(['2', 'گاہک "اعلیٰ"', '-15.0000']);
    const stats = await sink.end();
    await out.done;
    const text = out.bytes().subarray(3).toString('utf8');
    expect(text).toBe(
      'id,name,amount\n1,"Al-Noor Traders, Lahore",1200.5000\n2,"گاہک ""اعلیٰ""",-15.0000\n',
    );
    expect(stats.rows).toBe(2);
    expect(stats.sha256).toBe(
      createHash('sha256').update(out.bytes()).digest('hex'),
    );
  });

  it('survives many rows without holding them all (backpressure path)', async () => {
    const sink = new CsvSink(['n', 'text']);
    const out = await collect(sink);
    const n = 20_000;
    for (let i = 0; i < n; i++) await sink.write([String(i), 'x'.repeat(50)]);
    const stats = await sink.end();
    await out.done;
    expect(stats.rows).toBe(n);
    expect(out.bytes().toString('utf8').split('\n').length).toBe(n + 2);
  });
});
