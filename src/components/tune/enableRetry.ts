/**
 * One flag between the Settings modal and the Tune page: the modal sets it when its own
 * enable call could not reach the collector, and the page consumes it to retry once. The
 * page never retries just because the collector's file flag reads false, since that flag
 * may have been cleared on purpose (from the modal, or from another instance sharing the
 * collector), and a retry loop would silently undo it.
 */
let pending = false;

export function markEnableFailed(): void {
  pending = true;
}

export function takeEnableRetry(): boolean {
  const take = pending;
  pending = false;
  return take;
}
