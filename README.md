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
  - Use `docker-compose.prod.yml` via profiles (nao sobe nada sem `--profile`).
- Start (atomic/Jito): `docker compose -f docker-compose.prod.yml --profile atomic up --build -d`
- Ultra (opcional): `docker compose -f docker-compose.prod.yml --profile ultra up --build -d` (sobe `jupiter-ultra-sequential`)
- Dual (opcional): `docker compose -f docker-compose.prod.yml --profile dual up --build -d` (sobe `ultra-dual-sequential`)
- Titan/OpenOcean (opcional): `docker compose -f docker-compose.prod.yml --profile titan up --build -d` (sobe `openocean-sequential`)
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
  - `OPENOCEAN_JUPITER_NEAR_GATE_BPS` (mais agressivo: so consulta se `gate <= jupiterBps <= gate+near`; `0` desativa)
  - `OPENOCEAN_429_COOLDOWN_MS` (circuit breaker por par quando tomar `HTTP 429`/ban)
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
- `FEE_CONVERSION_CACHE_TTL_MS` cache de conversao `SOL -> aMint` usado para estimar fees em unidades de A (quando `aMint!=SOL`).
- `PAIR_SCHEDULER_SPREAD` distribui pares no tempo (evita bursts de HTTP quando voce tem muitos pares).
- `BALANCE_REFRESH_MS` controla com que frequencia o bot atualiza o saldo SOL via RPC (usado pelo modo de amount dinamico).
- `DYNAMIC_AMOUNT_A_MODE=sol_balance` calcula `amountA` dinamicamente como `% do saldo SOL disponivel` (saldo - `MIN_BALANCE_LAMPORTS`) e sobrescreve `amountASteps` (somente para pares com `aMint=SOL`).
- `DYNAMIC_AMOUNT_A_BPS` define o % (em bps) do saldo disponivel (ex: `2000` = 20%).
- `JUP_RPS` / `JUP_BURST` limitam RPS global da Jupiter (quote + exec) via token-bucket (ex: `JUP_RPS=1` para free tier).
- `JUP_MIN_INTERVAL_MS` / `JUP_BACKOFF_*` seguem valendo para backoff/cooldown entre tentativas.
- `JUP_ADAPTIVE_PENALTY_MS` reduz RPS temporariamente ao detectar `HTTP 429` (auto-tuning).
- `JUP_429_COOLDOWN_MS` ativa um circuit breaker **por par** quando ocorrer `HTTP 429` (reduz storm/retry).
- `OPENOCEAN_RPS` / `OPENOCEAN_BURST` limitam RPS global da OpenOcean (ex: `OPENOCEAN_RPS=2`).
- `OPENOCEAN_ADAPTIVE_PENALTY_MS` reduz RPS temporariamente ao detectar `HTTP 429`.
- `LUT_CACHE_TTL_MS` cache de Address Lookup Tables para acelerar builds atomicos.
- `MIN_BALANCE_LAMPORTS` evita tentar execucao sem saldo suficiente.
- `MAX_ERRORS_BEFORE_EXIT` / `MAX_CONSECUTIVE_ERRORS_BEFORE_EXIT` mata o processo se ficar instavel (0 = desativado).

## Healthcheck (opcional)

- `HEALTHCHECK_PORT` expõe:
  - `GET /healthz` => `200 ok`
  - `GET /metrics` => snapshot JSON (sem segredos) dos limiters.

## Referência de configuração

As referências abaixo refletem o schema real validado em runtime:

- `.env`: `src/lib/env.ts`
- `config.json`: `src/lib/config.ts`

### O que dá para obter dinamicamente da wallet/RPC

Hoje o bot já obtém/usa dinamicamente:

- `pubkey` do trader (derivado de `WALLET_SECRET_KEY`) e logado no startup.
- `saldo SOL` via RPC (usado para logs e para `DYNAMIC_AMOUNT_A_MODE=sol_balance`).
- Criação de ATAs para os mints do `config.json` (via `--setup-wallet` ou `AUTO_SETUP_WALLET=true`).

