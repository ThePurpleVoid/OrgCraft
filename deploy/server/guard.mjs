// Which migration statements need the owner's OK before they run (docs/team/protocols.md: never destructive without
// the owner). It errs on the side of asking: a false alarm costs one approval, a miss can lose data.
import { split } from '../../apps/server/db.mjs';

// Any DROP of something that holds data, TRUNCATE, DELETE FROM, a rename, or a column type change. String literals are
// blanked first. Dropping an index, constraint, trigger, function, policy, plain view, a column default or NOT NULL
// loses no rows, so it runs without asking (migration 013 replaces an index this way).
export const DESTRUCTIVE = /\b(drop\s+(?!(?:index|constraint|trigger|function|policy|view|default|not\s+null)\b)[a-z]|truncate\b|delete\s+from\b|rename\s+(to|column)\b|alter\s+column\s+\S+\s+(set\s+data\s+)?type\b)/i;

export function destructiveStatements(sql) {
  return split(sql).filter((s) => DESTRUCTIVE.test(s.replace(/'[^']*'/g, "''")));
}
