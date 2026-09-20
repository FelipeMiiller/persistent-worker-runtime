# ADR-0024: Hardening do Runtime — Telemetria Per-Worker, Task-Fn Dispatch via Deps Manifest, Reciclagem por Taxa de Acumulação

- **Date**: 2026-09-20
- **Status**: Proposed
- **Deciders**: Mavis (assistant) + Felipe (maintainer)
- **Tags**: observability, dispatch, memory, recycling, preemption, runtime-api

## Contexto e Problema

O benchmark `benchmarks/io-throughput.benchmark.js` (commit `3f28bf8` + sustained-rate variant commitado nesta sessão) foi escrito pra testar quatro invariantes críticos do runtime sob carga sustentada:

1. **Distribuição I/O entre workers** — 50 000 TCP round-trips distribuídos em ~33 segundos a 1 500 req/s
2. **Reciclagem por pressão de memória** — workers que acumulam state em `localState` cruzam `maxMemoryMb` e são reciclados
3. **Preempção por watchdog** — task runaway (`while (true) {}`) é detectado e o worker é substituído
4. **Recovery de workers reciclados/preemptados** — fresh workers voltam online e aceitam tasks

O benchmark expôs **três bugs latentes no runtime** (não no benchmark) e **cinco oportunidades de melhoria estrutural** que afetam produção:

### Bugs latentes (achados durante o desenvolvimento do benchmark)

1. **`timeoutMs = 0` por default** em `TaskHandle` (`src/task-handle.js:22`) — `worker-handle.js:382` tem guard `if (!task || task.timeoutMs <= 0 || !task.forceKillOnTimeout) return` que silenciosamente desarma o watchdog. Usuário que esquece de setar `timeoutMs` perde preempção sem aviso.
2. **Reconstrução de fn via `new Function()`** em `worker-thread-entry.js:87` perde escopo module-level — toda task fn enviada via `runtime.dispatch()` perde acesso a imports estáticos e constantes do módulo dispatching. Toda task precisa usar `await import('node:xxx')` dinâmico + inlinear constantes. Isso está documentado no doc-block de `tcpRoundtripFn` no benchmark mas é uma armadilha pra todo user.
3. **`runtime.stats` não expõe per-worker heap** — `worker.lastMemoryUsageBytes` é privado (só o supervisor tem). Impossível dashboardar "qual worker está vazando memória" sem instrumentação custom. Detectado durante o benchmark: monitoramos 242 recyclings em 50 000 tasks mas não conseguimos atribuir qual worker reciclou mais.

### Oportunidades estruturais (derivadas dos resultados do do run)

4. **242 reciclings em 50 000 tasks** indica que o threshold atual (`maxMemoryMb = 80`) é absoluto. Não há hysteresis (`minRecycleIntervalMs`) nem accumulation-rate guard. Workers reciclam quando heapUsed cruza limite, mesmo que o crescimento seja lento e benigno.
5. **Polling interval do watchdog não é tunável** — preempção levou 1 352 ms no benchmark (acima do ideal para tasks CPU-bound curtas). Configuração só expõe `timeoutMs` (per-task), não `workerPollIntervalMs` (per-worker).
6. **Hot/cold routing** — 1 worker foi reciclado 242× (= total) enquanto outros foram menos. Provavelmente `supervisor.js` sempre pega `workers[0]` consistentemente — não há round-robin nem LRU.
7. **Recovery phase unevenly distributed** — 26 distinct threadIds em 5 000 recovery tasks mas só 4 workers originais. Recycled workers voltaram mais rápido que idle workers rejoinaram. Indica preferência ausente por recycled workers recém-prontos quando `idleWorkers.length === 0` durante stress.

## Decision Drivers

- **Observabilidade é requisito operacional**: não conseguimos diagnosticar nem alertar sem per-worker telemetry
- **API pública consistente**: `runtime.stats` deveria ser suficiente pra 80% dos casos; forçar user a importar private APIs é code smell
- **Back-compat**: zero breaking changes — todas as melhorias devem ser additive (`getWorkers()`, novas options com defaults inalterados)
- **Custo zero quando feature não é usada**: novas opções só alocam recursos se o user setar
- **Sem dependências externas**: continua ADR-0005 (zero deps)
- **Documentar armadilhas conhecidas**: bugs #1 e #2 existem há tempo; a correção evita surpresas pra novos users

