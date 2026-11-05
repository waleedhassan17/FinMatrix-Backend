import { BadRequestException } from '@nestjs/common';
import { toWhatsappE164 } from './phone.util';

/** The WhatsApp fields a customer or vendor carries (see MessagingFoundation). */
export interface WhatsappContactFields {
  phone: string | null;
  whatsappE164: string | null;
  whatsappOptInAt: Date | null;
  whatsappOptInBy: string | null;
  whatsappVerifiedAt: Date | null;
  preferredLanguage: 'en' | 'ur' | null;
}

export interface WhatsappContactInput {
  phone?: string | null;
  /** Explicit WhatsApp number; '' or null clears it. */
  whatsappPhone?: string | null;
  /** true records consent now (by `userId`), false withdraws it. */
  whatsappOptIn?: boolean;
  preferredLanguage?: 'en' | 'ur' | null;
}

/**
 * Apply WhatsApp fields from a create/update DTO onto a customer or vendor.
 *
 * - `whatsappPhone` sent: normalised with the app's rule; an unusable number is
 *   a 400 INVALID_WHATSAPP_NUMBER, never a silently wrong recipient.
 * - `whatsappPhone` not sent but `phone` changed: the WhatsApp number is
 *   re-derived from the new phone (NULL if it does not normalise).
 * - Any change of number clears whatsapp_verified_at: delivery to the old
 *   number proves nothing about the new one.
 * - Opt-out (STOP) is never cleared here; only the contact can lift it.
 *
 * Call AFTER `phone` has been assigned on the entity. `previousPhone` is the
 * phone before this request (undefined on create).
 */
export function applyWhatsappContactFields(
  entity: WhatsappContactFields,
  dto: WhatsappContactInput,
  opts: {
    userId?: string | null;
    previousPhone?: string | null;
    isCreate?: boolean;
  },
): void {
  const before = entity.whatsappE164 ?? null;

  if (dto.whatsappPhone !== undefined) {
    const raw =
      dto.whatsappPhone === null ? '' : String(dto.whatsappPhone).trim();
    if (raw === '') {
      entity.whatsappE164 = null;
    } else {
      const e164 = toWhatsappE164(raw);
      if (!e164) {
        throw new BadRequestException({
          code: 'INVALID_WHATSAPP_NUMBER',
          message:
            'That is not a WhatsApp number. Use a mobile number such as 0300 1234567 or +92 300 1234567.',
        });
      }
      entity.whatsappE164 = e164;
    }
  } else if (
    opts.isCreate ||
    (dto.phone !== undefined &&
      (dto.phone ?? null) !== (opts.previousPhone ?? null))
  ) {
    entity.whatsappE164 = toWhatsappE164(entity.phone);
  }

  if ((entity.whatsappE164 ?? null) !== before)
    entity.whatsappVerifiedAt = null;

  if (dto.whatsappOptIn === true) {
    if (!entity.whatsappOptInAt) {
      entity.whatsappOptInAt = new Date();
      entity.whatsappOptInBy = opts.userId ?? null;
    }
  } else if (dto.whatsappOptIn === false) {
    entity.whatsappOptInAt = null;
    entity.whatsappOptInBy = null;
  }

  if (dto.preferredLanguage !== undefined)
    entity.preferredLanguage = dto.preferredLanguage ?? null;
}
