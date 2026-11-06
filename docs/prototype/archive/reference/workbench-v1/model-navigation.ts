/** A module's edges are derived from its actual child relationships, preserving their endpoints. */
export function relationsForScope<T extends { source: string; target: string }>(relations: T[], scope: string): T[] {
  const contains = (id: string) => id === scope || id.startsWith(scope + '.')
  return relations.filter(relation => contains(relation.source) || contains(relation.target))
}
