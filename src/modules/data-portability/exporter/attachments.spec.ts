import { extFor, isStorageKey, safeName } from './attachments';

describe('attachments helpers', () => {
  it('tells a storage key from a URL or data URI', () => {
    expect(isStorageKey('cld:uploads/2026/11/abc.jpg')).toBe(true);
    expect(isStorageKey('db:0f1e2d3c-0000-4000-8000-000000000000')).toBe(true);
    expect(isStorageKey('logos/company.png')).toBe(true);
    expect(isStorageKey('https://cdn.example.com/logo.png')).toBe(false);
    expect(isStorageKey('data:image/png;base64,iVBOR')).toBe(false);
  });

  it('picks an extension from the MIME type, else the key', () => {
    expect(extFor('image/jpeg', 'whatever')).toBe('.jpg');
    expect(extFor(null, 'cld:a/b/c.pdf')).toBe('.pdf');
    expect(extFor(null, 'db:no-extension')).toBe('');
  });

  it('keeps original names but never a path or control character', () => {
    expect(safeName('receipt.jpg', '.jpg')).toBe('receipt.jpg');
    expect(safeName('../../etc/passwd', '.jpg')).toBe('_.._etc_passwd.jpg');
    expect(safeName('bad\u0000name', '.png')).toBe('bad_name.png');
    expect(safeName('', '.pdf')).toBe('file.pdf');
    expect(safeName('x'.repeat(150) + '.jpeg', '.jpeg')).toHaveLength(100);
    expect(safeName('x'.repeat(150) + '.jpeg', '.jpeg').endsWith('.jpeg')).toBe(
      true,
    );
  });
});
