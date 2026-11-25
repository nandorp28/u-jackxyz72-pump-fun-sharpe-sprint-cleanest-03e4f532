// SteadyClip — entrypoint. Thin wiring only: the strategy lives in strategy.ts,
// the wire protocol in vendor/makefun-bot.ts.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
