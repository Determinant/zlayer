import { registerHooks } from 'node:module';

// Node markup tests exercise components; Playwright owns stylesheet/layout verification.
registerHooks({ resolve(specifier, context, next) {
  return specifier.endsWith('.css')
    ? { url: 'data:text/javascript,export{}', shortCircuit: true }
    : next(specifier, context);
} });
