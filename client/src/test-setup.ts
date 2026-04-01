// Polyfill localStorage for Node.js test environment
const store = new Map<string, string>()

globalThis.localStorage = {
  getItem(key: string): string | null {
    return store.get(key) ?? null
  },
  setItem(key: string, value: string): void {
    store.set(key, value)
  },
  removeItem(key: string): void {
    store.delete(key)
  },
  clear(): void {
    store.clear()
  },
  get length(): number {
    return store.size
  },
  key(index: number): string | null {
    const keys = [...store.keys()]
    return keys[index] ?? null
  },
} as Storage
