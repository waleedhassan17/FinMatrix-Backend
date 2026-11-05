import { templateCreatePayload } from './template-payload';
import { TEMPLATES, templateForEvent } from './template-registry';

describe('templateCreatePayload', () => {
  const opts = {
    webAppUrl: 'https://finmatrix.example/',
    sampleDocumentHandle: 'h:123',
  };

  it('builds a UTILITY template with body examples in placeholder order and the footer', () => {
    const { payload } = templateCreatePayload(
      templateForEvent('invoice_issued'),
      'en',
      opts,
    );
    expect(payload).toMatchObject({
      name: 'fm_invoice_issued',
      language: 'en',
      category: 'UTILITY',
    });
    const comps = (payload!.components as Array<Record<string, unknown>>).map(
      (c) => c.type,
    );
    expect(comps).toEqual(['HEADER', 'BODY', 'FOOTER']);
    const body = (payload!.components as Array<Record<string, any>>)[1];
    expect(body.example.body_text[0][0]).toBe('Warehouse Co');
    expect(body.example.body_text[0]).toHaveLength(5);
  });

  it('adds the approval link button with the web app URL', () => {
    const { payload } = templateCreatePayload(
      templateForEvent('approval_pending'),
      'ur',
      opts,
    );
    const buttons = (payload!.components as Array<Record<string, any>>).find(
      (c) => c.type === 'BUTTONS',
    );
    expect(buttons!.buttons[0].url).toBe(
      'https://finmatrix.example/approvals/{{1}}',
    );
  });

  it('reports a document template it cannot submit without a sample handle', () => {
    const r = templateCreatePayload(templateForEvent('remittance'), 'en', {
      webAppUrl: 'x',
    });
    expect(r.payload).toBeNull();
    expect(r.problem).toMatch(/SAMPLE_DOCUMENT_HANDLE/);
  });

  it('every template and language produces a payload', () => {
    for (const t of TEMPLATES) {
      for (const lang of ['en', 'ur'] as const) {
        expect(templateCreatePayload(t, lang, opts).payload).not.toBeNull();
      }
    }
  });
});
