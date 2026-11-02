// Time, passed in rather than read globally, so timer paths can be tested without waiting.

export type Clock = {
  now(): number;
  /** Runs `fn` once after `ms`. The returned function cancels it. */
  setTimeout(fn: () => void, ms: number): () => void;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
