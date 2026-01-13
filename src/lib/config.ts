import { z } from 'zod';
import { readFile } from 'node:fs/promises';

const PairSchema = z.object({
  name: z.string().min(1),
  aMint: z.string().min(1),
  bMint: z.string().min(1),
  cMint: z.string().min(1).optional(),
  amountA: z.string().regex(/^\d+$/),
  amountASteps: z.array(z.string().regex(/^\d+$/)).optional(),
  slippageBps: z.number().int().min(1).max(5000).default(50),
  slippageBpsLeg1: z.number().int().min(1).max(5000).optional(),
  slippageBpsLeg2: z.number().int().min(1).max(5000).optional(),
  slippageBpsLeg3: z.number().int().min(1).max(5000).optional(),
  includeDexes: z.array(z.string().min(1)).optional(),
  excludeDexes: z.array(z.string().min(1)).optional(),
  minProfitA: z.string().regex(/^\d+$/).default('0'),
  minProfitBps: z.number().int().min(0).max(10_000).optional(),
  cooldownMs: z.number().int().min(0).default(0),
  maxNotionalA: z.string().regex(/^\d+$/).optional(),
  computeUnitLimit: z.number().int().min(1).optional(),
  computeUnitPriceMicroLamports: z.number().int().min(0).optional(),
  baseFeeLamports: z.number().int().min(0).optional(),
  rentBufferLamports: z.number().int().min(0).optional(),
});

const ConfigSchema = z.object({
  pairs: z.array(PairSchema).min(1),
});

export type BotConfig = z.infer<typeof ConfigSchema>;
export type BotPair = z.infer<typeof PairSchema>;

export async function loadConfig(path: string): Promise<BotConfig> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return ConfigSchema.parse(parsed);
}
