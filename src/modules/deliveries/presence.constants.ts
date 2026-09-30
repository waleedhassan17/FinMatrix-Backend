// ═══════════════════════════════════════════════════════
// FinMatrix — Rider presence
// ═══════════════════════════════════════════════════════
// There are TWO things that could be called "a rider is online", and conflating
// them is what made the Delivery Monitor disagree with the Riders page:
//
//   DUTY      `delivery_personnel_profiles.is_available` — the rider tapped
//             "On duty" in the app. This is what the dispatcher assigns on
//             (deliveries.service autoAssign), so it is what "online" means to
//             anyone looking at a monitor to decide who can take a job.
//
//   LOCATION  `location_updated_at` within the window below — the phone is
//             currently reporting GPS. This is a property of the handset, not
//             of the person: a rider in a basement is still on duty.
//
// Keep them apart. A monitor that hides an on-duty rider because their phone
// has not pinged in two minutes is showing the dispatcher the wrong answer.
//
// The window was previously written out three times — here, in
// delivery-personnel.service.getLocation, and again in the web client's
// models/delivery.ts. Two of those are now this constant; the web mirrors it
// and says so.

/** A location ping counts as live for this long. Mirrored in FinMatrix-Web/src/models/delivery.ts. */
export const LOCATION_LIVE_WINDOW_MS = 2 * 60 * 1000;

/** Is this rider's phone currently reporting its position? Not "is the rider working". */
export const isLocationLive = (
  locationUpdatedAt: Date | null | undefined,
  now: number = Date.now(),
): boolean =>
  !!locationUpdatedAt && now - locationUpdatedAt.getTime() < LOCATION_LIVE_WINDOW_MS;
