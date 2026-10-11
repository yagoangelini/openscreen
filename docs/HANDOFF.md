# Handoff do fork — estado em 10/10/2026 (v2.1.0)

Leia isto antes de mexer no fork **yagoangelini/openscreen**. Aqui estão:

- o estado atual;
- onde mora cada recurso novo;
- como validar e publicar;
- as armadilhas que já custaram tempo;
- o que falta fazer.

As decisões e o porquê de cada fase estão em [`PLANO-FORK.md`](PLANO-FORK.md), que também traz a tabela de status por item. A referência técnica de cada subsistema está em [`technical-documentation/`](../technical-documentation/README.md); ela já descreve o comportamento do fork.

## Quem usa e para quê

- **O usuário:** cria vídeos no YouTube em pt-BR sobre M365, Copilot e Power Platform.
- **A máquina:** Dell G15 com Windows 11. A tela do notebook fica na Intel; o monitor externo, no HDMI, fica na RTX 3060.
- **O app do dia a dia:** a versão **instalada** do fork, que se atualiza pelo próprio app a partir das releases do GitHub do fork.
- **Prioridade nº 1:** nunca perder uma gravação nem travar um export.
- **Recursos novos:** todos opcionais e editáveis.

## Regras que não mudam

| Regra | Detalhe |
|---|---|
| PRs e pushes só no fork | `gh pr create --repo yagoangelini/openscreen`. Sem `--repo`, o `gh` aponta para o upstream. |
| Nada de GitHub Actions | Está desligado no fork (sem billing). Não reative, não dispare workflow. Toda validação é local. |
| App instalado do usuário | Nunca feche nem mate esse app. Teste numa instância isolada e mate só processos cuja `CommandLine` contenha o **seu** perfil de teste. |
| Antivírus | Não mexa em Kaspersky nem em configuração de segurança. A exclusão é tarefa do usuário (ver Pendências). |
| `rm -rf` | Bloqueado por um hook do usuário. Apague arquivo por arquivo, ou peça ao usuário. |
| Releases | Você pode publicar sem pedir (o usuário autorizou). Sempre suba a versão. |

## Estado atual

`main` do fork = **v2.1.1**, publicada e marcada como Latest. Desde a 2.1.0 o fork contém o **OpenScreen 2.0** do upstream (veja "Sincronizar com o upstream" abaixo). O histórico do fork, em ordem:

| Versão | Como entrou | Conteúdo |
|---|---|---|
| 1.14.0 | merge local | Fase 1 (gravação nunca se perde) e Fase 3 (GPU) |
| 1.15.0 | merge local, release nunca publicada | Fase 2 (export robusto, compositor na GPU de alto desempenho) e Fase 4 (auto-zoom calmo) |
| 1.16.0 | PR yagoangelini/openscreen#1 | Fases 5–7 parciais (lista abaixo) |
| 1.17.0 | PR yagoangelini/openscreen#2 | sugestões para acelerar esperas, títulos de capítulo com IA, `.srt` ao lado do export |
| 1.18.0 | PR yagoangelini/openscreen#3 | decisões da manhã (lista abaixo) |
| 1.19.0 | PR yagoangelini/openscreen#4 | voz e som do computador gravados à parte, com dois volumes |
| 1.19.1 | PR yagoangelini/openscreen#6 | correções dos recursos do fork achadas na análise de 10/10 ([`ANALISE-MELHORIAS.md`](ANALISE-MELHORIAS.md) §2) |
| 2.1.0 | PR yagoangelini/openscreen#7 | merge do OpenScreen 2.0: 408 commits do upstream, base 28/09 até `125ebd95` |
| 2.1.1 | PR yagoangelini/openscreen#9 | pedidos de 11/10: gravador na barra de tarefas, cursor menor e com px, início instantâneo, auto-zoom corrigido num take real |

**O que a 1.16.0 trouxe:**

- reabertura do microfone ou do fone que cai durante a gravação;
- canal do mic e limitador suave;
- cursor salvo durante a gravação, com reinício do leitor do cursor;
- atalhos mostrados na tela e anel de clique;
- desfoque automático por OCR;
- −14 LUFS no export;
- capítulos;
- proteção ao fechar durante um export.