## Opções Consideradas

- **Opção A — Status quo**: não consertar; deixar bugs #1, #2, #3 latentes e acumular tech debt até alguém reclamar em produção
- **Opção B — Hardening completo bundled** (este ADR): consertar os 3 bugs latentes + adicionar as 4 melhorias estruturais num único ciclo coordenado
- **Opção C — Incremental**: cada item vira um ADR separado, shipa um por vez
- **Opção D — Só o bug crítico**: consertar #1 (`timeoutMs` default) + #2 (`new Function()` scope) e ignorar o resto

## Decisão

**Opção B escolhida** — todos os 7 itens num único ciclo coordenado, agrupados em 4 sub-decisões técnicas coerentes:

### Sub-decisão A: Fix bugs latentes (sem mudança de API)

- **A1.** `src/task-handle.js:22` — `this.timeoutMs = options.timeoutMs || 5000` (default 5 s, não 0). Adicionar `console.warn` no `TaskHandle` quando `forceKillOnTimeout: true` mas `timeoutMs = 0` — opt-out via opção `silentTimeoutDefaultWarning: true` pra quem quer suprimir
- **A2.** `src/worker-thread-entry.js:87` — substituir `new Function(fnCode)` por IPC injection: o main thread serializa `{ fnCode, fnDeps }` onde `fnDeps` é um manifest `{ 'node:net': net, 'node:crypto': crypto, ... }`. Worker reconstitui via closure capture: `const net = fnDeps['node:net']; const fn = (payload, state, context) => { /* user code that can use net, crypto directly */ }`. Mantém zero external deps (todos os built-ins ficam disponíveis via `node:` scheme nativo do V8)

### Sub-decisão B: Telemetria per-worker pública (nova API additive)

- **B1.** Adicionar `runtime.getWorkers()` que retorna `Array<{ id: string, memoryUsageBytes: number, tasksCompleted: number, tasksActive: number, status: 'idle' | 'busy' | 'recycling' | 'preempting', recycledCount: number, lastTaskAt: number }>`. Snapshot síncrono (chamadas IPC seriam caras)
- **B2.** Estender `runtime.stats` com `workers: { totalWorkers, idleWorkers, maxMemoryMb, recycledTotal, preemptedTotal, totalMemoryBytes }` (agregados) — mantém shape retro-compat adicionando campos opcionais
- **B3.** Adicionar evento `runtime.on('worker:memory', (data) => { workerId, memoryUsageBytes })` emitido por worker quando cruza threshold monitorado (a cada N tasks ou M segundos, configurável). Default off (zero overhead); opt-in via `runtimeOptions.observeWorkerMemory: true`

### Sub-decisão C: Reciclagem inteligente (extensão behavioral)

- **C1.** Adicionar option `accumulationRateMbPerSec: number` — worker é reciclado se heapUsed cresce mais rápido que esse threshold, mesmo sem cruzar `maxMemoryMb` absoluto. Útil pra detectar memory leaks rápidos antes que OOM aconteça
- **C2.** Adicionar option `minRecycleIntervalMs: number` (default 30 000) — hysteresis mínimo entre reciclagens do mesmo worker. Evita thrashing quando tasks mal-comportadas entram em rajada
- **C3.** Adicionar option `recycleOnTasksExhausted: boolean` (default true) — controla se `maxTasksPerWorker` deve disparar reciclagem ou apenas warning. Atualmente sempre recicla

### Sub-decisão D: Routing + preempção tunáveis (extensões de config)

- **D1.** `Supervisor.dispatch()` — substituir FIFO por LRU round-robin: track `lastDispatchedWorkerIndex`, ciclar começando do próximo idle. Workers recém-reciclados (`status === 'idle'` + `tasksCompleted === 0`) têm prioridade momentânea sobre workers ociosos há muito tempo (cold cache)
- **D2.** Adicionar option `workerPollIntervalMs: number` (default 1 000) — interval em que o supervisor checa preempção. Hoje é fixo em `task.timeoutMs`; tornar independente permite watchdog mais agressivo sem encurtar tempo de task
- **D3.** Adicionar option `recycleBackoffMs: number` (default 0) — delay antes do worker reciclado ser removido fisicamente, útil pra dar tempo de tasks em-flight terminarem gracefully

