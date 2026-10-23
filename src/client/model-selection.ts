import type { WorkBuddyWebModel } from '../status-paths.ts'

/** Preserve saved IDs missing from a refreshed catalog; never silently select new models. */
export function selectableModels(catalog: readonly WorkBuddyWebModel[], selected: readonly string[]) {
  const rows = catalog.map(model => ({ id: model.id, name: model.name }))
  const seen = new Set(rows.map(row => row.id))
  for (const id of selected) if (!seen.has(id)) { rows.push({ id, name: id }); seen.add(id) }
  return rows
}

export function toggleSelected(selected: readonly string[], id: string, checked: boolean): string[] {
  return checked ? [...new Set([...selected, id])] : selected.filter(value => value !== id)
}
