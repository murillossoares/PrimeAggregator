import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Decision = {
  profitable: boolean;
  profit: string;
  conservativeProfit: string;
};

type RustEngine = {
  request(line: string): Promise<string>;
};

let rustEngineCache: { path: string; engine: RustEngine } | undefined;

function decideInTs(params: {
  amountIn: string;
  quote2Out: string;
  quote2MinOut: string;
  minProfit: string;
  feeEstimateLamports: string;
}): Decision {
  const amountIn = BigInt(params.amountIn);
  const out = BigInt(params.quote2Out);
  const outMin = BigInt(params.quote2MinOut);
  const minProfit = BigInt(params.minProfit);
  const feeEstimate = BigInt(params.feeEstimateLamports);

  const profit = out - amountIn - feeEstimate;
  const conservativeProfit = outMin - amountIn - feeEstimate;

  return {
    profitable: conservativeProfit >= minProfit,
    profit: profit.toString(),
    conservativeProfit: conservativeProfit.toString(),
  };
}

function getRustEngine(rustCalcPath: string): RustEngine {
  if (rustEngineCache?.path === rustCalcPath) return rustEngineCache.engine;

  const child = spawn(rustCalcPath, { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = createInterface({ input: child.stdout });

  const pending: Array<(line: string) => void> = [];
  rl.on('line', (line) => pending.shift()?.(line));

  const engine: RustEngine = {
    async request(line: string) {
      const response = await new Promise<string>((resolve, reject) => {
        pending.push(resolve);
        child.once('error', reject);
        child.stderr.once('data', (d) => reject(new Error(String(d))));
        child.stdin.write(`${line}\n`);
      });
      return response;
    },
  };

  rustEngineCache = { path: rustCalcPath, engine };
  return engine;
}

async function decideInRust(params: {
  rustCalcPath: string;
  amountIn: string;
  quote1Out: string;
  quote1MinOut: string;
  quote2Out: string;
  quote2MinOut: string;
  minProfit: string;
  feeEstimateLamports: string;
}): Promise<Decision> {
  const engine = getRustEngine(params.rustCalcPath);
  const request = JSON.stringify({
    amountIn: params.amountIn,
    quote1Out: params.quote1Out,
    quote1MinOut: params.quote1MinOut,
    quote2Out: params.quote2Out,
    quote2MinOut: params.quote2MinOut,
    minProfit: params.minProfit,
    feeEstimateLamports: params.feeEstimateLamports,
  });
  const responseLine = await engine.request(request);
  return JSON.parse(responseLine) as Decision;
}

export async function decideWithOptionalRust(params: {
  useRust: boolean;
  rustCalcPath: string;
  amountIn: string;
  quote1Out: string;
  quote1MinOut: string;
  quote2Out: string;
  quote2MinOut: string;
  minProfit: string;
  feeEstimateLamports: string;
}): Promise<Decision> {
  if (!params.useRust) {
    return decideInTs({
      amountIn: params.amountIn,
      quote2Out: params.quote2Out,
      quote2MinOut: params.quote2MinOut,
      minProfit: params.minProfit,
      feeEstimateLamports: params.feeEstimateLamports,
    });
  }

  try {
    return await decideInRust(params);
  } catch {
    return decideInTs({
      amountIn: params.amountIn,
      quote2Out: params.quote2Out,
      quote2MinOut: params.quote2MinOut,
      minProfit: params.minProfit,
      feeEstimateLamports: params.feeEstimateLamports,
    });
  }
}
