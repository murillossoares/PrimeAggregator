# PrimeAggregator (Jupiter + OpenOcean/Titan)

Bot de arbitragem (MVP) com Jupiter como base e integracao opcional com OpenOcean (meta-agregador que inclui Titan). Faz loop `A -> B -> A`, com execucao atomica opcional (uma unica transacao) e modo dry-run com simulacao.

## Requisitos

- Node.js >= 20
- (Opcional) Rust toolchain para `rust/arb_calc`

## Setup

1) Instale dependencias:

- PowerShell com policy restrita: `npm.cmd install`
- Outros shells: `npm install`

2) Crie `.env` usando `.env.example`.

3) Copie `config.example.json` para `config.json` e ajuste `pairs`.

Opcional: perfil "HFT" (mais conservador com I/O e OpenOcean):

- `BOT_PROFILE=hft`
- Se `LOG_VERBOSE` nao estiver definido, o default vira `false` (menos I/O).
- Forca `OPENOCEAN_OBSERVE_ENABLED=false` e `OPENOCEAN_EVERY_N_TICKS>=2` para reduzir risco de rate-limit/ban.

Quando `.env.example` mudar, mantenha seu `.env` atualizado (sem sobrescrever valores existentes):

- `npm.cmd run sync-env`

## Helius / QuickNode (alto impacto)

### RPC privado + WebSocket

- Troque `SOLANA_RPC_URL` para seu endpoint (Helius/QuickNode).
- (Recomendado) Defina `SOLANA_WS_URL` para reduzir latencia em confirmacoes/subscriptions.
- `SOLANA_COMMITMENT=processed|confirmed|finalized` (em arbitragem, `processed` costuma ser o mais rapido).

### QuickNode Metis (Jupiter privado)

Se voce usa o add-on Metis da QuickNode (router privado da Jupiter), a integracao aqui eh so trocar o endpoint:

- Para quotes/scan: `JUP_QUOTE_BASE_URL=<METIS_URL>` (recomendado quando `JUP_EXECUTION_PROVIDER=ultra`).
- Para execucao via swap (nao Ultra): `JUP_SWAP_BASE_URL=<METIS_URL>`

Se seu endpoint nao exigir `x-api-key`, `JUP_API_KEY` pode ficar vazio. O `https://api.jup.ag` exige.

### Priority fee dinamica (opcional)

Para usar fee dinamica (compute unit price):

- Mantenha `COMPUTE_UNIT_PRICE_MICRO_LAMPORTS=0` (para permitir override dinamico).
- Escolha um provider:
  - `PRIORITY_FEE_STRATEGY=rpc-recent` (padrao Solana; funciona em qualquer RPC)
  - `PRIORITY_FEE_STRATEGY=helius` + `HELIUS_API_KEY` (usa `getPriorityFeeEstimate`, com fallback para `rpc-recent`)
- Ajuste `PRIORITY_FEE_LEVEL`, `PRIORITY_FEE_REFRESH_MS` e `PRIORITY_FEE_MAX_MICRO_LAMPORTS` se necessario.

Se `JITO_ENABLED=true`, por padrao o bot nao paga priority fee (usa tip). Para habilitar junto com Jito: `PRIORITY_FEE_WITH_JITO=true`.

## Rodar

- Dev: `npm.cmd run dev`
- Dev (uma iteracao): `npm.cmd run dev -- --once`
- Build: `npm.cmd run build`
- Start: `npm.cmd run start`
- Start (uma iteracao): `npm.cmd run start -- --once`

## Docker / Docker Compose

- Build: `docker build -t prime-aggregator .`
- Compose: `docker compose up --build`
- Compose (uma iteracao e sai): `docker compose run --rm prime-aggregator --once`

Por padrao, o bot roda em loop infinito (ate voce parar o processo). Para encerrar apos 1 ciclo, use `--once`.

O `docker-compose.yml` usa `env_file: .env`, monta `./config.json` como read-only e persiste logs em `./logs/`.

## Producao (checklist)

- Arquivos:
  - Copie `.env.production.example` -> `.env.production` e preencha os campos obrigatorios (sem commitar).
  - Use `docker-compose.prod.yml` para rodar 2 servicos em paralelo: `jupiter-atomic` e `openocean-sequential` (ou use os profiles `ultra`/`dual`).