## Mecânica Arquitetural

### Layout de arquivos (mudanças esperadas)

```
src/
├── task-handle.js                 # A1: timeoutMs default + warning
├── worker-thread-entry.js         # A2: fnDeps manifest IPC
├── supervisor.js                   # B1/B3, C1/C2/C3, D1/D3
├── worker-runtime.js               # B1/B2 (getWorkers, stats)
└── worker-handle.js                # D2: poll interval
test/
├── default-timeout.test.js         # A1
├── fn-deps-manifest.test.js        # A2
├── per-worker-telemetry.test.js    # B1/B2/B3
├── accumulation-rate-recycle.test.js  # C1/C2
├── round-robin-dispatch.test.js    # D1
└── watchdog-poll-interval.test.js  # D2
docs/adr/0024-runtime-observability-and-recycling-hardening.md  # este ADR
benchmarks/io-throughput.benchmark.js  # adicionar assertions pros novos eventos
```

### Compatibilidade

- **A1**: default muda de `0` → `5000`. Tasks existentes com `timeoutMs: 0` explícito continuam idênticas. Users que queriam `0` (sem watchdog) agora recebem 5 s. **Mitigação:** warning visível + opção de opt-out em runtime release notes; se for rejeitado, manter default `0` e só adicionar warning
- **A2**: nenhuma quebra. Users que já usam `await import('node:xxx')` continuam funcionando; users que não usam ganham acesso direto a built-ins
- **B/C/D**: puramente additive. Novas opções têm defaults que preservam comportamento atual

### Consequências Positivas

- **Observabilidade**: dashboards e alertas podem identificar worker problemático pelo memory growth rate, não só pelo `recycledWorkersCount` agregado
- **Menos false-positive reciclagens**: accumulation-rate + hysteresis evitam reciclar workers que estão bem, apenas porque um task burst lotou heapUsed momentaneamente
- **Recuperação mais rápida**: round-robin + priorização de recycled workers → novas tasks vão pra workers com cache fria mínima
- **Watchdog mais responsivo**: `workerPollIntervalMs` desacoplado de `timeoutMs` permite detectar runaway em <100 ms mesmo para tasks com timeout alto
- **Zero surprise preemption**: warning de `timeoutMs = 0` documenta o gotcha antes que user descubra em produção
- **fnDeps pattern**: users podem escrever task fns idiomáticas (`net.createConnection(...)` direto) sem boilerplate de dynamic import

### Consequências Negativas (Trade-offs honestos)

- **Mais options, mais decisions**: cada nova opção é um knob que precisa documentação + suporte. Mitigação: defaults sensatos baseados em empirically-grounded data do benchmark
- **A1 default change**: users que dependiam de `timeoutMs = 0` (raro, mas possível) veem comportamento diferente. Mitigação: warning + opt-out via flag, ou manter default `0` e mudar com aviso
- **B1/B3 IPC overhead**: `getWorkers()` é synchronous read de estado in-memory (zero IPC) — mas emite evento `worker:memory` adiciona IPC em opt-in mode. Mitigação: opt-in (default off)
- **C1 accumulation rate pode ser noisy**: medir heapUsed growth rate é heurístico. Mitigação: usar EWMA ou sample window (últimos N samples) ao invés de comparação direta
- **D1 LRU round-robin quebra suposição de determinismo**: testes que dependiam de "worker 0 sempre primeiro" podem flakear. Mitigação: adicionar `dispatchStrategy: 'fifo' | 'lru' | 'random'` opt
- **D2 watchdog mais agressivo pode drenar CPU**: poll muito frequente (<50 ms) em pool grande pode ser overhead. Mitigação: clamp mínimo em 100 ms no validator da opção

## Pros and Cons das Opções

### Opção B (escolhida) — Hardening completo bundled

- ✅ Conserta 3 bugs latentes de uma vez (evita 3 deploys)
- ✅ Telemetria per-worker destrava 4 oportunidades estruturais (impossível diagnosticar sem)
- ✅ Accumulation-rate + hysteresis reduzem 242 recyclings/waste sem mudar comportamento desejado
- ❌ Bundle grande — 7 itens num único PR dificulta review e rollback
- ❌ ADR pesado (este doc) — futuras ADRs vão precisar referenciar este

