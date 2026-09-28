import type { AhrsApi } from '../ahrs/public';
import type { HeadingListener, HeadingSource } from '../../core/map/heading';

type Consumer = { listener: HeadingListener; release?: () => void };

/** Optional provider attachment is independent of camera demand. Replacing or
 * disabling AHRS releases its leases without disturbing Ownship's GPS session. */
export function createHeadingConnection(report: (error: unknown) => void = console.error) {
  let provider: AhrsApi | undefined, revision = 0;
  const consumers = new Set<Consumer>();
  const detach = (consumer: Consumer) => {
    const release = consumer.release;
    delete consumer.release;
    try { release?.(); } catch (error) { report(error); }
  };
  const attach = (consumer: Consumer) => {
    const current = revision, api = provider;
    detach(consumer);
    consumer.listener(null);
    if (!consumers.has(consumer) || current !== revision || !api) return;
    try {
      const acquired = api.acquireHeading(sample => {
        if (consumers.has(consumer) && current === revision) consumer.listener(sample);
      });
      if (consumers.has(consumer) && current === revision) consumer.release = acquired;
      else acquired();
    } catch (error) { report(error); } // Optional aid failure leaves GPS usable.
  };
  return {
    setProvider(next: AhrsApi | undefined) {
      provider = next; revision++;
      for (const consumer of consumers) attach(consumer);
    },
    acquireHeading(listener: HeadingListener) {
      const consumer: Consumer = { listener };
      consumers.add(consumer); attach(consumer);
      return () => { consumers.delete(consumer); detach(consumer); };
    },
  } satisfies HeadingSource & { setProvider(provider: AhrsApi | undefined): void };
}
