/**
 * FatSecret represents every diary/weight/exercise date as an integer count
 * of days since 1970-01-01 UTC (`date_int`) — not a Unix timestamp, not an
 * ISO string. Conversion must be pure UTC day math so it's DST/timezone-
 * independent (a local-time `Date` field would drift the day on either side
 * of midnight depending on the server's timezone).
 */

const MS_PER_DAY = 86_400_000;

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Convert a "YYYY-MM-DD" date string to FatSecret's days-since-epoch integer. */
export function toFatSecretDate(ymd: string): number {
  if (!YMD_PATTERN.test(ymd)) {
    throw new Error(`Expected a YYYY-MM-DD date, got: ${ymd}`);
  }
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / MS_PER_DAY);
}

/** Convert a FatSecret days-since-epoch integer back to a "YYYY-MM-DD" string. */
export function fromFatSecretDate(days: number): string {
  const iso = new Date(days * MS_PER_DAY).toISOString();
  return iso.slice(0, 10);
}

/** Today's date as FatSecret's days-since-epoch integer, in UTC. */
export function todayFatSecretDate(): number {
  return Math.floor(Date.now() / MS_PER_DAY);
}
