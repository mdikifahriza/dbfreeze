import type { DeferredColumns } from '../types'

/** One foreign key: `from` table's `columns` reference `to` table. Nodes are table `file` names. */
export interface FkEdge {
  from: string
  to: string
  columns: readonly string[]
  /** every FK column is nullable */
  optional: boolean
}

export interface GraphResult {
  /** optional FK columns that sit on a cycle: null them on insert, patch afterwards */
  deferredColumns: DeferredColumns
  /** parents-first ordering constraints, after deferral (self references excluded) */
  dependsOn: Record<string, string[]>
  /** cycles that cannot be broken by deferring a nullable FK */
  warnings: string[]
}

/** Tarjan's strongly-connected-components algorithm. */
export function stronglyConnectedComponents(nodes: string[], edges: { from: string; to: string }[]): string[][] {
  const graph = new Map<string, string[]>()
  for (const n of nodes) graph.set(n, [])
  for (const e of edges) graph.get(e.from)?.push(e.to)

  let counter = 0
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []

  function strongConnect(node: string) {
    index.set(node, counter)
    lowlink.set(node, counter)
    counter++
    stack.push(node)
    onStack.add(node)

    for (const succ of graph.get(node) ?? []) {
      if (!index.has(succ)) {
        strongConnect(succ)
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(succ)!))
      } else if (onStack.has(succ)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(succ)!))
      }
    }

    if (lowlink.get(node) === index.get(node)) {
      const component: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        component.push(w)
      } while (w !== node)
      components.push(component)
    }
  }

  for (const n of nodes) if (!index.has(n)) strongConnect(n)
  return components
}

function cyclic(nodes: string[], edges: FkEdge[]): (e: FkEdge) => boolean {
  const comps = stronglyConnectedComponents(nodes, edges)
  const compOf = new Map<string, number>()
  comps.forEach((c, i) => c.forEach((n) => compOf.set(n, i)))
  return (e) => e.from === e.to || (compOf.get(e.from) === compOf.get(e.to) && comps[compOf.get(e.from)!].length > 1)
}

/**
 * Given the FK graph, decide which FK columns must be deferred and what insert order is required.
 *  - Optional FKs lying on a cycle (incl. self references) are deferred.
 *  - Whatever is left must be acyclic; a cycle that remains (all NOT NULL) yields a warning.
 */
export function analyzeForeignKeys(nodes: string[], edges: FkEdge[]): GraphResult {
  const onCycle = cyclic(nodes, edges)
  const deferred = edges.filter((e) => onCycle(e) && e.optional)

  const deferredColumns: DeferredColumns = {}
  for (const e of deferred) {
    deferredColumns[e.from] = [...new Set([...(deferredColumns[e.from] ?? []), ...e.columns])]
  }

  const remaining = edges.filter((e) => !deferred.includes(e))
  const stillCyclic = cyclic(nodes, remaining)
  const warnings: string[] = []
  for (const e of remaining) {
    if (stillCyclic(e)) {
      warnings.push(
        `${e.from}.${e.columns.join(',')} -> ${e.to} ada di dalam cycle tapi kolomnya NOT NULL — ` +
          'tidak bisa otomatis di-defer. Pertimbangkan jadikan kolom ini optional, atau urus manual.',
      )
    }
  }

  const sets = new Map<string, Set<string>>()
  for (const e of remaining) {
    if (e.from === e.to) continue
    const set = sets.get(e.from) ?? new Set<string>()
    set.add(e.to)
    sets.set(e.from, set)
  }
  const dependsOn: Record<string, string[]> = {}
  for (const [from, set] of sets) dependsOn[from] = [...set].sort()

  return { deferredColumns, dependsOn, warnings }
}
