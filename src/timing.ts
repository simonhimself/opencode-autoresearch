// Delays of the loop control, in one mutable object so tests can shorten them.
// (Its own module: the plugin's entry file should export nothing but the plugin.)

export const timing = {
  /**
   * How long to wait before re-sending the continue after the 1st, 2nd and 3rd failed
   * turn in a row. One more failure pauses the loop.
   */
  retryDelaysMs: [30_000, 120_000, 300_000],
  /** How long after plugin start a loop that survived a restart is continued. */
  startupDelayMs: 5_000,
}
