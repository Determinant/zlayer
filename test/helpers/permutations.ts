/** Every arrival order, including one empty order. Inputs remain unchanged. */
export function* permutations<T>(values: readonly T[]): Generator<T[]> {
  if (!values.length) { yield []; return; }
  for (let i = 0; i < values.length; i++)
    for (const rest of permutations(values.filter((_, index) => index !== i))) yield [values[i]!, ...rest];
}

/** Every way to split an arrival order into consecutive, nonempty deliveries. */
export function* batchPartitions<T>(values: readonly T[]): Generator<T[][]> {
  if (!values.length) { yield []; return; }
  for (let mask = 0; mask < 2 ** (values.length - 1); mask++) {
    const batches: T[][] = [[]];
    values.forEach((value, i) => { if (i && mask & 1 << (i - 1)) batches.push([]); batches.at(-1)!.push(value); });
    yield batches;
  }
}
