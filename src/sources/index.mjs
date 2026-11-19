import { fetchDiscourse } from './discourse.mjs';
import { fetchLinuxdo } from './linuxdo.mjs';
import { fetchV2ex } from './v2ex.mjs';
import { fetchGeneric } from './generic.mjs';
import { fetchNodeseek } from './nodeseek.mjs';
import { fetchRss } from './rss.mjs';

const ADAPTERS = {
  discourse: fetchDiscourse,
  linuxdo: fetchLinuxdo,
  v2ex: fetchV2ex,
  generic: fetchGeneric,
  nodeseek: fetchNodeseek,
  rss: fetchRss,
};

export function getAdapter(kind) {
  const fn = ADAPTERS[kind];
  if (!fn) throw new Error(`unknown adapter kind: ${kind}`);
  return fn;
}