Também é possível (mas **não está implementado** como “auto-config” por padrão) derivar:

- Saldos de tokens SPL (por `aMint`/`bMint`/`cMint`) para:
  - Ajustar `amountA` quando `aMint != SOL` (modo `token_balance` futuro).
  - Definir `maxNotionalA` automaticamente para não tentar quote acima do saldo.
- Decimals/símbolo (metadata do mint) para mostrar `amountA` em unidades humanas (hoje tudo é “atomic” no config).
- Buffer de rent/ATA mais preciso por simulação ou leitura de contas (hoje é estimado por `RENT_BUFFER_LAMPORTS`).

### Referência: `.env`

**Obrigatórias**

- `SOLANA_RPC_URL` (obrigatória) - URL HTTP do RPC (Helius/QuickNode recomendado em `MODE=live`).
- `WALLET_SECRET_KEY` (obrigatória) - pode ser base58, JSON array (`[1,2,...]`) ou caminho para um arquivo JSON com a keypair.

**Solana / conexão**

- `SOLANA_WS_URL` (opcional) - URL WebSocket para reduzir latência.
- `SOLANA_COMMITMENT` (default `confirmed`) - `processed|confirmed|finalized`.

**Modo e execução**

- `MODE` (default `dry-run`) - `dry-run|live`.
- `BOT_PROFILE` (default `default`) - `default|hft` (reduz logs e torna OpenOcean mais conservador).
- `CONFIG_PATH` (default `./config.json`) - caminho do arquivo de configuração.
- `POLL_INTERVAL_MS` (default `500`) - intervalo base do loop (e do scheduler por par).
- `EXECUTION_STRATEGY` (default `atomic`) - `atomic|sequential`.

**Triggers**

- `TRIGGER_STRATEGY` (default `immediate`) - `immediate|avg-window|vwap|bollinger`.
- `TRIGGER_OBSERVE_MS` (default `30000`) - janela de observação do trigger.
- `TRIGGER_OBSERVE_INTERVAL_MS` (default `1000`) - intervalo entre ticks na fase observe.
- `TRIGGER_EXECUTE_MS` (default `10000`) - janela de execução do trigger.
- `TRIGGER_EXECUTE_INTERVAL_MS` (default `500`) - intervalo entre ticks na fase execute.
- `TRIGGER_BOLLINGER_K` (default `1.5`) - multiplicador do desvio padrão (bollinger).
- `TRIGGER_EMA_ALPHA` (default `0`) - `0` = auto; senão, alpha da EMA.
- `TRIGGER_BOLLINGER_MIN_SAMPLES` (default `10`) - mínimo de amostras; senão loga `insufficient-samples`.
- `TRIGGER_MOMENTUM_LOOKBACK` (default `2`) - ticks para confirmar reversão (vwap/bollinger).
- `TRIGGER_TRAIL_DROP_BPS` (default `1`) - trailing stop em bps (vwap/bollinger).
- `TRIGGER_EMERGENCY_SIGMA` (default `0`) - “disparo de emergência” (0 desativa).
- `TRIGGER_AMOUNT_MODE` (default `rotate`) - `all|rotate|fixed` (como usa `amountASteps`).
- `TRIGGER_MAX_AMOUNTS_PER_TICK` (default `1`) - limita quantos tamanhos são cotados por tick.

**Dry-run**

- `DRY_RUN_BUILD` (default `false`) - builda tx mesmo sem lucro (só em `MODE=dry-run`).
- `DRY_RUN_SIMULATE` (default `false`) - simula as transações em `MODE=dry-run`.
- `DRY_RUN_INCLUDE_JITO_TIP` (default `false`) - inclui tip/custos Jito no cálculo em `MODE=dry-run`.

**Safety**