- Start: `docker compose -f docker-compose.prod.yml up --build -d`
- Ultra (opcional): `docker compose -f docker-compose.prod.yml --profile ultra up --build -d` (sobe `jupiter-ultra-sequential`)
- Dual (opcional): `docker compose -f docker-compose.prod.yml --profile dual up --build -d` (sobe `ultra-dual-sequential`)
- Logs: `docker compose -f docker-compose.prod.yml logs -f --tail=200`

- RPC/WS: use `SOLANA_RPC_URL` privado + `SOLANA_WS_URL` (evite `api.mainnet-beta.solana.com` em `MODE=live`).
- Modo: `MODE=live`, `BOT_PROFILE=hft`, `LOG_VERBOSE=false` e rotacao (`LOG_ROTATE_MAX_BYTES/FILES`).
- Execucao: para usar Titan via OpenOcean, use `EXECUTION_STRATEGY=sequential` (OpenOcean nao executa no modo `atomic`).
- Paralelo: rodar os 2 servicos com o mesmo `config.json`/wallet pode duplicar execucoes; em producao, prefira separar pares (configs diferentes) e/ou wallets.
- Protecoes: `LIVE_PREFLIGHT_SIMULATE=true`, `MIN_BALANCE_LAMPORTS` > 0 e `MAX_CONSECUTIVE_ERRORS_BEFORE_EXIT` (deixa o Docker reiniciar se ficar instavel).
- OpenOcean/Titan: `OPENOCEAN_ENABLED=true`, `OPENOCEAN_ENABLED_DEX_IDS=10`, `OPENOCEAN_MIN_INTERVAL_MS>=1200` (API publica ~2 RPS), `OPENOCEAN_EVERY_N_TICKS>=2` e `OPENOCEAN_JUPITER_GATE_BPS=-50`.
- Operacao: rode `--setup-wallet` (ATAs) e monitore `./logs/events.jupiter.jsonl` e `./logs/events.openocean.jsonl` (ex: `type=executed`, `provider=openocean`, `dexId1=10`/`dexId2=10`).

## Setup wallet (ATAs)

Cria ATAs idempotentes para os mints em `config.json`:

- `npm.cmd run dev -- --setup-wallet`
- Docker: `docker compose run --rm prime-aggregator --setup-wallet`

Opcional (apenas `MODE=live`): rodar automaticamente no startup:

- `AUTO_SETUP_WALLET=true`

## Execucao atomica

- `EXECUTION_STRATEGY=atomic` usa `POST /swap/v1/swap-instructions` e monta uma unica `VersionedTransaction` com 2 pernas.
- A 2a perna usa `otherAmountThreshold` da 1a (conservador). Se a 1a perna retornar mais, sobra token intermediario na ATA.

## Custos/fees e unidades (importante)

- O bot estima custo em **lamports (SOL)** (`feeEstimateLamports`) mesmo quando o par nao eh em SOL.
- Para decidir lucro quando `aMint != SOL`, o bot converte esse custo para **unidades de A** usando uma quote `SOL -> aMint` e usa esse valor na decisao (`feeEstimateInA` nos logs).
- Isso exige que o provider Jupiter tenha endpoint de quote (`swap-v1` ou `v6/Metis`). **Ultra nao oferece quote**, entao Ultra so eh suportado quando `aMint=SOL`.

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
- `DRY_RUN_INCLUDE_JITO_TIP=true` inclui tip/custos do Jito no calculo de lucro mesmo em `MODE=dry-run` (default `false`).

## Live preflight (opcional)

Quando `MODE=live`:

- `LIVE_PREFLIGHT_SIMULATE=true` faz `simulateTransaction` e **so envia** se `sim.err == null` (evita queimar fee em tx que ja vai falhar).

## Logging

- `LOG_PATH=./logs/events.jsonl` grava eventos em JSONL (startup, candidates, simulate, executed, etc).
- `LOG_VERBOSE=true|false`: quando `false`, reduz I/O (loga apenas candidates lucrativos e pula eventos grandes como `simulate`).
- Rotacao (opcional): `LOG_ROTATE_MAX_BYTES` / `LOG_ROTATE_MAX_FILES` (ex: `10485760` + `5` para ~10MB e 5 arquivos).

