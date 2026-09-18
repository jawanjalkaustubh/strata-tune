/**
 * The Headroom sentences that appear on more than one surface (plan sections 16, 27a; phase 8
 * follow-up item 6), written once so the warning, the page header and the tests agree.
 */

/** What is actually written, in one sentence: on the warning and the Tune page header (user agreed 2026-09-16). */
export const WRITES_SENTENCE = 'Strata Tune never changes voltage, power limits or fan curves, and writes nothing to the CPU; it only adds small clock offsets under the driver\'s own limits. The risk is a crash, not a fried card.';

/** The same sentence with the route named, for the warning's own copy. */
export const WRITES_SENTENCE_WITH_ROUTE = WRITES_SENTENCE.replace("driver's own limits.", "driver's own limits (NvAPI_GPU_SetPstates20, core and memory deltas).");

/** The warning's one line about the route, after the body has already said nothing changes voltage, power limits or fans (plan 27a: short; the clause is not repeated). */
export const WRITES_ROUTE_LINE = 'The only write is NvAPI_GPU_SetPstates20, core and memory clock deltas under the driver\'s own limits; nothing touches the CPU.';

/** Plan 17d, gaming laptops: the vendor app has an OC or turbo mode of its own, and the hunt measures on top of whatever it is set to. */
export const WARNING_LAPTOP_LINE = 'If your vendor app (Armoury Crate, Legion Vantage, Omen Gaming Hub) has an OC or turbo mode, leave it where you normally run it: Headroom measures on top of it.';

/** The Headroom warning's body, verbatim from plan section 27a. */
export const WARNING_BODY =
  'Strata Tune adds small clock steps on top of your current tune and tests each one for about a minute with a workload whose result it can check. It stops at the first small mistake — a wrong result or a driver reset — long before the card would hang. You may see the screen freeze for a second or two when the driver resets; that is the signal we stop on. Nothing changes voltage, power limits or fans, and the card is left exactly as it was found; you type the values it finds into your vendor\'s tool.';

/** The one risk line beneath it. */
export const WARNING_RISK = 'A crash can still lose unsaved work in other apps — save first — and any overclock you then apply yourself is at your own risk and may affect your warranty.';

/** The page header's product sentence (plan section 16, 'every rung is scored'). */
export const HEADROOM_TAGLINE = "Headroom — finds your card's highest stable score without the hang.";

/** The header on a machine without a supported card (plan 17d): no hunt is offered, so no product sentence about one. */
export const HEADROOM_NEEDS_NVIDIA = 'Headroom needs an NVIDIA card.';

/** The section's one line while the settings switch is off. */
export const HEADROOM_OFF = "Headroom hunt — off. It finds how far your card's clocks go and hands you the values for your vendor tool.";
