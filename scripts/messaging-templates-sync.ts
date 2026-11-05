/**
 * FinMatrix Connect — create the WhatsApp message templates that are missing
 * on the WhatsApp Business Account, and print every template's status.
 *
 * It NEVER deletes or edits a template. Re-running it is safe: a template
 * that exists (in any status) is left alone and only reported.
 *
 *   WHATSAPP_WABA_ID=…  WHATSAPP_ACCESS_TOKEN=…  WHATSAPP_GRAPH_VERSION=v26.0 \
 *   WEB_APP_URL=https://finmatrix-theta.vercel.app \
 *   WHATSAPP_APP_ID=…   # the Meta app; uploads the sample PDF Meta asks for
 *   [WHATSAPP_SAMPLE_DOCUMENT_HANDLE=…]   # or pass a handle you already have
 *   [TEMPLATE_LANGUAGES=en]               # only these languages (default en,ur)
 *   [DRY_RUN=1]                           # print what would be created
 *     npm run messaging:templates:sync
 *
 * Templates with a PDF header must be submitted with an example file. The
 * script renders a sample invoice with the real document layout and uploads
 * it through Meta's Resumable Upload API (POST /{app-id}/uploads, then the
 * bytes to the upload session) to get that handle.
 *
 * Urdu bodies are marked NEEDS NATIVE REVIEW in template-registry.ts: have a
 * native speaker check them before submitting, because an approved template's
 * text cannot be edited, only replaced.
 */
import { TEMPLATES } from '../src/modules/messaging/templates/template-registry';
import { templateCreatePayload } from '../src/modules/messaging/templates/template-payload';
import { renderDocumentPdf } from '../src/common/pdf/document-pdf.util';

const env = (k: string) => (process.env[k] ?? '').trim();

async function graph(path: string, init: RequestInit = {}) {
  const url = `https://graph.facebook.com/${env('WHATSAPP_GRAPH_VERSION')}/${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${env('WHATSAPP_ACCESS_TOKEN')}`,
      'Content-Type': 'application/json',
    },
  });
  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!res.ok) {
    const e =
      (json?.error as { message?: string; code?: number } | undefined) ?? {};
    throw new Error(
      `${res.status} ${e.code ?? ''} ${e.message ?? 'request failed'}`,
    );
  }
  return json ?? {};
}

/** A sample invoice in the real layout, for Meta's template review. */
function samplePdf(): Promise<Buffer> {
  return renderDocumentPdf({
    kind: 'Invoice',
    number: 'INV-0001',
    company: {
      name: 'Your Company',
      addressLines: ['Karachi, Pakistan'],
      contactLines: [],
    },
    party: { label: 'Bill to', name: 'Customer', lines: [] },
    meta: [
      { label: 'Invoice date', value: '1 Nov 2026' },
      { label: 'Due date', value: '15 Nov 2026' },
    ],
    lines: [{ description: 'Sample item', quantity: '1', amount: '1000' }],
    totals: [{ label: 'Total', value: '1000', grand: true }],
  });
}

/**
 * The example-file handle for templates with a PDF header: the one given in
 * WHATSAPP_SAMPLE_DOCUMENT_HANDLE, else a sample PDF uploaded now with
 * WHATSAPP_APP_ID, else null (those templates are then reported, not sent).
 */
async function sampleDocumentHandle(dry: boolean): Promise<string | null> {
  const given = env('WHATSAPP_SAMPLE_DOCUMENT_HANDLE');
  if (given) return given;
  if (!TEMPLATES.some((t) => t.header === 'DOCUMENT')) return null;
  const appId = env('WHATSAPP_APP_ID');
  if (!appId) {
    console.log(
      '  (set WHATSAPP_APP_ID to upload the sample PDF; templates with a PDF header wait until then)',
    );
    return null;
  }
  const pdf = await samplePdf();
  if (dry) {
    console.log(
      `  would upload a ${pdf.length}-byte sample PDF to app ${appId}`,
    );
    return 'DRY_RUN_SAMPLE_HANDLE';
  }
  const session = (await graph(
    `${encodeURIComponent(appId)}/uploads?file_name=finmatrix-sample-invoice.pdf` +
      `&file_length=${pdf.length}&file_type=application/pdf`,
    { method: 'POST' },
  )) as { id?: string };
  if (!session.id) throw new Error('Meta returned no upload session id');
  // The bytes go to the session itself; this call wants the token as "OAuth".
  const res = await fetch(
    `https://graph.facebook.com/${env('WHATSAPP_GRAPH_VERSION')}/${session.id}`,
    {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${env('WHATSAPP_ACCESS_TOKEN')}`,
        file_offset: '0',
      },
      body: new Uint8Array(pdf),
    },
  );
  const json = (await res.json().catch(() => null)) as {
    h?: string;
    error?: { message?: string };
  } | null;
  if (!res.ok || !json?.h) {
    throw new Error(
      `sample PDF upload failed: ${res.status} ${json?.error?.message ?? ''}`,
    );
  }
  console.log('  sample PDF uploaded for the templates with a PDF header');
  return json.h;
}

async function main() {
  const missing = [
    'WHATSAPP_WABA_ID',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_GRAPH_VERSION',
    'WEB_APP_URL',
  ].filter((k) => !env(k));
  if (missing.length) {
    console.error(`Set ${missing.join(', ')} first.`);
    process.exit(2);
  }
  const dry = env('DRY_RUN') === '1';
  const waba = env('WHATSAPP_WABA_ID');
  const handle = await sampleDocumentHandle(dry);
  // e.g. English first while the Urdu texts wait for a native speaker's check.
  const languages = (env('TEMPLATE_LANGUAGES') || 'en,ur')
    .split(',')
    .map((l) => l.trim())
    .filter((l): l is 'en' | 'ur' => l === 'en' || l === 'ur');

  // Everything on the account (paged), keyed name/language.
  const existing = new Map<string, string>();
  let next: string | null =
    `${waba}/message_templates?fields=name,language,status&limit=100`;
  while (next) {
    const page = (await graph(next)) as {
      data?: Array<{ name: string; language: string; status: string }>;
      paging?: { next?: string };
    };
    for (const t of page.data ?? [])
      existing.set(`${t.name}/${t.language}`, t.status);
    const after = page.paging?.next ? new URL(page.paging.next) : null;
    next = after ? `${waba}/message_templates${after.search}` : null;
  }

  let created = 0;
  let problems = 0;
  for (const t of TEMPLATES) {
    for (const language of languages) {
      const key = `${t.name}/${language}`;
      const status = existing.get(key);
      if (status) {
        console.log(`  ${key.padEnd(32)} ${status}`);
        continue;
      }
      const { payload, problem } = templateCreatePayload(t, language, {
        webAppUrl: env('WEB_APP_URL'),
        sampleDocumentHandle: handle,
      });
      if (!payload) {
        problems++;
        console.log(`! ${key.padEnd(32)} not submitted: ${problem}`);
        continue;
      }
      if (dry) {
        console.log(
          `+ ${key.padEnd(32)} would create:\n${JSON.stringify(payload, null, 2)}`,
        );
        continue;
      }
      try {
        const r = (await graph(`${waba}/message_templates`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })) as {
          status?: string;
        };
        created++;
        console.log(`+ ${key.padEnd(32)} created (${r.status ?? 'PENDING'})`);
      } catch (e) {
        problems++;
        console.log(`! ${key.padEnd(32)} ${(e as Error).message}`);
      }
    }
  }
  console.log(
    `\n${created} created, ${problems} need attention. Nothing was deleted.`,
  );
  process.exit(problems ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