No Docker Compose, stdout/stderr do container usa rotacao do driver `json-file` (veja `docker-compose.yml`).

## Config (por par)

Campos principais em `config.json`:

- `amountA` (obrigatorio) e `amountASteps` (opcional) para testar varios tamanhos.
- `slippageBps` (global), `slippageBpsLeg1` / `slippageBpsLeg2` / `slippageBpsLeg3` (opcional, por perna), `cooldownMs`.
- `minProfitA` (absoluto, em unidades de A) e `minProfitBps` (opcional, % do notional em bps). O bot usa `max(minProfitA, amountA * minProfitBps / 10_000)` como lucro liquido minimo (ja descontando fee/tip estimados).
- `includeDexes` / `excludeDexes` (opcional) para filtrar venues no quote da Jupiter (e `excludeDexes` tambem eh aplicado no Ultra via `excludeDexes` da API).
- `computeUnitLimit`, `computeUnitPriceMicroLamports` (override por par).
- `baseFeeLamports`, `rentBufferLamports` (override por par para custo estimado).

### Triangular (A -> B -> C -> A)

Se o par tiver `cMint`, o scanner faz 3 pernas:

- `aMint -> bMint -> cMint -> aMint`

Exemplo: `config.triangular.example.json`

## Ultra Swap (avaliacao rapida)

- Ultra usa `GET https://api.jup.ag/ultra/v1/order` + `POST https://api.jup.ag/ultra/v1/execute` e exige `x-api-key` (portal `https://portal.jup.ag`).
- `JUP_ULTRA_BASE_URL` pode ser `https://api.jup.ag` **ou** `https://api.jup.ag/ultra` (o bot normaliza).
- A API de Swap/Quote usada aqui eh `https://api.jup.ag/swap/v1/*` e tambem exige `x-api-key`.
- Dual mode: o bot pode **scannear** usando a Quote API (`JUP_QUOTE_BASE_URL`) e **executar** via Ultra (`JUP_EXECUTION_PROVIDER=ultra`) no mesmo processo.
  - Isso reduz muito `HTTP 429`, porque o Ultra so eh chamado na hora de executar (order/execute), nao a cada tick.
  - `JUP_USE_ULTRA=true` ainda funciona por compatibilidade, mas prefira `JUP_EXECUTION_PROVIDER=ultra`.
- Ultra executa em **2 transacoes** (sequential) para loops `A->B->A`. Recomendado usar `EXECUTION_STRATEGY=sequential` quando `JUP_EXECUTION_PROVIDER=ultra`.
- Ultra **nao suporta triangular** e exige `aMint=SOL` (por causa do custo em lamports).

## OpenOcean (meta-agregador; opcional)

A OpenOcean agrega Jupiter, Titan e outros venues. Integracao opcional:

- Habilite: `OPENOCEAN_ENABLED=true`
- Base URL (Solana v4): `OPENOCEAN_BASE_URL=https://open-api.openocean.finance/v4/solana` (o bot normaliza strings sem `https://`).
- Rate limit: o bot aplica um intervalo minimo global via `OPENOCEAN_MIN_INTERVAL_MS` (default `1200ms`). A API publica pode responder `HTTP 429` e ate ban temporario (mensagem "banned for one hour"), entao ajuste conforme seu tier.
- Fee: a OpenOcean costuma retornar swaps com multiplas assinaturas (ex: 3 => `fee ~ 15000` por TX). Ajuste `OPENOCEAN_SIGNATURES_ESTIMATE` (default `3`) para deixar o `feeEstimateLamports` mais realista.
- Observacao: a OpenOcean entra como **second opinion** e (por padrao) so eh consultada na janela de execucao do trigger. Controles:
  - `OPENOCEAN_OBSERVE_ENABLED` / `OPENOCEAN_EXECUTE_ENABLED`
  - `OPENOCEAN_EVERY_N_TICKS` (ex: `2` = consulta a cada 2 ticks)
  - `OPENOCEAN_JUPITER_GATE_BPS` (so consulta se o melhor Jupiter estiver "perto do breakeven", ex `-250` bps = -2.5%)