**O que a 1.18.0 trouxe:**

- Esc no export pergunta antes de cancelar;
- webcam aberta só na contagem regressiva;
- NVENC na RTX;
- canal do mic Auto ou manual, com a dica do NVIDIA Broadcast;
- abertura do zoom em 2,5 s ou 1,5 s e modo de câmera para todos os zooms;
- menus de sites detectados por diferença de quadros;
- glossário;
- spotlight.

**O que a 2.1.0 trouxe do OpenScreen 2.0:**

- o mixer escreve 100 ms atrás do tempo real, o que tira as microfalhas da voz;
- H.264 High em BT.709 em todos os caminhos;
- o áudio termina junto com o vídeo;
- a tela não apaga durante a gravação;
- popups na gravação de janela;
- tela e câmera num relógio só;
- câmera na resolução real;
- prévia por texturas de GPU;
- transcrição com VAD, alinhador e "nomes e termos" do projeto como prompt do Whisper;
- som de clique opcional (desligado por padrão);
- cursores 3D Glass Lens;
- servidor MCP;
- editor com tooltips novos.

**O que a 2.1.1 trouxe** (pedidos do usuário de 11/10):

- **O gravador aparece na barra de tarefas** do Windows (`skipTaskbar` só fora do Windows, título "OpenScreen", `electron/windows.ts`). "Esconder barra" minimiza para lá.
- **Cursor menor por padrão:** 2.2, uma seta de 60 px a 1080p (era 3.6, 98 px).
  - O slider mostra o tamanho em px (`CURSOR_ARROW_PX_PER_UNIT_AT_1080` em `projectDefaults.ts`, `format` no `SliderCell`).
  - Os campos livres de zoom, velocidade e tamanho de texto mostram a unidade (`FieldUnit`).
- **Início instantâneo depois da contagem.**
  - O renderer chama `startNativeWindowsRecording` quando a contagem começa, com `startAtEpochMs` (o fim da contagem).
  - O `wgc-capture` abre câmera, encoders e áudio e então **dorme** até lá (`sleep_until`, não lê o stdin; foi o stdin que o Kaspersky barrou).
  - Cancelar a contagem chama `cancel-native-windows-pending-start`, que mata o helper antes do primeiro quadro e apaga o que ele abriu.
  - A câmera é nomeada pela lista de dispositivos (`webcamDeviceIdentityWithoutOpening`), sem o renderer abri-la antes.
  - Amostras do cursor anteriores ao primeiro quadro são descartadas, não empilhadas no 0 s (`shiftCursorTelemetry`).
  - O log `[native-wgc] capture started` traz `startTiming` (linhas `[start-timing]` do helper) e `afterCountdownMs`.
  - **Medido:** sem câmera, 14 ms depois da contagem. Com a C920 escura (lente tampada, brilho ~20/255), o helper espera os 3 s do "primeiro quadro visível", e o take sai ~2 s atrasado. Com a câmera acesa isso cai dentro da contagem.
- **Auto-zoom corrigido**, com a análise quadro a quadro de um take real de 34 s contra a transcrição (`zoom-suggestions.ts`, `framePopups.ts`):
  - mão parada no começo não dá zoom: o hover precisa explorar 15% da tela, estar num menu aberto ou levar a um clique;
  - dois cliques no mesmo menu ficam num plano só (`MERGE_MIN_SCALE` 1.3);
  - `fitScale` não reserva margem além da borda;
  - um clique que fecha menu não vira "popup novo" no scan de quadros;
  - escolher um item de menu termina o plano logo depois.
  - Melhorias que precisam da transcrição (palavras como "aqui", "clica", "nesse" como gatilho; ficar aberto na apresentação) ainda **não** foram feitas: o auto-zoom roda antes da transcrição.

Os PRs do fork são abertos e mesclados com `gh pr merge N --merge`, sem CI. Antes do merge, rode todo o portão de validação abaixo.

## Onde mora cada recurso do fork

