# Handoff do fork — estado em 10/10/2026 (v1.19.0)

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

`main` do fork = **v1.19.0**, publicada e marcada como Latest. O histórico do fork, em ordem:

| Versão | Como entrou | Conteúdo |
|---|---|---|
| 1.14.0 | merge local | Fase 1 (gravação nunca se perde) e Fase 3 (GPU) |
| 1.15.0 | merge local, release nunca publicada | Fase 2 (export robusto, compositor na GPU de alto desempenho) e Fase 4 (auto-zoom calmo) |
| 1.16.0 | PR yagoangelini/openscreen#1 | Fases 5–7 parciais (lista abaixo) |
| 1.17.0 | PR yagoangelini/openscreen#2 | sugestões para acelerar esperas, títulos de capítulo com IA, `.srt` ao lado do export |
| 1.18.0 | PR yagoangelini/openscreen#3 | decisões da manhã (lista abaixo) |
| 1.19.0 | PR yagoangelini/openscreen#4 | voz e som do computador gravados à parte, com dois volumes |

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
| Spotlight | Rust `spotlight_cb` (modo 19, **só D3D11/Windows**); TS `cursor.spotlight` / `cursorSpotlight`; toggle "Holofote" | desligado |
| Atalhos na tela | `src/lib/ai-edition/keystrokes.ts` (seguro para o main) + `keystrokeRegions.ts` (renderer) | ligado em projeto novo |
| Desfoque automático (OCR) | `ocr-scan.cpp` → `electron/recording/ocrScan.ts` → `src/lib/ai-edition/redaction.ts`; `recordingImport.applyFreshRecordingRedactions`; pref `autoRedact` | ligado (como sugestão) |
| Menus de sites no auto-zoom | `ocr-scan.exe --popups`; `src/lib/ai-edition/timeline/framePopups.ts` | ligado |
| Auto-zoom calmo | `timeline/zoom-suggestions.ts` (planner), `zoom-motion.ts` (`resolveZoomRendering`, `MIN_WIDE_SEC_OPTIONS`), `AutoZoomSettings` | calmo, 2,5 s |
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

Notas sobre o portão:

- **`build-vite` é obrigatório.** O `tsc` não pega um import `@/` num módulo que o processo main carrega; só o bundle do main quebra.
- **Durante o trabalho, rode só os testes tocados:** `npx vitest --run <arquivo>`.
- **Suíte completa:** cerca de 3850 testes em cerca de 295 arquivos. Rode uma vez no fim.

**Testes nativos:**

- **Rust:**

  ```bash
  node scripts/cargo-msvc.mjs test -p openscreen-compositor --lib
  ```

  São 405 testes. O script carrega o ambiente MSVC e o ffmpeg.

- **C++:** rodam dentro do `npm run build:native:win`.

### Teste ponta a ponta numa instância isolada

```bash
node_modules/electron/dist/electron.exe . --user-data-dir=%TEMP%\os-e2e-profile --remote-debugging-port=9229
```

- Rode depois de `npm run build-vite`.
- Conecte o Playwright com `chromium.connectOverCDP("http://127.0.0.1:9229")` e clique pelos `data-testid` (por exemplo `launch-record-button`, `source-selector-card`, `source-selector-share-button`).
- Prefira perfis com o `user-data-dir` próprio: o app é single-instance por perfil e não conflita com o app instalado.
- O seletor de fonte abre com atraso. Se o card não aparecer, rode o clique de novo.
- Clique injetado não prova que o HUD é alcançável. Para isso, use computer-use (ver `AGENTS.md`).

### Release local

Ancorado como `release-local`. A ordem:

1. Branch de feature → PR no fork → `gh pr merge N --merge --repo yagoangelini/openscreen` → `git pull` na `main`.
2. `npm version X.Y.Z --no-git-tag-version`, depois `git commit -am "chore: release X.Y.Z of the fork"` e push.
3. `npm run build:win -- --publish never`. Este passo recompila **todos** os nativos e o addon, e o resultado vai para `release/X.Y.Z/`.
4. Smoke test: abra `release/X.Y.Z/win-unpacked/Openscreen.exe --user-data-dir=<temp>` e confira se o HUD abre.
5. Publique:

   ```bash
   gh release create vX.Y.Z --repo yagoangelini/openscreen --target main --title "OpenScreen X.Y.Z (fork)" release/X.Y.Z/Openscreen.Setup.X.Y.Z.exe release/X.Y.Z/Openscreen.Setup.X.Y.Z.exe.blockmap release/X.Y.Z/latest.yml
   ```

O app instalado oferece a atualização a partir do `latest.yml`. O feed está em `electron-builder.json5` → `publish` (owner `yagoangelini`).

## Armadilhas já encontradas

- **Imports `@/` no main.** Módulos que o processo main importa (por exemplo `keystrokes.ts`, que o `document-service` usa) precisam de imports relativos. Só o `build-vite` pega isso.
- **Heredoc no Bash estraga barras invertidas.** Para editar código, use a ferramenta Edit ou Write, ou um script `.cjs` com o padrão `edit(file, [[old, new]])`, que checa unicidade e chama `c.replace(a, () => b)`.
- **Worktrees com junctions.** O `git worktree remove` apagou o `node_modules` e o `crates/thirdparty` da checkout principal por causa das junctions. Antes de remover uma worktree, remova cada junction com `cmd /c rmdir <junction>`. Se acontecer, `npm ci` e `npm run fetch:ffmpeg` restauram tudo.
- **Binários nativos congelados.** Os arquivos em `electron/native/bin/win32-x64/` só mudam com `build:native:win` ou `build:native:compositor`. Confira com `findstr`, prefixando `MSYS_NO_PATHCONV=1` no Git Bash. Strings UTF-16 não aparecem no `findstr`.
- **ffmpeg LGPL sem libx264.** Para gerar vídeos de teste, use `h264_mf`.
- **Testes de auditoria.**
  - `documentWriteAudit.test.ts` exige uma linha para cada novo `saveDocument`.
  - O teste de paridade da scene exige que `audio` só tenha ganhos lineares.
  - O teste do CursorPane exige que o impacto de clique fique logo abaixo dos níveis de bounce.
- **`recordingImport.test`.** Um teste trava saves de propósito; describes novos entram **antes** dele.
- **Disco cheio.** O C: tem cerca de 12 GB livres e encheu uma vez. As pastas `release/1.13.0` a `1.18.0` são builds antigos que podem ir embora, mas só arquivo por arquivo ou pedindo ao usuário. `crates/target` também cresce.
- **Kaspersky.** Ele coloca em quarentena um gravador que fica parado esperando no stdin (o "início armado"). Esse modo foi revertido; não reintroduza sem a exclusão do usuário.

## Pendências

**Esperando o usuário:**

1. **Kaspersky: lembre o usuário** de criar a exclusão para a pasta do OpenScreen instalado. Depois disso, reative o início armado do gravador durante a contagem, que ganha 1 a 3 s.
2. **Validar a 1.19.0 no uso real:**
   - gravar com mic e sistema;
   - mexer nos volumes Voz e Computador;
   - exportar;
   - conferir o spotlight, o OCR e os menus de sites.

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
13. Fila do mixer de áudio sem limite e sem compensar a diferença de relógio (`AudioMixer::append` em `audio_sample_utils.cpp`). Vai junto com o item 6.
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