- `LIVE_PREFLIGHT_SIMULATE` (default `true`) - em `MODE=live`, só envia se `simulateTransaction` não der erro.
- `MIN_BALANCE_LAMPORTS` (default `0`) - trava execuções se saldo SOL < esse valor.
- `MAX_ERRORS_BEFORE_EXIT` (default `0`) - encerra o processo após N erros (0 desativa).
- `MAX_CONSECUTIVE_ERRORS_BEFORE_EXIT` (default `0`) - encerra após N erros consecutivos (0 desativa).

**Logging**

- `LOG_PATH` (default `./logs/events.jsonl`) - JSONL de eventos.
- `LOG_VERBOSE` (default depende do `BOT_PROFILE`) - quando `false`, reduz I/O (pula `simulate` e candidates não lucrativos).
- `LOG_ROTATE_MAX_BYTES` (default `0`) - rotação por tamanho (0 desativa).
- `LOG_ROTATE_MAX_FILES` (default `0`) - quantos arquivos manter.

**Caches**

- `QUOTE_CACHE_TTL_MS` (default `250`) - cache curto de quotes.
- `FEE_CONVERSION_CACHE_TTL_MS` (default `60000`) - cache de conversão `SOL -> aMint` (para estimar fee em unidades de A).
- `LUT_CACHE_TTL_MS` (default `60000`) - cache de LUTs (atomic).

**Concorrência / scheduler**

- `PAIR_CONCURRENCY` (default `2`) - número de pares em paralelo.
- `PAIR_SCHEDULER_SPREAD` (default `true`) - distribui pares dentro de `POLL_INTERVAL_MS` para evitar burst.

**Amount dinâmico (opcional; somente `aMint=SOL`)**

- `BALANCE_REFRESH_MS` (default `2000`) - TTL do cache de saldo SOL.
- `DYNAMIC_AMOUNT_A_MODE` (default `off`) - `off|sol_balance`.
- `DYNAMIC_AMOUNT_A_BPS` (default `0`) - % do saldo disponível (bps) a usar como `amountA` (ex: `2000` = 20%).
- `DYNAMIC_AMOUNT_A_MIN_ATOMIC` (default `0`) - piso para o `amountA` calculado.
- `DYNAMIC_AMOUNT_A_MAX_ATOMIC` (default `0`) - teto para o `amountA` calculado.

**Estimativas de fee (custo)**

- `BASE_FEE_LAMPORTS` (default `5000`) - fee base por assinatura/tx (aprox).
- `RENT_BUFFER_LAMPORTS` (default `0`) - buffer para rent (ATAs) quando aplicável.
- `COMPUTE_UNIT_LIMIT` (default `1400000`) - limite de compute.
- `COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` (default `0`) - priority fee fixa; `0` permite estratégia dinâmica.

**Priority fee dinâmica**

- `PRIORITY_FEE_STRATEGY` (default `off`) - `off|rpc-recent|helius`.
- `PRIORITY_FEE_LEVEL` (default `recommended`) - `min|low|medium|high|veryHigh|unsafeMax|recommended`.
- `PRIORITY_FEE_REFRESH_MS` (default `1000`) - refresh do estimate.
- `PRIORITY_FEE_MAX_MICRO_LAMPORTS` (default `50000000`) - teto.
- `PRIORITY_FEE_TARGET_ACCOUNT_LIMIT` (default `16`) - limita contas alvo no estimate (Helius).
- `PRIORITY_FEE_WITH_JITO` (default `false`) - permitir priority fee mesmo com Jito tip.
- `HELIUS_API_KEY` / `HELIUS_RPC_URL` (opcionais) - usados quando `PRIORITY_FEE_STRATEGY=helius`.

**Setup wallet**

- `AUTO_SETUP_WALLET` (default `false`) - cria ATAs automaticamente no startup (apenas `MODE=live`).

**Jito (opcional; `MODE=live`)**

