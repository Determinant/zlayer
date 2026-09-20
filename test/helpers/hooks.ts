/** Minimal deterministic hook scheduler for lifecycle/race tests. Not a DOM renderer. */
export class Hooks {
  #index = 0;
  #cells: Array<{ value?: unknown; dependencies?: readonly unknown[]; cleanup?: (() => void) | undefined }> = [];
  #pending: Array<() => void> = [];

  render<T>(render: () => T): T {
    this.#index = 0;
    const result = render();
    for (const effect of this.#pending.splice(0)) effect();
    return result;
  }

  useState(initial?: unknown) {
    const index = this.#index++;
    const cell = this.#cells[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [cell.value, (next: unknown) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
  }

  useRef(initial?: unknown) { return this.useMemo(() => ({ current: initial }), []); }

  useMemo(create: () => unknown, dependencies: readonly unknown[]) {
    const index = this.#index++;
    const cell = this.#cells[index];
    if (cell && sameDependencies(cell.dependencies, dependencies)) return cell.value;
    const value = create();
    this.#cells[index] = { dependencies, value };
    return value;
  }

  useEffect(effect: () => (() => void) | void, dependencies?: readonly unknown[]) {
    const index = this.#index++;
    const cell = this.#cells[index];
    if (cell && dependencies && sameDependencies(cell.dependencies, dependencies)) return;
    this.#pending.push(() => {
      cell?.cleanup?.();
      this.#cells[index] = { ...(dependencies ? { dependencies } : {}), cleanup: effect() ?? undefined };
    });
  }

  useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot(); }
  unmount() { for (const cell of this.#cells) cell.cleanup?.(); }
}

function sameDependencies(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
  return !!left && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
}

export const hookModule = 'data:text/javascript,' + encodeURIComponent(
  ['useState', 'useRef', 'useMemo', 'useEffect', 'useSyncExternalStore']
    .map(name => `export const ${name} = (...args) => globalThis.testHooks.${name}(...args);`).join('\n'),
);
