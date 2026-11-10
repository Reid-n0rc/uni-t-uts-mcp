/** Bounded retry planning shared by the `auto` probe and the VXI-11 transport (issue #127). */

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 500;
const MIN_ATTEMPT_MS = 50;

export interface AttemptPlan {
  attempts: number;
  /** Time allowed for each attempt, in ms. */
  perAttemptMs: number;
  /** Pause before attempt n+1 (index n), doubling each time. */
  backoffsMs: number[];
}

/**
 * Split a total budget into `attempts` tries with doubling pauses between them, so the whole thing,
 * pauses included, stays within `budgetMs` (never less than a minimal slice per attempt).
 */
export function planAttempts(budgetMs: number, attempts = DEFAULT_ATTEMPTS, backoffMs = DEFAULT_BACKOFF_MS): AttemptPlan {
  const backoffsMs = Array.from({ length: Math.max(0, attempts - 1) }, (_, i) => backoffMs * 2 ** i);
  const pauses = backoffsMs.reduce((a, b) => a + b, 0);
  return { attempts, perAttemptMs: Math.max(MIN_ATTEMPT_MS, Math.floor((budgetMs - pauses) / attempts)), backoffsMs };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