| Recurso | Arquivos principais | Padrão |
|---|---|---|
| Pasta de gravações | `defaultCaptureOutputDir()` em `electron/ipc/handlers.ts`; setting `recording.recordingsFolder`; UI no modo Record (`RecStage.tsx`) | `Vídeos\OpenScreen` |
| Atalhos globais | `DEFAULT_SHORTCUTS` em `src/lib/shortcuts.ts`; `electron/globalShortcut.ts` | Ctrl+Shift+F9 grava/para; F10 pausa; F8 marcador; F12 mostra o app |
| Marcadores | `<take>.mp4.markers.json` (handlers.ts, `RECORDING_MARKERS_SUFFIX`) | — |
| Cursor salvo durante a gravação | `electron/recording/cursorCheckpoint.ts` (`<take>.mp4.cursor.ndjson` a cada 5 s, recuperado ao abrir o app) | sempre |
| Reinício do leitor de cursor | `windowsNativeRecordingSession.ts` (`MAX_HELPER_RESTARTS = 5`) | sempre |
| Mic: canal e limitador | `electron/native/wgc-capture/src/audio_sample_utils.{h,cpp}` (`MicrophoneChannelPicker`, `PeakLimiter`); pref `micChannelMode`; UI `HudDeviceSettings` | Auto |
| Dispositivo de áudio que cai | `wasapi_loopback_capture.cpp` (`reopen`); TS `readAudioDeviceDrops` → toasts `recording.audioDeviceLost*` | sempre |
| Voz e computador separados | C++ `aac_stem_writer.{h,cpp}`; TS `audioStemPathsFor`, `readStemsFinalized`, `readRecordingStems`; asset `audioStems`; Rust `ClipStems`/`SumStream` em `crates/compositor/src/audio_stream.rs`; preview `VirtualPreview.tsx` | grava quando mic **e** sistema estão ligados |
| Volumes Voz e Computador | `voiceGainDb` e `systemGainDb` no editorSettings; `AudioPane`; scene `audio` | 0 dB |
| NVENC/DXGI na RTX | `main.cpp` (`deviceAdapterVendorId`, 0x10DE); env `OPENSCREEN_WGC_ENABLE_DXGI_INPUT` 0/1 vence | ligado em NVIDIA |
| Compositor na GPU forte | `Gpu::create_backend` (Rust); env `OPENSCREEN_COMPOSITOR_ADAPTER` | alto desempenho |
| Anel de clique | Rust `click_ring` (SceneCursor); TS `cursor.clickRing` / `cursorClickRing` | ligado em projeto novo |
| Spotlight | Rust `spotlight_cb` (modo 20 — o 19 é o Glass Lens —, **só D3D11/Windows**); TS `cursor.spotlight` / `cursorSpotlight`; toggle "Holofote" | desligado |
| Atalhos na tela | `src/lib/ai-edition/keystrokes.ts` (seguro para o main) + `keystrokeRegions.ts` (renderer) | ligado em projeto novo |
| Desfoque automático (OCR) | `ocr-scan.cpp` → `electron/recording/ocrScan.ts` → `src/lib/ai-edition/redaction.ts`; `recordingImport.applyFreshRecordingRedactions`; pref `autoRedact` | ligado (como sugestão) |
| Menus de sites no auto-zoom | `ocr-scan.exe --popups`; `src/lib/ai-edition/timeline/framePopups.ts` | ligado |
| Auto-zoom calmo | `timeline/zoom-suggestions.ts` (planner), `zoom-motion.ts` (`resolveZoomRendering`, `MIN_WIDE_SEC_OPTIONS`), `AutoZoomSettings` | calmo, 2,5 s |
| Auto-zoom guiado pela fala | `timeline/speechCues.ts` (palavras de apontar, frases, rolagem); `zoom-suggestions.ts` (`words` / `wordsByAssetId`, `speechAwareEnd`); `apply-auto-zooms.ts` (`transcriptWordsByAssetId`, `transcriptSignature`, `legacyEditor.autoZoomTranscript`); `autoZoomReplan.ts`; janela pós-gravação `TranscriptAutoZoomDialog.tsx`; aviso `TranscriptAutoZoomBar.tsx` no painel da transcrição; pref `autoZoomAfterRecording` | pergunta depois de gravar |
| Acelerar esperas | `timeline/waits.ts` (`WAIT_SPEED = 4`); Auto-enhance no `V4Timeline` | só sugere |
| Glossário | `src/lib/ai-edition/transcription/glossary.ts`; aplicado em `transcriptionStore.ts`; pref `glossary` | lista padrão M365 |
| Transcrição automática | pref `autoTranscribe` (Media stage) | **desligada** |
| Capítulos e `.srt` | `chapters.ts`, `captions/srt.ts`, `YouTubeChapters.tsx`, IPC `write-subtitles-beside`, `electron/ai-edition/chapter-titles.ts` | no fim do export |
| Loudness YouTube | `src/lib/ai-edition/deliveryLoudness.ts` (+2 dB, −16 → −14 LUFS); pref `youtubeLoudness` | ligado |
| Esc/fechar durante um export | `ExportDialog` (`export-confirm-close`); proteção ao sair do app em `main.ts` (`exportJobs.isRunning`) | pergunta |
| Webcam na contagem | `useScreenRecorder` (`deferWebcamToCountdown`, win32) | sempre |
| Diagnóstico | `handlers.ts`: `gpu: {compositor, chromium}` | — |