- `JITO_ENABLED` (default `false`) - envia bundle via Jito no modo atomic.
- `JITO_BLOCK_ENGINE_URL` (default `https://amsterdam.mainnet.block-engine.jito.wtf`)
- `JITO_TIP_LAMPORTS` (default `10000`) - tip fixo.
- `JITO_TIP_MODE` (default `fixed`) - `fixed|dynamic` (dinâmico só é seguro para loops com `aMint=SOL`).
- `JITO_MIN_TIP_LAMPORTS` (default `5000`)
- `JITO_MAX_TIP_LAMPORTS` (default `50000`)
- `JITO_TIP_BPS` (default `2000`) - usado no modo tip dinâmico.
- `JITO_WAIT_MS` (default `0`) - espera antes de fallback.
- `JITO_FALLBACK_RPC` (default `false`) - fallback para envio via RPC se bundle falhar.
- `JITO_TIP_ACCOUNT` (opcional) - override do tip account.

**Jupiter (swap/quote + Ultra)**

- `JUP_SWAP_BASE_URL` (default `https://api.jup.ag`) - base do swap-v1.
- `JUP_QUOTE_BASE_URL` (default = `JUP_SWAP_BASE_URL`) - base usada para scan e conversão de fee.
- `JUP_ULTRA_BASE_URL` (default `https://api.jup.ag`) - aceita `https://api.jup.ag` ou `https://api.jup.ag/ultra`.
- `JUP_API_KEY` (opcional/required dependendo do endpoint) - enviado como `x-api-key`.
- `JUP_EXECUTION_PROVIDER` (default `swap`) - `swap|ultra`.
- `JUP_USE_ULTRA` (default `false`) - compatibilidade; se `true` implica `JUP_EXECUTION_PROVIDER=ultra`.

**Rate limit Jupiter (global)**

- `JUP_RPS` (default `0`) - se `>0`, força RPS global via token-bucket (ex: `1`).
- `JUP_BURST` (default `1`) - burst do token-bucket.
- `JUP_ADAPTIVE_PENALTY_MS` (default `120000`) - janela de penalidade após 429 (reduz RPS e recupera lentamente).
- `JUP_MIN_INTERVAL_MS` (default `150`) - intervalo mínimo (usado como fallback quando `JUP_RPS=0` e no backoff).
- `JUP_429_COOLDOWN_MS` (default `30000`) - circuit breaker por par ao detectar 429.
- `JUP_BACKOFF_MAX_ATTEMPTS` (default `4`) - tentativas totais por request (inclui a primeira).
- `JUP_BACKOFF_BASE_MS` (default `250`) - base do backoff exponencial.
- `JUP_BACKOFF_MAX_MS` (default `5000`) - teto do backoff.

**Rate limit Ultra (overrides opcionais)**

- `JUP_ULTRA_MIN_INTERVAL_MS` (default = `JUP_MIN_INTERVAL_MS`)
- `JUP_ULTRA_BACKOFF_MAX_ATTEMPTS` (default = `JUP_BACKOFF_MAX_ATTEMPTS`)
- `JUP_ULTRA_BACKOFF_BASE_MS` (default = `JUP_BACKOFF_BASE_MS`)
- `JUP_ULTRA_BACKOFF_MAX_MS` (default = `JUP_BACKOFF_MAX_MS`)

**OpenOcean (opcional)**

- `OPENOCEAN_ENABLED` (default `false`)
- `OPENOCEAN_BASE_URL` (default `https://open-api.openocean.finance/v4/solana`) - aceita sem `https://`.
- `OPENOCEAN_API_KEY` (opcional)
- `OPENOCEAN_GAS_PRICE` (default `5`) - parâmetro da API.
- `OPENOCEAN_SIGNATURES_ESTIMATE` (default `3`) - usado na estimativa de fee.

**Rate limit OpenOcean (global)**

- `OPENOCEAN_RPS` (default `0`) - se `>0`, força RPS via token-bucket (ex: `2`).
- `OPENOCEAN_BURST` (default `2`) - burst.
- `OPENOCEAN_ADAPTIVE_PENALTY_MS` (default `180000`) - penalidade após 429.
- `OPENOCEAN_MIN_INTERVAL_MS` (default `1200`) - fallback quando `OPENOCEAN_RPS=0`.
- `OPENOCEAN_429_COOLDOWN_MS` (default `60000`) - circuit breaker por par.

