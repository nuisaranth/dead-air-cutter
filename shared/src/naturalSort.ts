const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** "2.mp4" sorts before "10.mp4". */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

export function naturalSort<T>(items: T[], key: (t: T) => string): T[] {
  return [...items].sort((a, b) => naturalCompare(key(a), key(b)));
}
