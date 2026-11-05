import { MessageLanguage } from '../messaging.constants';
import { TemplateDef } from './template-registry';

/**
 * The body Meta's POST /{waba-id}/message_templates expects for one template
 * in one language. Pure, so it is unit-tested; the sync script only adds the
 * HTTP calls around it.
 *
 * Document headers need a sample file handle (Resumable Upload API) when the
 * template is submitted: pass it as `sampleDocumentHandle`, or the template is
 * reported as needing one instead of being submitted half-formed.
 */
export function templateCreatePayload(
  t: TemplateDef,
  language: MessageLanguage,
  opts: { webAppUrl: string; sampleDocumentHandle?: string | null },
): { payload: Record<string, unknown> | null; problem: string | null } {
  const text = t.text[language] ?? t.text.en;
  const components: Array<Record<string, unknown>> = [];

  if (t.header === 'DOCUMENT') {
    if (!opts.sampleDocumentHandle) {
      return {
        payload: null,
        problem:
          'needs WHATSAPP_SAMPLE_DOCUMENT_HANDLE (a sample PDF handle) to submit',
      };
    }
    components.push({
      type: 'HEADER',
      format: 'DOCUMENT',
      example: { header_handle: [opts.sampleDocumentHandle] },
    });
  } else if (t.header === 'TEXT' && text.header) {
    components.push({ type: 'HEADER', format: 'TEXT', text: text.header });
  }

  components.push({
    type: 'BODY',
    text: text.body,
    example: { body_text: [t.params.map((p) => t.example[p] ?? p)] },
  });
  components.push({ type: 'FOOTER', text: t.footer });

  if (t.urlButton) {
    const base = `${opts.webAppUrl.replace(/\/$/, '')}/approvals/`;
    components.push({
      type: 'BUTTONS',
      buttons: [
        {
          type: 'URL',
          text: text.button ?? 'Open',
          url: `${base}{{1}}`,
          example: [`${base}${t.example[t.urlButton.param] ?? 'example'}`],
        },
      ],
    });
  }

  return {
    payload: { name: t.name, language, category: t.category, components },
    problem: null,
  };
}