**OpenOcean “second opinion”**

- `OPENOCEAN_OBSERVE_ENABLED` (default depende do `BOT_PROFILE`) - habilita chamadas na fase observe.
- `OPENOCEAN_EXECUTE_ENABLED` (default `true`) - habilita chamadas na fase execute.
- `OPENOCEAN_EVERY_N_TICKS` (default `2`) - amostragem (maior = menos chamadas).
- `OPENOCEAN_JUPITER_GATE_BPS` (default depende do `BOT_PROFILE`) - só chama OpenOcean se o Jupiter estiver “perto do breakeven”.
- `OPENOCEAN_JUPITER_NEAR_GATE_BPS` (default depende do `BOT_PROFILE`) - faixa adicional; `0` desativa.
- `OPENOCEAN_ENABLED_DEX_IDS` / `OPENOCEAN_DISABLED_DEX_IDS` (opcionais) - filtra venues na OpenOcean.
- `OPENOCEAN_REFERRER` / `OPENOCEAN_REFERRER_FEE` (opcionais).

**Rust calc (opcional)**

- `USE_RUST_CALC` (default `false`)
- `RUST_CALC_PATH` (default `./target/release/arb_calc`)

**Health server**

- `HEALTHCHECK_PORT` (default `0`) - quando `>0`, expõe `GET /healthz` e `GET /metrics`.

**Advanced (sequential confirmation)**

- `SEQUENTIAL_CONFIRM_MAX_ATTEMPTS` (default `4`) - tentativas para confirmar leg (sequential/Ultra).
- `SEQUENTIAL_CONFIRM_BASE_DELAY_MS` (default `200`) - base do backoff exponencial na confirmação.

### Referência: `config.json`

Estrutura:

- `pairs` (array, mínimo 1) - lista de pares/triângulos a escanear.

Campos de cada `pair`:

- `name` (string, obrigatório) - identificador do par (usado em logs/cooldowns).
- `aMint` (string, obrigatório) - mint de entrada (A). Para Ultra, deve ser SOL (`So111...`).
- `bMint` (string, obrigatório) - mint intermediário (B).
- `cMint` (string, opcional) - se presente, ativa modo triangular `A->B->C->A`.
- `amountA` (string numérica, obrigatório) - tamanho padrão em unidades atômicas (SOL = lamports).
- `amountASteps` (array de strings numéricas, opcional) - tamanhos alternativos para scan.
  - Observação: se `DYNAMIC_AMOUNT_A_MODE=sol_balance`, esse campo é ignorado (override).
- `slippageBps` (int 1..5000, default `50`) - slippage global em bps.
- `slippageBpsLeg1|2|3` (int 1..5000, opcional) - slippage específico por perna (triangular usa `Leg3`).
- `includeDexes` (array de strings, opcional) - filtro de venues para quote da Jupiter.
- `excludeDexes` (array de strings, opcional) - exclui venues na quote da Jupiter e também no Ultra (via `excludeDexes` CSV).
- `minProfitA` (string numérica, default `0`) - lucro mínimo absoluto (em unidades atômicas de A), já considerando fees estimados.
- `minProfitBps` (int 0..10000, opcional) - lucro mínimo relativo em bps do notional; o bot usa `max(minProfitA, amountA*bps/10000)`.
- `cooldownMs` (int >=0, default `0`) - cooldown do par após um scan/exec (ajuda a respeitar rate limit).
- `maxNotionalA` (string numérica, opcional) - limita o `amountA` máximo aceito para aquele par.
- `computeUnitLimit` (int >=1, opcional) - override por par.
- `computeUnitPriceMicroLamports` (int >=0, opcional) - override por par.
- `baseFeeLamports` (int >=0, opcional) - override por par.
- `rentBufferLamports` (int >=0, opcional) - override por par.
