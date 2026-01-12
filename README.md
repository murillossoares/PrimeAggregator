# PrimeAggregator (Jupiter-only MVP)

Bot de arbitragem (MVP) focado em Jupiter. Faz loop `A -> B -> A`, com execucao atomica opcional (uma unica transacao) e modo dry-run com simulacao.

## Requisitos

- Node.js >= 20
- (Opcional) Rust toolchain para `rust/arb_calc`

## Setup

1) Instale dependencias:

- PowerShell com policy restrita: `npm.cmd install`
- Outros shells: `npm install`

2) Crie `.env` usando `.env.example`.

3) Copie `config.example.json` para `config.json` e ajuste `pairs`.

## Rodar

- Dev: `npm.cmd run dev`
- Build: `npm.cmd run build`
- Start: `npm.cmd run start`

## Setup wallet (ATAs)

Cria ATAs idempotentes para os mints em `config.json`:

- `npm.cmd run dev -- --setup-wallet`

Opcional (apenas `MODE=live`): rodar automaticamente no startup:

- `AUTO_SETUP_WALLET=true`

## Execucao atomica

- `EXECUTION_STRATEGY=atomic` usa `POST /swap/v1/swap-instructions` e monta uma unica `VersionedTransaction` com 2 pernas.
- A 2a perna usa `otherAmountThreshold` da 1a (conservador). Se a 1a perna retornar mais, sobra token intermediario na ATA.

## Jito (opcional, MODE=live)

Quando `JITO_ENABLED=true`, no modo `atomic` o bot:

- Inclui um tip (`SystemProgram.transfer`) para uma conta de tip do Jito **na mesma transacao** (evita pagar tip se a tx falhar).
- Envia a transacao via Block Engine usando `jito-ts` (bundle com 1 tx).

Variaveis relevantes:

- `JITO_BLOCK_ENGINE_URL` (ex: `https://amsterdam.mainnet.block-engine.jito.wtf`)
- `JITO_TIP_MODE=fixed|dynamic`
- `JITO_TIP_LAMPORTS` (modo fixed; minimo recomendado: 1000)
- `JITO_MIN_TIP_LAMPORTS`, `JITO_MAX_TIP_LAMPORTS`, `JITO_TIP_BPS` (modo dynamic; so faz sentido quando `aMint` eh SOL)
- `JITO_TIP_ACCOUNT` (opcional; se vazio, escolhe uma conta padrao aleatoria)
- `JITO_WAIT_MS` (aguarda resultado do bundle via stream; 0 = nao aguarda)
- `JITO_FALLBACK_RPC` (se true e o bundle for rejeitado/dropped, refaz a tx sem tip e envia via RPC)

## Dry-run

- `DRY_RUN_BUILD=true` gera a transacao mesmo quando nao esta lucrativo.
- `DRY_RUN_SIMULATE=true` simula a transacao e retorna logs/erros.

## Live preflight (opcional)

Quando `MODE=live`:

- `LIVE_PREFLIGHT_SIMULATE=true` faz `simulateTransaction` e **so envia** se `sim.err == null` (evita queimar fee em tx que ja vai falhar).

## Logging

- `LOG_PATH=./logs/events.jsonl` grava eventos em JSONL (startup, candidates, simulate, executed, etc).

## Config (por par)

Campos principais em `config.json`:

- `amountA` (obrigatorio) e `amountASteps` (opcional) para testar varios tamanhos.
- `slippageBps` (global), `slippageBpsLeg1` / `slippageBpsLeg2` / `slippageBpsLeg3` (opcional, por perna), `minProfitA`, `cooldownMs`.
- `includeDexes` / `excludeDexes` (opcional) para filtrar venues no quote da Jupiter.
- `computeUnitLimit`, `computeUnitPriceMicroLamports` (override por par).
- `baseFeeLamports`, `rentBufferLamports` (override por par para custo estimado).

### Triangular (A -> B -> C -> A)

Se o par tiver `cMint`, o scanner faz 3 pernas:

- `aMint -> bMint -> cMint -> aMint`

Exemplo: `config.triangular.example.json`

## Ultra Swap (avaliacao rapida)

- Ultra usa `GET https://api.jup.ag/ultra/v1/order` + `POST https://api.jup.ag/ultra/v1/execute` e exige `x-api-key` (portal `https://portal.jup.ag`).
- A API de Swap/Quote usada aqui eh `https://api.jup.ag/swap/v1/*` e tambem exige `x-api-key`.
- O projeto usa Ultra apenas se `JUP_USE_ULTRA=true` e `JUP_API_KEY` estiver definido.

## Seguranca

- Nunca commite sua private key.
- Use `MODE=dry-run` ate validar simulacao/execucao em valores baixos.

## Performance/operacao

- `PAIR_CONCURRENCY` paraleliza o scan entre pares.
- `QUOTE_CACHE_TTL_MS` cache curto de quotes (Swap v1).
- `LUT_CACHE_TTL_MS` cache de Address Lookup Tables para acelerar builds atomicos.
- `MIN_BALANCE_LAMPORTS` evita tentar execucao sem saldo suficiente.
- `MAX_ERRORS_BEFORE_EXIT` / `MAX_CONSECUTIVE_ERRORS_BEFORE_EXIT` mata o processo se ficar instavel (0 = desativado).
