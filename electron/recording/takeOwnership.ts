/**
 * Who a shared resource belongs to now, so a late cleanup cannot end the next user's.
 *
 * The cursor sampler is one process-wide session. A take whose start timed out (12 s, seen
 * with the CPU at 100 %) cleans up after several awaits -- killing a helper that is slow to
 * die, removing its files -- and its "stop the cursor sampler" used to stop whatever session
 * was running by then: the NEXT take's, which came out with 121 cursor samples. Each start
 * claims a token; a cleanup only acts while its token is still the current one.
 */
export class TakeOwnership {
	private current = 0;

	/** A new owner; every earlier token stops owning. */
	claim(): number {
		this.current += 1;
		return this.current;
	}

	/** The token of whoever owns it now (0 before anyone claimed it). */
	get token(): number {
		return this.current;
	}

	owns(token: number): boolean {
		return token === this.current;
	}
}