- Dex filters (opcional): `OPENOCEAN_ENABLED_DEX_IDS` / `OPENOCEAN_DISABLED_DEX_IDS` (veja `https://open-api.openocean.finance/v4/solana/dexList`; no momento `Jupiter=6`, `Titan=10`).
  - Para forcar Titan: `OPENOCEAN_ENABLED_DEX_IDS=10`
  - Como validar que Titan foi usado: procure `dexId1=10`/`dexId2=10` nos eventos `type=candidate provider=openocean` (e, em `DRY_RUN_SIMULATE=true`, o log de simulacao costuma mostrar o programa Titan `T1TANpTe...`).
- Referrer (opcional): `OPENOCEAN_REFERRER` / `OPENOCEAN_REFERRER_FEE` (cuidado: fee reduz sua margem; em arbitragem normalmente deixe vazio).
- Execucao: atualmente o provider OpenOcean so roda em `EXECUTION_STRATEGY=sequential` (a execucao atomica usa swap-instructions da Jupiter).
- Dual mode: pode manter `OPENOCEAN_ENABLED=true` junto com `JUP_EXECUTION_PROVIDER=ultra`; nesse caso o bot scanneia via Quote API e, na hora de executar, escolhe o melhor entre OpenOcean e Ultra.

## Trigger strategy

Opcoes de gatilho para reduzir execucao em ruido:

- `TRIGGER_STRATEGY=immediate` (padrao): executa assim que achar candidato lucrativo.
- `TRIGGER_STRATEGY=avg-window`: observa o lucro liquido (conservador) por 30s, calcula a media e na janela seguinte (10s) so executa se `profit >= media`.
- `TRIGGER_STRATEGY=vwap`: observa por 30s e calcula uma EMA do **lucro em bps** (VWAP por tick); na janela seguinte arma quando `profitBps >= EMA` e executa na reversao (trailing stop).
- `TRIGGER_STRATEGY=bollinger`: calcula EMA + desvio padrao do **lucro em bps** e arma execucao quando rompe `EMA + K*StdDev`, executando na reversao (trailing stop).

Ajustes de janela:

- `TRIGGER_OBSERVE_MS`, `TRIGGER_OBSERVE_INTERVAL_MS`, `TRIGGER_EXECUTE_MS`, `TRIGGER_EXECUTE_INTERVAL_MS`

Ajustes do modo `bollinger`:

- `TRIGGER_BOLLINGER_K` (default `1.5`), `TRIGGER_EMA_ALPHA` (`0` = auto), `TRIGGER_BOLLINGER_MIN_SAMPLES`
- `TRIGGER_MOMENTUM_LOOKBACK`, `TRIGGER_TRAIL_DROP_BPS`
- `TRIGGER_EMERGENCY_SIGMA` (`0` desativa; ex `4` para "4-sigma")
- `TRIGGER_AMOUNT_MODE=all|rotate|fixed` controla como usar `amountASteps` no trigger (`fixed` = tamanho fixo por ciclo; `rotate` = round-robin por tick).
- `TRIGGER_MAX_AMOUNTS_PER_TICK` limita quantos tamanhos sao cotados por tick.

## Seguranca

- Nunca commite sua private key.
- Use `MODE=dry-run` ate validar simulacao/execucao em valores baixos.

## Performance/operacao

- `PAIR_CONCURRENCY` paraleliza o scan entre pares.
- `QUOTE_CACHE_TTL_MS` cache curto de quotes (Swap v1).
- `JUP_MIN_INTERVAL_MS` / `JUP_BACKOFF_*` aplicam rate limit + backoff global para as chamadas Jupiter (reduz `HTTP 429`).
- `LUT_CACHE_TTL_MS` cache de Address Lookup Tables para acelerar builds atomicos.
- `MIN_BALANCE_LAMPORTS` evita tentar execucao sem saldo suficiente.
- `MAX_ERRORS_BEFORE_EXIT` / `MAX_CONSECUTIVE_ERRORS_BEFORE_EXIT` mata o processo se ficar instavel (0 = desativado).
