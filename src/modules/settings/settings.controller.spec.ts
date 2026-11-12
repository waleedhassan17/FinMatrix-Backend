import { GoneException } from '@nestjs/common';
import {
  SettingsController,
  SETTINGS_EXPORT_IMPORT_MOVED,
} from './settings.controller';

/**
 * The retired export/import routes answer 410 with where the features moved,
 * so an old client never mistakes "moved" for "broken".
 */
describe('SettingsController — retired export/import routes', () => {
  const ctrl = new SettingsController(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const gone = (fn: () => unknown): { code: string; message: string } => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(GoneException);
      const err = e as GoneException;
      expect(err.getStatus()).toBe(410);
      return err.getResponse() as { code: string; message: string };
    }
    throw new Error('expected a GoneException');
  };

  it('GET /settings/export is 410 MOVED and names the backup endpoint', () => {
    const body = gone(() => ctrl.exportData());
    expect(body).toEqual(SETTINGS_EXPORT_IMPORT_MOVED);
    expect(body.code).toBe('MOVED');
    expect(body.message).toContain('/data-portability/exports');
  });

  it('POST /settings/import is 410 MOVED and names the migrations endpoint', () => {
    const body = gone(() => ctrl.importData());
    expect(body.code).toBe('MOVED');
    expect(body.message).toContain('/migrations');
  });
});
