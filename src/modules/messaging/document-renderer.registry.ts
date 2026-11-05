import { Injectable } from '@nestjs/common';

export interface RenderedDocument {
  buffer: Buffer;
  filename: string;
  mimeType: 'application/pdf';
}

/**
 * A server-side PDF for a message attachment. `args` is what enqueue() stored
 * on the row (ids only); the renderer re-reads the document when the
 * dispatcher sends, scoped to `companyId`.
 */
export interface DocumentRenderer {
  readonly name: string;
  render(
    companyId: string,
    args: Record<string, unknown>,
  ): Promise<RenderedDocument>;
}

/**
 * Renderers by name. Lives in MessagingCoreModule (a singleton however many
 * modules import it); each domain module registers its PDF service here on
 * init, so the messaging module never has to import the domain modules.
 */
@Injectable()
export class DocumentRendererRegistry {
  private readonly renderers = new Map<string, DocumentRenderer>();

  register(renderer: DocumentRenderer): void {
    this.renderers.set(renderer.name, renderer);
  }

  get(name: string): DocumentRenderer | undefined {
    return this.renderers.get(name);
  }

  names(): string[] {
    return [...this.renderers.keys()].sort();
  }
}

/** pdfkit document -> Buffer. */
export function pdfToBuffer(doc: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
    );
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
