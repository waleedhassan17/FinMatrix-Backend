/**
 * FinMatrix Connect — create the WhatsApp message templates that are missing
 * on the WhatsApp Business Account, and print every template's status.
 *
 * It NEVER deletes or edits a template. Re-running it is safe: a template
 * that exists (in any status) is left alone and only reported.
 *
 *   WHATSAPP_WABA_ID=…  WHATSAPP_ACCESS_TOKEN=…  WHATSAPP_GRAPH_VERSION=v21.0 \
 *   WEB_APP_URL=https://finmatrix-theta.vercel.app \
 *   [WHATSAPP_SAMPLE_DOCUMENT_HANDLE=…]   # needed for templates with a PDF header
 *   [DRY_RUN=1]                           # print what would be created
 *     npm run messaging:templates:sync
 *
 * Urdu bodies are marked NEEDS NATIVE REVIEW in template-registry.ts: have a
 * native speaker check them before submitting, because an approved template's
 * text cannot be edited, only replaced.
 */
import { TEMPLATES } from '../src/modules/messaging/templates/template-registry';
import { templateCreatePayload } from '../src/modules/messaging/templates/template-payload';

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
    for (const language of ['en', 'ur'] as const) {
      const key = `${t.name}/${language}`;
      const status = existing.get(key);
      if (status) {
        console.log(`  ${key.padEnd(32)} ${status}`);
        continue;
      }
      const { payload, problem } = templateCreatePayload(t, language, {
        webAppUrl: env('WEB_APP_URL'),
        sampleDocumentHandle: env('WHATSAPP_SAMPLE_DOCUMENT_HANDLE') || null,
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