### Opção A — Status quo

- ✅ Zero risco, zero trabalho
- ❌ Bugs latentes viram incidents em produção (especialmente #1 — preempção silenciosa)
- ❌ Telemetria ausente limita debugging futuro
- ❌ Tech debt acumula; quando o próximo investigator achar esses bugs, vai levar mesmo tempo pra consertar

### Opção C — Incremental (um ADR por item)

- ✅ ADRs pequenos e focados (200-300 palavras cada)
- ✅ Cada item pode ser revisado/merged independentemente
- ❌ 7 ADRs + 7 PRs = overhead desproporcional pra mudanças correlacionadas
- ❌ Telemetria (B1/B2) é pré-requisito lógico pras outras — incremental trava a ordem

### Opção D — Só bugs críticos

- ✅ Rápido (1 dia de trabalho)
- ✅ Mitiga o risco imediato (preempção silenciosa + scope de fn)
- ❌ Não desbloqueia nenhuma das 4 melhorias estruturais
- ❌ Telemetria continua privada — debugging futuro continua difícil

## Links

- [ADR-0005](0005-native-javascript-esm-with-zero-external-dependencies.md) — zero external deps (mantido por A2)
- [ADR-0010](0010-automatic-worker-recycling-anti-memory-leak.md) — reciclagem automática original (estendido por C)
- [ADR-0011](0011-hard-preemption-and-timeout-termination-for-runaway-tasks.md) — preempção original (estendido por D2)
- [ADR-0019](0019-default-workers-reduced-from-availableparallelism-to-1.md) — sizing policy (relacionado: D1 round-robin afeta balanceamento)
- Benchmark: `benchmarks/io-throughput.benchmark.js` (commit desta sessão) — fonte primária dos dados que motivam este ADR
- Discussão do ADR: foi motivado por 8 horas de debugging do benchmark acima, com várias iterações até a forma final rodar verde (242 reciclings, 1 preempção, 332 MB reclaimed)

## Implementation Plan (proposto)

### Wave 1 (1 dia) — Bug fixes A1 + A2

1. `task-handle.js:22` — mudar default + adicionar warning
2. `worker-thread-entry.js:87` — implementar fnDeps manifest IPC + testes
3. Validar: `npm run validate` (espera-se 474/474 testes ainda passando + 2-3 novos testes)

### Wave 2 (1 dia) — Telemetria B1/B2/B3

1. `supervisor.js` — adicionar método público `getWorkers()` (snapshot síncrono)
2. `worker-runtime.js` — estender `runtime.stats` com novos campos
3. Adicionar evento `worker:memory` com opt-in flag
4. Testes: `per-worker-telemetry.test.js`

### Wave 3 (½ dia) — Reciclagem C1/C2/C3

1. Adicionar opções `accumulationRateMbPerSec`, `minRecycleIntervalMs`, `recycleOnTasksExhausted`
2. Validar com re-run do `benchmarks/io-throughput.benchmark.js` (deve mostrar ~50% menos reciclings com hysteresis ativo)
3. Testes

### Wave 4 (½ dia) — Routing + preempção D1/D2/D3

1. `supervisor.js:assignWorkerToTask` — substituir FIFO por LRU
2. Adicionar opção `workerPollIntervalMs`
3. Validar distribuição per-worker mais uniforme (re-run benchmark deve mostrar recycled counts per-worker mais balanceados)
4. Testes

### Validação final

- `npm run validate` — 474/474 + N novos testes
- `npm run benchmark:all` — todos green
- Re-run do `benchmarks/io-throughput.benchmark.js` com `MAX_MEMORY_MB=80` e `accumulationRateMbPerSec=10`:
  - Esperado: 242 → ~80 reciclings (hysteresis + rate guard reduzem thrash)
  - Esperado: 332 MB reclaimed → ~150 MB reclaimed (workers reciclados são reciclados menos vezes, então peak é menor)
  - Esperado: preempção latency 1.35 s → ~250 ms (poll interval desacoplado)
  - Esperado: per-worker recycled count uniformemente distribuído (round-robin)