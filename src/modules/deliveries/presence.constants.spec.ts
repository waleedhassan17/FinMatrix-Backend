import { LOCATION_LIVE_WINDOW_MS, isLocationLive } from './presence.constants';

/**
 * The window is mirrored by the web client, so its boundary is a contract
 * rather than an implementation detail.
 */
describe('rider presence', () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);
  const agoMs = (ms: number) => new Date(now - ms);

  it('is live just inside the window', () => {
    expect(isLocationLive(agoMs(LOCATION_LIVE_WINDOW_MS - 1_000), now)).toBe(true);
  });

  it('is not live just outside it', () => {
    expect(isLocationLive(agoMs(LOCATION_LIVE_WINDOW_MS + 1_000), now)).toBe(false);
  });

  it('is not live on the boundary itself', () => {
    // Strictly less-than, matching what getMapData did before this was hoisted.
    expect(isLocationLive(agoMs(LOCATION_LIVE_WINDOW_MS), now)).toBe(false);
  });

  it('treats a rider who has never reported as not live — NOT as off duty', () => {
    // The distinction this module exists for: no GPS is not the same as not
    // working, and the monitor must not confuse the two.
    expect(isLocationLive(null, now)).toBe(false);
    expect(isLocationLive(undefined, now)).toBe(false);
  });
});