**Arquivos que podem aparecer ao lado de cada gravação:**

- `<take>.session.json`
- `<take>.mp4.cursor.json`
- `<take>.mp4.cursor.ndjson`
- `<take>.mp4.markers.json`
- `<take>.voice.m4a`
- `<take>.system.m4a`

Detalhes em [recording.md](../technical-documentation/architecture/recording.md#output-files-and-sidecars).

## Comandos

### Preparar uma máquina limpa

```bash
npm ci
```

```bash
npm run fetch:ffmpeg
```

Depois disso:

- `npm run build:native:win` compila o gravador C++ e o `ocr-scan.exe`, roda os testes nativos e copia tudo para `electron/native/bin/win32-x64`;
- `npm run build:native:compositor` compila o addon Rust.

São necessários o VS 2022 Build Tools (C++ e Windows SDK), CMake, Ninja, Rust MSVC e LLVM.

### Portão de validação (rode tudo antes de mesclar)

```bash
npx tsc --noEmit
```

```bash
npx tsc -p tsconfig.test.json --noEmit
```

```bash
npm run lint
```

```bash
npm run i18n:check
```

```bash
npm run build-vite
```

```bash
npm run test
```

```bash
node scripts/check-docs.mjs
```

Notas sobre o portão:

- **`build-vite` é obrigatório.** O `tsc` não pega um import `@/` num módulo que o processo main carrega; só o bundle do main quebra.
- **Durante o trabalho, rode só os testes tocados:** `npx vitest --run <arquivo>`.
- **Suíte completa:** cerca de 4700 testes em cerca de 340 arquivos. Rode uma vez no fim.

**Testes nativos:**

- **Rust:**

  ```bash
  node scripts/cargo-msvc.mjs test -p openscreen-compositor --lib
  ```

  São 436 testes. O script carrega o ambiente MSVC e o ffmpeg.

- **C++:** rodam dentro do `npm run build:native:win`.

### Teste ponta a ponta numa instância isolada

As ferramentas estão em `scripts/fork-e2e/`. O roteiro:

1. **Gere o build** com `npm run build-vite`. Para mudança nativa, rode antes `build:native:win` e `build:native:compositor`.
2. **Crie um perfil de teste** (uma pasta temporária) com um `recording-settings.json` dentro:

   ```json
   {"micEnabled": true, "systemAudioEnabled": true, "countdownSeconds": 0, "recordingsFolder": "<outra pasta temporária>"}
   ```

   Assim os takes de teste **não** vão para o `Vídeos\OpenScreen` do usuário.
3. **Abra a instância:**

   ```bash
   node_modules/electron/dist/electron.exe . --user-data-dir=<perfil> --remote-debugging-port=9233
   ```

   Rode em background.
4. **Grave:**

   ```bash
   node scripts/fork-e2e/record-take.mjs --port 9233 --keys
   ```

   - `--screen 1` grava o monitor da RTX (caminho NVENC/DXGI) e `--screen 0` a tela do notebook (Intel, caminho de CPU).
   - `--keys` digita atalhos numa janela própria. Só digita se essa janela estiver em primeiro plano.
5. **Meça com o ffprobe** de `crates/thirdparty/ffmpeg-*/bin`:
   - `-show_entries stream=codec_type,profile,color_space,duration`;
   - o esperado é High, bt709, e áudio do tamanho do vídeo;
   - os stems estão no projeto do perfil (`projects/*.openscreen` → `assets[0].audioStems` e `keystrokes`).
6. **Exporte pela CLI:**

   ```bash
   node_modules/electron/dist/electron.exe . --user-data-dir=<outro perfil> export <projeto> -o <saída.mp4> --json
   ```

7. **Feche** só a sua instância, filtrando por nome **e** perfil:

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*<perfil>*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
   ```

   Sem o filtro de nome, o padrão casa também com as shells do agente e as derruba.
8. **Apague os takes** com caminhos literais (`rm -f "./arquivo"`). Eles gravam a tela real do usuário.

Notas:

- O HUD e o editor nunca dividem a tela. `record-take.mjs` volta ao HUD sozinho.
- A fonte escolhida num take fica lembrada; para mudar, use `--screen`.
- Clique injetado não prova que o HUD é alcançável por um mouse de verdade. Para isso, use computer-use (ver `AGENTS.md`).
- **Smoke test do instalador:** abra `release/X.Y.Z/win-unpacked/Openscreen.exe --user-data-dir=<temp> --remote-debugging-port=9232` e rode `node scripts/fork-e2e/smoke-hud.mjs --port 9232`. Feche filtrando por `Name='Openscreen.exe'` **e** pelo perfil, porque o app instalado do usuário tem o mesmo nome.

### Release local

Ancorado como `release-local`. A ordem:

1. Branch de feature → PR no fork → `gh pr merge N --merge --repo yagoangelini/openscreen` → `git pull` na `main`.
2. `npm version X.Y.Z --no-git-tag-version`, depois `git commit -am "chore: release X.Y.Z of the fork"` e push.
3. `npm run build:win -- --publish never`. Este passo recompila **todos** os nativos e o addon, e o resultado vai para `release/X.Y.Z/`.
4. Smoke test: abra `release/X.Y.Z/win-unpacked/Openscreen.exe --user-data-dir=<temp>` e confira se o HUD abre.
5. Publique:

   ```bash
   gh release create vX.Y.Z --repo yagoangelini/openscreen --target main --title "OpenScreen X.Y.Z (fork)" release/X.Y.Z/Openscreen.Setup.X.Y.Z-x64.exe release/X.Y.Z/Openscreen.Setup.X.Y.Z-x64.exe.blockmap release/X.Y.Z/latest.yml
   ```

Desde a 2.1.0 o instalador tem o sufixo `-x64` (configuração do upstream); confira o nome em `release/X.Y.Z/latest.yml` antes de publicar. O app instalado oferece a atualização a partir do `latest.yml`. O feed está em `electron-builder.json5` → `publish` (owner `yagoangelini`).

## Sincronizar com o upstream

O fork acompanha `getopenscreen/openscreen`. O último merge (2.1.0) foi até `125ebd95`.

### Para trazer o que o upstream fizer depois

1. **Buscar o upstream, só lendo:**

   ```bash
   git fetch https://github.com/getopenscreen/openscreen.git main:refs/remotes/upstream/main
   ```

2. **Medir os conflitos sem tocar na árvore:**

   ```bash
   git merge-tree --write-tree --name-only main upstream/main
   ```

3. **Fazer o merge num branch** (`merge/upstream-AAAA-MM-DD`), com `git merge --no-ff --no-commit upstream/main`.
4. **Resolver os conflitos:**
   - nas traduções, com `node scripts/merge-json-3way.mjs $(git diff --name-only --diff-filter=U | grep "^src/i18n/")`, que faz o merge de 3 vias por chave e mantém a redação do fork quando os dois lados mudaram;
   - no resto, à mão. Depois de um rename, o marcador vem como `<<<<<<< HEAD:caminho/antigo`: procure com `git grep -n -E "^(<<<<<<<|>>>>>>>) "`.
5. **Validar com o portão completo**, mais `build:native:win`, `build:native:compositor` e os testes Rust.
6. **Gravar de verdade numa instância isolada**: a tela do notebook e a do monitor da RTX.

### Decisões tomadas no merge de 10/10, a manter nos próximos

- **Export:** fica o cancelamento **do fork**, com um controle só para MP4 e GIF (`createExportControl` / `cancelExport`, `EXPORT_CANCELLED`), a fase "finalizing" e o áudio em streaming (`ProgrammeAudio`).
  - O som de clique do upstream entra no streaming (`ClickHits` em `audio_stream.rs`).
  - `export_control.rs` oferece também a assinatura do upstream (`with_staged_output(target, control, |file, path|)`). O arquivo de staging termina com a extensão do destino.
  - O GIF usa o encoder em pool do upstream.
- **Mixer de áudio (C++):** fica o colchão de 100 ms e o relógio do upstream, com a soma em double, o limitador, o seletor de canal e os stems do fork.
- **Pasta de gravações:** fica a configuração do fork (`Vídeos\OpenScreen`). A linha duplicada do upstream no modo Record foi removida. O mecanismo dele (`RecordingsDirManager`) continua no código, sem interface.
- **Shader:** o modo 19 é o Glass Lens do upstream e o **spotlight é o modo 20**.
- **HUD:** fica o layout do upstream, com a confirmação de Reiniciar/Cancelar, o canal do microfone e a dica do NVIDIA Broadcast do fork.
- **Padrões do fork que o upstream não tem:** 16:9 para projetos novos, NVENC/DXGI na RTX, transcrição automática desligada e anel de clique ligado.
- **Dependências:** `@noble/hashes` está declarado em `devDependencies`. O npm 11 não instala dependências peer opcionais, e o teste do AppImage precisa dele.

## Armadilhas já encontradas

- **Imports `@/` no main.** Módulos que o processo main importa precisam de imports relativos: `keystrokes.ts`, que o `document-service` usa, e `zoomMath/constants.ts`, que o agente e o MCP leem. Só o `build-vite` pega isso.
- **`rm` com variável é bloqueado** pela checagem de segurança. Use caminhos literais. `rm -rf` é bloqueado pelo hook do usuário.
- **npm 11 não instala dependências peer opcionais** que o npm 10 do upstream instala. Se um teste do upstream não achar um módulo, declare-o em `devDependencies` (foi o caso de `@noble/hashes`).
- **Arquivo travado no Windows** (`UNKNOWN: unknown error, open`) durante uma escrita: é o antivírus ou um indexador. Tente de novo.
- **Heredoc no Bash estraga barras invertidas.** Para editar código, use a ferramenta Edit ou Write, ou um script `.cjs` com o padrão `edit(file, [[old, new]])`, que checa unicidade e chama `c.replace(a, () => b)`.
- **Worktrees com junctions.** O `git worktree remove` apagou o `node_modules` e o `crates/thirdparty` da checkout principal por causa das junctions. Antes de remover uma worktree, remova cada junction com `cmd /c rmdir <junction>`. Se acontecer, `npm ci` e `npm run fetch:ffmpeg` restauram tudo.
- **Binários nativos congelados.** Os arquivos em `electron/native/bin/win32-x64/` só mudam com `build:native:win` ou `build:native:compositor`. Confira com `findstr`, prefixando `MSYS_NO_PATHCONV=1` no Git Bash. Strings UTF-16 não aparecem no `findstr`.
- **ffmpeg LGPL sem libx264.** Para gerar vídeos de teste, use `h264_mf`.
- **Testes de auditoria.**
  - `documentWriteAudit.test.ts` exige uma linha para cada novo `saveDocument`.
  - O teste de paridade da scene exige que `audio` só tenha ganhos lineares.
  - O teste do CursorPane exige que o impacto de clique fique logo abaixo dos níveis de bounce.
- **`recordingImport.test`.** Um teste trava saves de propósito; describes novos entram **antes** dele.
- **Disco cheio.** O C: tem cerca de 9,7 GB livres e já encheu uma vez. As pastas `release/1.13.0` a `1.19.0` são builds antigos que podem ir embora, mas só arquivo por arquivo ou pedindo ao usuário. `crates/target` também cresce (cerca de 3 GB).
- **Kaspersky.** Ele colocou em quarentena um gravador que ficava parado esperando no stdin (o "início armado" de `0d9dc984`, revertido em `c956ea4e`). Desde a 2.1.1 o início durante a contagem usa `startAtEpochMs` e um `sleep_until`, sem ler o stdin antes de gravar. Se o `wgc-capture.exe` sumir depois de um build, esse é o primeiro suspeito.

## Pendências

**Plano em andamento** (decidido em 10/10 à tarde, `PLANO-FORK.md`):

1. 1.19.1, correções. **Feito.**
2. 2.1.0, OpenScreen 2.0. **Feito.**
3. **2.2.0, câmera e vinheta.** É o próximo passo.
4. Os extras aprovados, todos opcionais e editáveis:
   - aviso de microfone mudo durante a gravação;
   - palavras sensíveis no desfoque, com botão para procurar de novo;
   - retângulo de destaque e passos numerados;
   - remover "né", "tipo", "éé" e silêncios sem IA.

### Próximo passo: 2.2.0, trilha da câmera, câmera e vinheta

**Pedido de 11/10:** a câmera numa trilha própria da timeline, com cortes e cada pedaço editável. O plano completo, em fases, está em [`PLANO-TRILHA-CAMERA.md`](PLANO-TRILHA-CAMERA.md). Ele absorve os itens 1 e 2 abaixo: o HUD escreve pedaços da trilha, e "Sem câmera" é um modo do pedaço. Comece pela fase 0 (modelo e migração v9).

O que o usuário pediu está em `PLANO-FORK.md`, "Decisões de 10/10/2026 (tarde)". O que já foi levantado no código:

1. **"Rosto / Tela + câmera" no HUD, mais um atalho global** (sugestão: Ctrl+Shift+F7, configurável).
   - Gravar sempre tela e câmera.
   - O main guarda as trocas como os marcadores (`nativeWindowsMarkersMs` em `handlers.ts`) e grava um sidecar `<take>.mp4.layout.json`.
   - A importação vira esse sidecar em `legacyEditor.cameraFullscreenRegions`, com `anchorRegionsWithDerivedMs`, como `addCameraFullscreen` em `useTimeline.ts`.
   - A escrita é uma edição desfazível, no mesmo fluxo de `applyFreshRecordingRedactions`.
   - O modo escolhido antes de gravar é o estado inicial, e entra como pref.
   - O atalho entra em `DEFAULT_SHORTCUTS` (`src/lib/shortcuts.ts`) e em `electron/globalShortcut.ts`.
   - Há uma linha do `documentWriteAudit` para a escrita nova.
2. **Região "Sem câmera".** Ideia: o mesmo tipo de região da "Câmera cheia", com um campo de modo (`hidden`).
   - A timeline, o clipboard e a ancoragem continuam servindo.
   - No Rust, `SceneCameraFullscreenRegion` ganha `#[serde(default)] hidden`, e `frame_geometry.rs` some com a câmera com fade onde hoje usa `camera_fullscreen_progress_at`.
   - Ganha tecla, botão na timeline e cor própria.
3. **Vinheta, só pelo botão "Inserir vinheta".**
   - O arquivo fica salvo numa pref.
   - O corte do clipe no cursor já existe para palavras inseridas: `insertGeneratedClip` em `src/lib/ai-edition/document/insertion.ts` divide o clipe, coloca o novo no meio e leva as regiões para as duas metades (`fanOutAnchors`, `rederiveRegionMs`). Generalize para um asset de vídeo comum.
   - **"Tela cheia, sem moldura"** parece dar só no TS: o compositor já aceita um layout por clipe (`layout_by_clip` / `ResolvedClipLayout` em `crates/compositor/src/scene.rs`). Para o clipe da vinheta, `screenRect` 0,0,1,1, raio 0, `screenCover`, sem webcam; montado em `buildSceneDescription`, que já resolve um layout por clipe visível.
   - **Confirmar** que a sombra e a moldura de dispositivo não aparecem com esse layout.
   - A vinheta mantém o próprio volume; confirmar a normalização de loudness para esse asset.

Valide com `record-take.mjs`, com um take que comece no rosto e passe para a tela, e depois exporte.

**Esperando o usuário:**

1. **Kaspersky:** a exclusão da pasta do OpenScreen instalado continua recomendada, mas não é mais pré-requisito: o início durante a contagem voltou de outro jeito na 2.1.1 (veja acima).
2. **Validar a 2.1.0 no uso real**, que traz o 2.0 inteiro:
   - gravar com mic e sistema, nas duas telas;
   - ouvir se a voz ainda falha;
   - mexer nos volumes Voz e Computador;
   - exportar;
   - conferir o spotlight, o OCR, os menus de sites e o editor novo.

**Itens do plano ainda não feitos:**

3. Confirmar o botão Sair do HUD durante a gravação. Hoje o app só salva ao sair, sem perguntar.
4. Opção que grava a preferência "Alto desempenho" do Windows (`UserGpuPreferences`) para `Openscreen.exe`, `wgc-capture.exe` e `whisper-stt-server.exe`.
5. Medir o tempo de abertura (app pronto → HUD carregado).
6. Sincronia de áudio pelo relógio do sistema. Hoje há um `(void)qpcPosition` em `wasapi_loopback_capture.cpp`.
7. Avisar no app quando o leitor do cursor desiste. Hoje é só `logDiagnostic("restart-gave-up")`.
8. Mostrar o projeto danificado na lista. Hoje só existe a restauração pelo `.bak`.
9. `appId` próprio do fork: ainda é `com.etiennelescot.openscreen`. **Cuidado:** trocar muda a pasta de dados e a identidade do instalador, então planeje uma migração antes.
10. Whisper large-v3-turbo como padrão. Ainda é `ggml-small-q8_0.bin` (`electron/stt/modelManager.ts`) e precisa de espaço em disco.
11. Spotlight no Metal e no wgpu (mac/Linux), se um dia importar.
12. Poll do HUD ainda a cada 32 ms (item 3.5 não revisto).
13. Fila do mixer de áudio sem limite e sem compensar a diferença de relógio (`AudioMixer::append` em `audio_sample_utils.cpp`). Vai junto com o item 6. O colchão de 100 ms do 2.0 resolveu a oscilação (as microfalhas), não a deriva de relógio.
14. Erros WinRT: proteger `CreateFreeThreaded`, `CreateCaptureSession` e o caminho legado `onFrameArrived` (`wgc_session.cpp`).
15. Parada: `webcamCapture.stop()` roda antes de finalizar a tela (`main.cpp`), limitado só pelo watchdog de 8 s.
16. Whisper em prioridade baixa, ou só com o player parado (`electron/stt/whisperServer.ts`).
17. Não incomodar como aviso antes de gravar. Hoje é uma linha fixa no modo Record.

Nenhum desses itens foi pedido de novo. A ordem sugerida é a da prioridade do usuário: 13/6, 14, 15 e 3 protegem gravações; o resto é conforto.

A tabela completa (feito / parcial / pendente, item por item) está em [`PLANO-FORK.md`](PLANO-FORK.md#status-em-10102026).

## Memória do agente

Em `C:\Users\Yago Angelini\.claude\projects\C--Users-Yago-Angelini-Downloads-openscreen\memory\`:

- `fork-roadmap.md`
- `pr-and-ci-policy.md`
- `release-updates.md`
- `worktree-junctions.md`
- `user-profile.md`

Se algo aqui mudar, atualize este arquivo **e** a memória.
