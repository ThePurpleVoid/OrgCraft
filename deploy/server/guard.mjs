// Which migration statements need the owner's OK before they run (docs/team/protocols.md: never destructive without
// the owner). It errs on the side of asking: a false alarm costs one approval, a miss can lose data.
import { split } from '../../apps/server/db.mjs';

// Any DROP of something that holds data, TRUNCATE, DELETE FROM, a rename, or a column type change. String literals are
// blanked first. Only dropping an index, a plain view, a column default or NOT NULL runs without asking (migration 013
// replaces an index this way): none of them loses rows or loosens tenant isolation. Dropping a policy, trigger, function
// or constraint loses no rows but can open rows to other tenants (a tenant-guard trigger, a security-definer function a
// policy uses, a foreign key or check), so it asks. Any DROP with CASCADE asks whatever it names, because CASCADE takes
// dependents with it: columns and their data, or the policies that use a function.
export const DESTRUCTIVE = /\b(drop\s+(?!(?:index|view|default|not\s+null)\b)[a-z]|drop\b[^;]*\bcascade\b|truncate\b|delete\s+from\b|rename\s+(to|column)\b|alter\s+column\s+\S+\s+(set\s+data\s+)?type\b)/i;

export function destructiveStatements(sql) {
  return split(sql).filter((s) => DESTRUCTIVE.test(s.replace(/'[^']*'/g, "''")));
}
