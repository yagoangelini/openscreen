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

`main` do fork = **v2.7.1**, publicada e marcada como Latest. Desde a 2.1.0 o fork contém o **OpenScreen 2.0** do upstream (veja "Sincronizar com o upstream" abaixo). O histórico do fork, em ordem:

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
| 2.2.0 | PRs yagoangelini/openscreen#10 e #11 | auto-zoom guiado pela transcrição (pergunta depois de gravar, janela de progresso, refazer depois de corrigir) e trilha da câmera na timeline (schema v9: pedaços PiP / tela cheia / sem câmera, tecla B) |
| 2.3.0 | PRs yagoangelini/openscreen#13, #14 e #15 | aparência própria por pedaço da câmera (fase 3) e as correções do E2E da 2.2.0: contagem fora do take, export H.264 High/BT.709, câmera escura, formato da C920, colar estilo, sair durante a gravação |
| 2.4.0 | PRs yagoangelini/openscreen#17 a #21 | Rosto / Tela + câmera no HUD (fase 4, Ctrl+Shift+F7), take salvo ao sair oferecido de novo, desfoque na prévia dentro de um corte, foco dos botões do HUD, entradas OpenScreen Studio e OpenScreen Recorder, pt-BR como idioma nativo |
| 2.5.0 | PRs yagoangelini/openscreen#23 a #31 | identidade do fork (Yago Angelini) e assinatura autoassinada, parada instantânea e início na hora, transcrição turbo pt-BR com vocabulário M365/IA, correções do E2E da 2.4.0, Limpar fala, quem fala, palavras sensíveis próprias, aprovar e desfazer respostas da IA, desenhar na tela, janela da câmera, aviso de mic mudo, destaque e passos, Melhorar a voz, câmera 3D |
| 2.6.0 | PRs yagoangelini/openscreen#35 a #37 | auto-zoom diretor (lê a tela: menus por hover, diálogos, trocas de página; pan entre áreas, seguir o ponteiro) e cursor sem atraso (suavização de fase zero, relógio pelo primeiro quadro, leitura 4× mais rápida) |
| 2.7.0 | PRs yagoangelini/openscreen#39 a #48 | gravação na hora (contagem 5 s, câmera em paralelo), parar no aperto sem o clique, Rosto/Tela no aperto, primeiros quadros limpos, pedaços da câmera na importação, biblioteca de gravações (subpasta por take, nome ao terminar, renomear e excluir), Padrões globais, avisos do HUD e prévia da câmera, Todos os trechos, Restaurar e histórico do desfazer |
| 2.7.1 | PRs yagoangelini/openscreen#50 a #52 | ímã na timeline (agulha, cortes, bordas; Alt solta), aba Mídia (excluir o take aberto sem prompt do Windows, sem timeline, um card por gravação) |

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
- H.264 High em BT.709 em todos os caminhos da gravação (o export só ganhou isso no branch `fix/e2e-native`, ver abaixo);
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
  - **Medido:** sem câmera, 14 ms depois da contagem. Com a C920 escura (lente tampada), o helper esperava os 3 s do "primeiro quadro visível", e o take saía ~2 s atrasado. Corrigido no branch `fix/e2e-native` (abaixo): 13–17 ms com a C920 tampada.
- **Auto-zoom corrigido**, com a análise quadro a quadro de um take real de 34 s contra a transcrição (`zoom-suggestions.ts`, `framePopups.ts`):
  - mão parada no começo não dá zoom: o hover precisa explorar 15% da tela, estar num menu aberto ou levar a um clique;
  - dois cliques no mesmo menu ficam num plano só (`MERGE_MIN_SCALE` 1.3);
  - `fitScale` não reserva margem além da borda;
  - um clique que fecha menu não vira "popup novo" no scan de quadros;
  - escolher um item de menu termina o plano logo depois.
  - Melhorias que precisam da transcrição (palavras como "aqui", "clica", "nesse" como gatilho; ficar aberto na apresentação) ainda **não** foram feitas: o auto-zoom roda antes da transcrição.

**Correções nativas do E2E da 2.2.0** (branch `fix/e2e-native`, relatório B-2 a B-5):

- **Export em H.264 High com BT.709.** `crates/compositor/src/encoder_tags.rs` (`tag_bt709_and_profile`), chamado no `try_open` dos três pipelines antes do `avcodec_open2`: as quatro cores no contexto (primaries/trc/matrix BT.709, faixa TV) e, para H.264, `profile` High no contexto **e** na opção privada (o NVENC e o AMF leem a privada, cujo padrão Main vencia). Medido num export pela CLI com `h264_nvenc`: `profile=High`, `tv/bt709/bt709/bt709`, VUI do SPS com 1/1/1 e caixa `colr` nclx no MP4.
- **Câmera escura não atrasa nem some.** No `main.cpp` a câmera começa a ler logo depois de aberta (não mais depois dos encoders), e a espera pelo quadro visível termina no fim da contagem, com no mínimo 1 s de câmera (sem contagem continua 3 s). Se só vierem quadros escuros, eles são gravados mesmo assim (arquivo válido e alinhado desde 0 s, preto até destampar) e o helper emite `{"event":"warning","code":"webcam-dark"}`. O main lê com `readWebcamDark` (`nativeWindowsCaptureStop.ts`), devolve `webcamDark` no resultado do start, e o renderer mostra o toast `recording.cameraDark`. O escritor não testa mais visibilidade durante o take: lente tampada no meio do take fica preta, em vez de congelar no último quadro claro. Um `-webcam.mp4` que ainda assim termine vazio é apagado, e o toast do fim passa a ser `recording.cameraNoFrames`.
- **Formato da webcam.** `chooseWebcamFormat` (`webcam_format.cpp`) põe primeiro um modo que aguente o ritmo (24 fps, ou o alvo se for menor), depois o tamanho, o fps e por fim sem compressão > MJPEG > outro comprimido. Os modos comprimidos só entram no caminho NV12 (câmera em arquivo próprio); o BGRA mantém a regra antiga. A linha `INFO: Native webcam modes:` lista o que a câmera oferece. Na C920 pelo Media Foundation há NV12 1080p30 (decodificado pelo frame server do Windows): em 2160p a regra antiga escolhia YUY2 2304×1536 a 2 fps, o driver recusava e caía em 640×480; agora 1080p e 2160p dão `1920x1080@30 (uncompressed)`.

**Duas entradas no Windows: OpenScreen Studio e OpenScreen Recorder** (pedido de 11/10):

- **`Openscreen.exe` sem argumento abre o Studio** (o editor, no último projeto). É o que o ícone já fixado na barra de tarefas do usuário roda. **`Openscreen.exe --recorder` abre o HUD.** `--studio` força o Studio. Fora do Windows o padrão continua sendo o HUD. Lógica pura em `electron/launchMode.ts` (`requestedLaunchTarget`, `routeSecondInstance`), testada em `launchMode.test.ts`; ligada em `main.ts` (`openLaunchTarget`, `handleSecondInstance`).
- **Segunda abertura com o app rodando** (`second-instance`): Recorder com o editor aberto pede ao editor (`open-recorder-requested` → `NewEditorShell`) que pergunte das alterações não salvas e chame `switchToHud`; com export rodando, só traz o editor para frente. Studio com o HUD parado troca para o editor; durante uma gravação ou contagem, só mostra o HUD.
- **Identidades na barra de tarefas.** O processo usa `app.setAppUserModelId("com.yagoangelini.openscreen")` (igual ao `appId`; até a 2.4.0 era `com.etiennelescot.openscreen`, veja "Identidade do fork" abaixo). HUD, seletor de fonte e Notas usam `setAppDetails` (`applyRecorderTaskbarIdentity` em `electron/windows.ts`) com o ID `com.yagoangelini.openscreen.recorder`, o ícone `resources/recorder.ico`, `relaunchCommand` `"…Openscreen.exe" --recorder` e o nome "OpenScreen Recorder". Por isso ganham um botão próprio, e fixar o HUD rodando fixa `Openscreen.exe --recorder`. Títulos: "OpenScreen Studio" no editor, "OpenScreen Recorder" no HUD.
- **Ícone do Recorder:** o logo com uma bolinha vermelha de REC (anel branco) no canto inferior direito. Gerado por `node scripts/generate-recorder-icon.mjs` a partir de cada PNG do logo (16 a 256): `icons/icons/win/recorder.ico`, prévias em `icons/icons/recorder-png/`, e `public/openscreen-recorder.png` (ícone das janelas). O codec PNG feito à mão foi para `scripts/png-codec.mjs`, compartilhado com `generate-appx-assets.mjs`.
- **Instalador:** `nsis.shortcutName` "OpenScreen Studio" (Openscreen.exe, AUMI principal) e `build/installer.nsh` (`customInstall` / `customUnInstall`) cria "OpenScreen Recorder" no Menu Iniciar (sempre, inclusive em atualização) e na área de trabalho (só se o Studio tiver atalho lá), com `--recorder`, o `recorder.ico` e `WinShell::SetLnkAUMI` com o ID do Recorder. O desinstalador remove os dois, menos numa atualização (`--keep-shortcuts`).
- **Testes que abrem o app:** o Playwright (`gif-export`, `windows-native-checklist`) e `scripts/fork-e2e/` passam `--recorder`, porque começam no HUD.
- **O que o usuário faz depois de atualizar para a 2.4.0:** fixar de novo. **A atualização para a 2.4.0 tirou o ícone fixado da barra** (E2E da 2.4.0, D-1; o texto anterior daqui dizia que ele continuava, e estava errado): o nome do atalho mudou de "Openscreen" para "OpenScreen Studio", e o modelo do electron-builder chama `WinShell::UninstShortcut` no atalho antigo, o que desafixa. Abra o Menu Iniciar, procure "OpenScreen Studio" e "OpenScreen Recorder", botão direito → "Fixar na barra de tarefas" em cada um (o app não consegue se fixar sozinho). Ou abra o Recorder e fixe o botão dele na barra. Da 2.4.0 em diante a atualização não desafixa mais (veja "Fixados na barra sobrevivem à instalação" abaixo).

**Identidade do fork** (pedido de 11/10, branch `feat/identity`, entra na próxima versão depois da 2.4.0):

- **O que mudou.** `appId` / AUMID `com.yagoangelini.openscreen` (Studio) e `com.yagoangelini.openscreen.recorder` (Recorder); `package.json` com `author` e `maintainers` Yago Angelini (o e-mail só aí; o `maintainer` do deb/rpm sai dele), `homepage` no repo do fork, Etienne Lescot e Siddharth Vaddem em `contributors`; `copyright` "© 2026 Yago Angelini · © 2025-2026 OpenScreen contributors — MIT License" (igual em `electron/about.ts`, testado); `LICENSE` ganhou a linha "Copyright (c) 2026 Yago Angelini" sem tirar as do upstream. O Sobre mostra "OpenScreen por Yago Angelini" / "Baseado no OpenScreen de Etienne Lescot / getopenscreen" (chaves `common.about.*` nos 15 idiomas), o link do fork e o do upstream. "Star on GitHub" aponta para o fork.
- **O que ficou de propósito.** `productName` "Openscreen": ele dá o nome da pasta de dados (`%APPDATA%\Openscreen`, onde ficam projetos, configurações e a trava de instância única), da pasta de instalação e do `Openscreen.exe`. O `appId` **não** muda a pasta de dados (o Electron usa o `app.name`), então nada é migrado. O bloco `appx` é a identidade do upstream na Microsoft Store e está marcado como só do upstream: o fork não gera o pacote da Store.
- **Migração do instalador.** O electron-builder deriva o GUID do NSIS do `appId` (UUID v5 no namespace `50e065bc-…`). O do appId antigo é `5b412b41-8d8b-5faf-b557-de4fe681e5fc` (conferido: é a chave de desinstalação da 2.4.0 instalada); o do novo seria `6bb1cae6-…`, outro produto, que instalaria ao lado. Por isso `nsis.guid` está **fixado** no antigo: o instalador acha a 2.4.0, roda o desinstalador dela e instala por cima, na mesma pasta. Nunca troque esse GUID.
- **Atalhos e fixados.** Num atalho com o AUMID antigo, o ícone fixado e a janela viram dois botões. A cada instalação, `openscreenRetagShortcuts` (`build/installer.nsh`) regrava o AUMID: dos atalhos Studio do Menu Iniciar e da área de trabalho (numa atualização pelo app, com `--updated`, o modelo do electron-builder **mantém** esses atalhos sem regravar), do Recorder na área de trabalho, e de cada `.lnk` em `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar` cujo alvo é o `Openscreen.exe` instalado (argumento exatamente `--recorder` → ID do Recorder; o resto → ID do Studio). O alvo é lido por `IShellLinkW` via `System::Call`; atalhos de outros apps não são tocados. Testado num instalador NSIS de teste contra `.lnk` falsos (com aspas e espaços no caminho).
- **Riscos que ficam.** O Explorer guarda em cache os fixados: se depois de instalar o fixado e a janela aparecerem separados, reiniciar o Explorer ou sair e entrar na sessão resolve; em último caso, desafixe e fixe de novo pelo Menu Iniciar. Um fixado no **Menu Iniciar** (não na barra) pode sumir, porque o Windows 11 o guarda pelo AUMID: fixe de novo. As notificações do Windows passam a ser de um app "novo" (a permissão volta ao padrão). No macOS o bundle id muda (permissões de tela, câmera e microfone pediriam de novo), mas o fork não gera build de Mac.

**Correções do E2E da 2.4.0** (branch `fix/e2e24`; relatório D-1 a D-9 no scratchpad do agente, `e2e24/RELATORIO-E2E-2.4.0.md`). D-2 (início atrasado depois da contagem) e D-4 (aviso de câmera escura) ficaram com o branch `perf/instant-stop`, que mexe no início e na parada.

- **D-1, fixados na barra sobrevivem à instalação** (`build/installer.nsh`, "Taskbar pins survive every install"). O `WinShell::UninstShortcut` desafixa (`IStartMenuPinnedList::RemoveFromList`), e o modelo do electron-builder o chama no atalho Studio "antigo" em dois lugares:
  - no **desinstalador da versão anterior**, que toda instalação roda antes. Só a atualização feita pelo app (`--updated`) passa `--keep-shortcuts` a ele; **um `setup.exe` rodado à mão, silencioso ou não, não passa** (efeito do `allowToChangeInstallationDirectory`), e o fixado sumia **mesmo sem trocar o nome**. Foi assim no E2E (`/S` sem `--updated`);
  - no `addStartMenuLink` / `addDesktopLink`, quando o `shortcutName` muda: renomeia o atalho e chama `UninstShortcut` no nome velho (`installer.nsh:207-208` e `:230-231` do modelo).
  - Os dois leem o caminho do valor `ShortcutName` do registro (`HKCU\Software\<guid>`). `openscreenShieldPins` guarda o nome real e aponta esse valor para um atalho que nunca existe, logo antes da seção de instalação (no `customInit` quando silencioso; no `customPageAfterChangeDir`, depois da última escolha, com o assistente, para um assistente fechado antes de instalar não mexer no registro). As duas chamadas erram o alvo; os atalhos novos sobrescrevem os velhos no mesmo caminho; um atalho com nome velho é renomeado ou apagado sem `UninstShortcut` (`openscreenMoveRenamedShortcuts`); o `registryAddInstallInfo` grava o nome real de volta. A cópia em `User Pinned\TaskBar` nunca é tocada, então o fixado continua e abre o exe novo.
  - **O desinstalador desta versão em diante** também não desafixa quando é rodado por um instalador (`${isUpdated}`, que o instalador sempre passa): aponta o modelo para fora e pula os do Recorder. Só a desinstalação de verdade (Aplicativos e recursos) desafixa e apaga.
  - **Conferido:** com o `shortcutName` igual e atualização pelo app, o modelo já não desafixava (o `elseif` do rename não entra e o desinstalador recebe `--keep-shortcuts`); o furo era o setup rodado à mão. O `openscreenRetagShortcuts` só regrava o AUMID dentro dos `.lnk` (inclusive os fixados), não chama `UninstShortcut`; não dá para provar sem fixar de verdade que o Explorer não reagrupa, e os fixados reais do usuário não foram tocados. Teste: um instalador NSIS de teste (`scratchpad/e2e24fix/harness`) com o `installer.nsh` real contra uma chave de registro e `.lnk` falsos: sem instalação → nada; da 2.1.1 ("Openscreen") → nome anterior guardado e registro na blindagem; reexecução depois de uma instalação interrompida → "OpenScreen Studio"; da 2.4.0 → igual; sem `ShortcutName` mas com `InstallLocation` → "Openscreen"; rename com o novo ausente → renomeia, com o novo presente → apaga o velho. E o instalador inteiro do electron-builder (`--prepackaged`, `-WX`) compila com o arquivo; o `.exe` gerado foi apagado sem rodar.
  - **Regra:** nunca mude `nsis.shortcutName` (`launchMode.test.ts` trava "OpenScreen Studio"). Um rename agora é tratado, mas só por instaladores que já tenham este arquivo, e a primeira atualização a partir da 2.4.0 instalada ainda roda o desinstalador **da 2.4.0** (sem a blindagem dele: o setup rodado à mão ainda desafixa o "OpenScreen Recorder" fixado pelo Menu Iniciar; o Studio fica protegido pelo registro).
- **D-3, fechar o Recorder no meio do take pergunta.** "Fechar janela" na barra de tarefas, Alt+F4 e `WM_CLOSE` no HUD saíam do app sem perguntar (só o botão Sair perguntava). Agora o `close` do HUD (fora dos fechamentos do próprio app, `isForceClosing`) e o `before-quit` com o HUD vivo mostram a mesma pergunta do botão ("Parar e abrir no editor" / "Continuar gravando"), uma de cada vez (`createQuitWhileRecordingPrompt`, `electron/quitWhileRecording.ts`, testado). Sem HUD vivo, o `before-quit` continua parando e salvando. **Medido** numa instância isolada: `WM_CLOSE` no "OpenScreen Recorder" gravando → diálogo; um segundo `WM_CLOSE` não abre outro; "Continuar gravando" → o take segue; `app-quit` → mesmo diálogo; "Parar e abrir no editor" → o editor abre com o take.
- **D-5, editor travado depois de "Sim, usar a transcrição" num perfil novo.** Causa: o primeiro uso baixa o modelo (264 MB) e o download reportava **cada pedaço da rede** ao renderer (`stt:status`), cada um uma atualização do `transcriptionStore` e uma renderização do editor. **Medido** num perfil novo: sem limite, 3636 eventos, `Runtime.evaluate` até 10 s (8 de 13 amostras acima de 1 s, o editor parado); com `throttledProgress` (`electron/stt/index.ts`, no máximo um a cada 250 ms, mais o primeiro e o último de cada arquivo), 75 eventos e no máximo 497 ms. Por isso só acontecia no primeiro take de um perfil.
- **Cancelar a transcrição para de verdade.** O "Cancelar e usar só o cursor" chamava o `stt.cancel` direto: o `transcriptionStore` não sabia, tratava a rejeição como falha, e o helper terminava o pedaço de ~90 s em andamento. Agora o diálogo chama `useTranscriptionStore.getState().cancel(assetId)` (aborta a execução ou tira da fila, sem gravar e sem toast), e o `SttManager.cancel` para o helper quando há um pedaço em andamento (`chunksInFlight`) e não tenta de novo um pedaço cancelado; a próxima transcrição sobe o helper de novo. **Medido:** cancelamento 400 ms depois do primeiro pedaço começar → rejeitado em 141 ms, `[stt] cancel: stopping the helper mid-chunk`; a transcrição seguinte (437 s de TTS) sobe o helper numa porta nova e termina normal (5 pedaços, vulkan).
- **D-6, datas e números no idioma da UI.** `src/i18n/format.ts` (`formatDateTime`, `formatDate`, `formatTime`, `formatDecimal`) com o locale do i18n (`currentLocale()` em `toastText.ts` fora do React, `useI18n().locale` dentro): nome do projeto ("Gravação 12/10/2026, 01:20:11", conferido na instância), lista de projetos, histórico do chat, chips de silêncio ("[silêncio 1,3 s]"), duração escondida pelo corte, sliders, velocidade da transcrição, gravação de áudio. O nome sugerido do export (`exportBaseName`, `src/lib/exportFileName.ts`) troca só o que o Windows recusa (`< > : " / \ | ? *` e controles, nomes reservados): "Gravação 11-10-2026, 23-27-06.mp4". Os timecodes (`0:01.3`) ficaram com ponto.
- **D-7, atalhos do próprio OpenScreen fora das plaquinhas.** `appShortcutCombos` / `bindingCombo` (`keystrokes.ts`): os cinco atalhos globais padrão (F7, F8, F9, F10, F12 com Ctrl+Shift) e os que o usuário configurou (`electron/activeShortcuts.ts`, preenchido pelo `globalShortcut.ts`) saem na importação; os padrões também saem na hora de desenhar, para takes importados antes.
- **D-8, o painel do trecho da câmera não volta mais ao topo.** A primeira mudança de aparência num trecho implícito o grava com outra chave; até a seleção seguir, o `SelectionPane` não achava o trecho, não desenhava nada e voltava como um painel novo, rolado para cima. `findSelectedCameraPiece` (`cameraSegments.ts`) mostra o trecho que começa no mesmo lugar nesse meio-tempo. **Medido:** antes, o rolador era trocado (outro elemento, `scrollTop` 0) nessa primeira mudança; depois, o mesmo elemento e o mesmo `scrollTop` (455) em todas.
- **D-9, áudio 0,30 s mais curto num take de 12 s: não investigado a fundo.** Uma ocorrência em cinco takes (os outros com até 28 ms). Está no caminho da parada (mixer com colchão de 100 ms e o fim do AAC), que o branch `perf/instant-stop` está mudando; vale repetir takes curtos depois que ele entrar.

**Itens abertos do E2E da 2.2.0** (relatório B-7 e B-10):

- **B-10, desfoque na prévia parada dentro de um trim.** Com o playhead num trim, a prévia mostra o quadro removido de verdade (`resolveNativePosition`), mas uma região que atravessava o trim só chegava ao nativo pelos pedaços mantidos. Agora `projectRegionsToSource` (`timelineMap.ts`) emite também cada trecho removido, `underTrim` e endereçado ao mesmo segmento do playhead, como já fazia para uma região inteira debaixo do corte. Vale para desfoque, texto, zoom e Câmera cheia; a velocidade continua fora (`speedRegions` filtra `underTrim`). O export não muda: ele nunca compõe esses quadros.
- **B-7, menus na gravação de janela: sem correção de código, limite documentado.** O `IncludeSecondaryWindows` só desenha um popup quando entre ele e a janela gravada, na ordem z, há apenas outras janelas "secundárias" (`WS_POPUP` / `WS_EX_TOOLWINDOW`) que a cruzam (doc da Microsoft e #910 do upstream). O menu do WinForms (`ToolStripDropDown`) é sempre visível; a janela gravada, em geral, não. Então qualquer janela sempre visível que cruze a janela gravada fica no meio e tira o menu, e **o HUD do próprio OpenScreen é uma delas**: sempre visível, 904×698 no pé da tela principal.
  - **Medido no 26100** (janela WinForms própria, take pelo HUD de uma instância isolada, `scratchpad/b7`): janela comum cruzando o HUD → menu em 0 quadros, 2 de 2 takes, com a proteção de conteúdo ligada (o uso normal); continuou 0 com `WS_POPUP` forçado no HUD (o HUD é de outro processo e não conta como "secundária" da janela). A mesma janela `TopMost` (acima do HUD) → menu em ~60% dos quadros, o tempo em que ficou aberto. Com o HUD escondido e nada por cima, um take ainda saiu sem o menu: há outro fator que não isolei.
  - **Por que não corrigi:** compor os popups à mão (uma sessão WGC por popup, ou recortar o monitor na região da janela) é grande e arriscado; mudar o HUD (sair do topo, encolher a janela, ser `WS_EX_TOOLWINDOW`) muda o gravador na barra de tarefas pedido na 2.1.1 e não resolve as outras janelas por cima. Um aviso por "janela sempre visível" chegou a ser feito e foi **desfeito**: a medição pelo app mostrou o contrário (a janela `TopMost` é justamente a que mantém o menu).
  - **Na prática:** para mostrar menus e listas suspensas, grave a **tela**. Na gravação de janela, os menus só aparecem com a janela livre do HUD e de qualquer outra janela por cima.

**Fase 4 da trilha da câmera** (PR yagoangelini/openscreen#17): a fase 4 da trilha da câmera e a recuperação de um take salvo ao sair.

- **Rosto / Tela + câmera no HUD.** Um botão ao lado da câmera (só no Windows, só com a câmera ligada) e o atalho global **Ctrl+Shift+F7** (`cameraLayoutToggle`, configurável). A captura não muda: tela e câmera são sempre gravadas.
  - Antes do take, a escolha é a pref `cameraLayout` ("screen" ou "face"), de onde o próximo take começa. Durante o take, o main registra cada troca no relógio dos marcadores: ms desde o primeiro quadro, sem as pausas, parado durante a pausa. Uma troca durante a contagem muda o começo do take e a pref.
  - As trocas durante o take **não** mudam a pref: o próximo take começa de novo no que estava escolhido antes (para quem sempre abre com o rosto).
  - O sidecar `<take>.mp4.layout.json` é reescrito a cada troca e no fim, então um take recuperado depois de um crash também volta com o rosto. Sem câmera no fim do take, o arquivo é apagado.
  - Na importação vira `asset.cameraLayout` e, depois da duração medida, pedaços "Tela cheia" (origin `system`) numa escrita desfazível (`applyFreshRecordingCameraLayout`). O auto-zoom do take espera esses pedaços e não planeja zoom dentro de um trecho de câmera cheia, nem logo depois dele (fica aberto por `minWideSec`); vale também para o replanejamento pela transcrição.
  - **Duração medida tarde** (branch `fix/camera-layout-import`). O passe esperava a duração por 60 s e então desistia de vez, liberando o auto-zoom. No take `recording-1791836816491` (12/10, 2.5.0) a prévia só informou os 51,392 s uns 12 min depois do import (o `.bak` do projeto é o primeiro estado com clipe e ainda sem as dimensões `video`): o projeto ficou com `cameraLayout` e `cameraSegments: []`, e os 2 zooms foram planejados por cima do rosto. Agora, passado o minuto, o take continua pendente (com o id do projeto) e o auto-zoom continua esperando; o `runLoadedMetadataWrite` chama `resumeFreshRecordingCameraLayout` antes de pedir os zooms. Teste com o sidecar real em `recordingImport.test.ts`. **Não explicado:** por que a prévia demorou tanto a medir esse take. Também não cobre um editor reaberto em outra janela (o pendente fica na memória do renderer).
  - Um trecho de câmera cheia que abre ou fecha o vídeo não tem rampa daquele lado (`holdAtProgrammeEdges` em `sceneDescription.ts`, e a prévia web no começo): o take que começa no rosto mostra o rosto já no primeiro quadro.
  - **Medido** (instância isolada, take real de 13,3 s, export 1080p60 pela CLI, fração de pixels pretos com a câmera tampada): 100 % do quadro 0 até 6,5 s (rosto), rampa de saída 6,5–7,8 s terminando na troca registrada em 7816 ms, PiP (2,5 %, a caixa da câmera) de 7,8 a 9,9 s, rosto curto de 9886 a 10 300 ms (a troca feita com o take pausado ficou no ms da pausa), PiP até o fim. Troca pelo mouse real (SetCursorPos/mouse_event no HUD click-through) e pelo atalho (keybd_event).
- **Take salvo ao sair ou num crash é oferecido de novo.** O diário `.pending-takes.json` era apagado quando o editor *pedia* o take; se o app morresse antes de o projeto ser salvo (por exemplo o editor aberto pelo stop que o main faz quando o HUD morre, e o resto do app morto em seguida), o take ficava salvo e nunca mais era oferecido. Agora ele sai do diário só quando o take está num projeto salvo (`settlePendingTakeHandOff`, no `set-current-recording-session(null)` da importação) ou quando o `record` da CLI termina. Um take reaberto pela oferta sem `.session.json` (crash) ganha o manifesto antes de abrir, e o editor liga a câmera dele (antes voltava só a tela).
  - **Verificado:** sair pelo `app.quit` (o Sair da bandeja) no meio do take → ao abrir de novo, a janela "Recover recording" → "Open in editor" abre o take com câmera e o pedaço de rosto. Matar o processo main no meio do take → idem, com a câmera e o cursor do checkpoint. O log do main agora diz `[recovery] offering a take` e `[recovery] answer`.

**Parada instantânea e início no fim da contagem** (pedido de 12/10 e D-2/D-4 do E2E da 2.4.0):

- **O que já era instantâneo, medido:** o take termina no clique (o último quadro do arquivo fica de −59 a +3 ms do clique, medido com o quadrado de `record-take.mjs --marker`; o áudio passa do vídeo 10–40 ms) e o HUD mostra "Salvando…" em 4–18 ms. O que demorava era o editor.
- **Parada (Windows):**
  - O `wgc-capture` imprime `{"event":"outputs-closed"}` depois do último Finalize (tela, stems e câmera) e finaliza os stems numa thread ao lado da tela. O main (`waitForNativeWindowsCaptureStop`, `readOutputsClosed`) fecha a parada nessa linha, sem esperar o WGC fechar e o processo sair (100–450 ms por parada); `reapNativeWindowsCapture` espera o resto em segundo plano (mata depois de 12 s) e o próximo take espera esse fim (`nativeWindowsHelperExit`). Log: `[native-wgc] helper gone after the hand-off`.
  - O leitor do cursor para junto com o comando de parar (não depois do helper), e os sidecars são gravados em paralelo, em duas rodadas.
  - **Editor pré-aberto:** o IPC de parar manda o `stop` primeiro e então cria o editor escondido (`prewarmEditorWindow` em `main.ts`, `createEditorWindow(…, { deferShow })` e `revealEditorWindow` em `windows.ts`). O `switch-to-editor` do HUD mostra essa janela já carregada. `get-current-recording-session` espera a parada em andamento, e só o main entrega o take (o HUD não chama mais `setCurrentRecordingSession`, que podia chegar depois da importação e oferecer o take duas vezes). Parada que falha fecha o editor escondido; um que ninguém pede some em 30 s.
  - **Medido** (instância isolada, tela + mic + som, sem câmera, 5 takes de cada lado, intercalados): navegação do editor 718–1123 ms → 172–313 ms depois do clique; prévia pronta 1393–2316 ms → 929–1827 ms. Log por take: `[native-wgc] capture stopped` com `stopTiming` (passos do helper) e `mainStopTiming` (passos do main).
- **Início (D-2):** o renderer começa as checagens (disco, microfone, helper disponível) no clique, lê a fonte uma vez só (cada `getSelectedSource` enumera as fontes, ~0,4 s) e pede o take no instante em que a contagem começa. Pedido do take: 0,9–2,1 s → 0,5–0,9 s depois do clique, ou seja 3,0 s antes do fim da contagem em vez de 1,8–2,5 s. Se mesmo assim o helper não abrir tudo a tempo (encoder NVENC levou 4–9 s com a CPU a 100 %), **a contagem fica no último número até o take começar**, para ninguém falar antes do primeiro quadro (a janela da contagem tem proteção de conteúdo). Log: `rendererStartTiming` e `requestedBeforeCountdownEndMs` no `[native-wgc] capture started`; `afterCountdownMs` passou a ser medido contra o fim pedido.
  - **Medido** (contagem 3 s, sem câmera): `afterCountdownMs` 47, 145, 154, 382 com carga normal; 1498–6896 com a CPU a 100 % (outras compilações na máquina), agora com a contagem segurada. **Com câmera não foi medido** (a câmera estava em uso por outro teste).
- **Câmera escura (D-4):** quando a câmera não entregou nenhum quadro antes do take (a C920 pode levar mais de 1 s), o helper julga o primeiro segundo de quadros do take e emite `webcam-dark` se nenhum tiver imagem. O main repassa ao HUD (`native-recording-camera-dark` → `onNativeRecordingCameraDark` → toast `recording.cameraDark`). **Não verificado com a lente tampada** pelo mesmo motivo.

**Tempo da gravação: início, parada, Rosto/Tela e primeiro quadro** (pedido de 13/10, branch `fix/rec-timing`). Medido numa instância isolada, só a tela do notebook (Intel, encoder `VEN_8086`; o monitor da RTX estava desligado), C920 ligada, take de 4 a 6 s, com outras sessões compilando na máquina (CPU de 60 a 100 %). Ferramenta: uma faixa de código de barras com o relógio no canto da tela, lida quadro a quadro em cada take, mais o `firstFrameEpochMs` do helper.

- **1. Atraso no início.**
  - **Causa:** o helper abre tudo durante a contagem, e no Intel isso levou mais que os 3 s. Os encoders da tela e da câmera abriam um depois do outro: `encoders-ready` 3,0 a 6,7 s depois do spawn. O spawn ainda custa 0,3 a 1,9 s. A contagem ficava parada no "1".
  - **Antes:** primeiro quadro 3,6 s depois do fim da contagem, com contagem de 3 s. Com 5 s: +25 ms numa medida e +4,8 s noutra.
  - **Correções:**
    - o encoder da câmera abre numa thread ao lado do da tela (`main.cpp`; o da câmera não usa o device D3D);
    - **contagem padrão de 5 s** (`app-settings.ts`, `handlers.ts`, `RecStage.tsx`, `useScreenRecorder.ts`). Uma escolha salva (0, 3 ou 5) continua valendo;
    - o último número da contagem sai no fim exato da contagem, e não 150 ms antes. A janela da contagem tem proteção de conteúdo, então nunca entra no take.
  - **Depois:** os encoders ficam prontos em 1,9 a 2,5 s.
    - Com 5 s, o primeiro quadro vem +14, +19 e +22 ms depois do fim (pelo código de barras, −4 ms), e +586 ms com a CPU a 90 %.
    - Com 3 s: +14 e +38 ms, mas +19,5 s numa medida com a máquina sobrecarregada. Por isso o padrão ficou 5 s.
    - O HUD mostra a gravação 116 a 136 ms depois do fim da contagem.
- **2. O clique de parar entrava no take.**
  - **Evidência:** o take citado (`recording-1791836816491`) não existe mais em `Vídeos\OpenScreen`; só o projeto ficou. No take mais novo da pasta (`recording-1791859616407`), o cursor tem um clique em 4475 ms (soltura em 4579 ms) no centro de baixo da tela, onde fica o HUD, e o vídeo vai até 5275 ms.
  - **O que o espectador via:**
    - o anel do clique (o projeto tinha `cursorClickRing` ligado);
    - o som de clique, se ligado;
    - o zoom automático mirando um botão invisível;
    - os quadros entre o aperto e a soltura (80 a 104 ms nos cliques do usuário);
    - o que o helper e o mixer escrevem depois do comando.
  - **Medido antes:** com clique injetado, o vídeo terminava de +44 a +202 ms depois do clique e as stems ~100 ms depois do comando.
  - **O que fica:** o ponteiro indo até o HUD. É conteúdo real, e cortá-lo levaria o fim da fala.
  - **Correções:**
    - Parar age no aperto (`pointerdown`, `pressHandlers` em `src/components/launch/hudPress.ts`). O horário do aperto vai junto no `stop-native-windows-recording`.
    - O main grava esse instante, em tempo de mídia, no `.session.json` (`stopAtMs`). A importação lê como `asset.recordedEndSec`, e o primeiro clipe termina ali (`recordedClipLengthSec` em `timeline.ts`), para tela, câmera e stems. O que passa disso continua no arquivo: arrastar a borda do clipe traz de volta.
    - Todo aperto no HUD durante o take é avisado ao main (`note-recording-control-press`). Os cliques correspondentes viram posições simples antes de o `.cursor.json` ser gravado (`dropControlPressClicks` em `electron/recording/takeControlPresses.ts`): sem anel, sem som, sem zoom nos botões gravar, pausar, notas, Rosto e parar.
  - **Depois:** `stopAtMs` cai a +1 ms do clique, e o clipe corta 12 a 57 ms do fim do arquivo.
  - **Não verificado:** o filtro de cliques com um mouse de verdade. O clique injetado não chega ao leitor do cursor; o filtro tem testes.
- **3. Atraso na troca Rosto/Tela.**
  - **Causas:**
    - (a) o botão agia no clique (na soltura);
    - (b) o relógio de mídia do main começava quando o main ouvia falar do primeiro quadro, 175 a 205 ms depois dele, e por isso a troca era registrada 175 a 205 ms **antes** do clique;
    - (c) a troca virava uma rampa: Tela→Rosto só completava 598 ms depois do aperto (metade em +164 ms), e Rosto→Tela começava a sair 586 ms antes do aperto;
    - (d) o ícone do HUD esperava a resposta do IPC (22 a 26 ms).
  - **Correções:**
    - o botão age no aperto e manda o horário;
    - a origem do relógio é o `firstFrameEpochMs` do helper (`mediaClockOriginMs`), o que corrige também os marcadores;
    - a borda de um pedaço de câmera cheia que cai numa troca gravada é um **corte** (`recordedSwitchCuts`, `cutAtRecordedSwitches`, `withRecordedSwitchCuts`), e uma borda que o usuário arrastou volta a ter rampa;
    - o HUD troca o ícone na hora.
  - **Depois:** o `atMs` cai a +1 e 0 ms do clique. No export, a câmera cheia entra no primeiro quadro depois do aperto e sai no primeiro quadro depois do outro aperto (≤ 1 quadro, 17 ms). O HUD reage em 12 ms.
- **9. Primeiros quadros embaralhados no Rosto.**
  - **Causa:** o desfoque de movimento do compositor lê a câmera um quadro antes. No quadro 0 isso é t < 0, fora de qualquer pedaço, e o quadro 0 misturava a bolinha PiP com a câmera cheia. O arquivo da câmera já sai limpo desde o quadro 0.
  - **Correção:** `camera_fullscreen_progress_prev_at` (`regions.rs`): numa borda segurada (início do vídeo, trim, troca gravada), o quadro anterior é lido no próprio t.
  - **Medido:** export do projeto do usuário que começa no Rosto (cópia, só leitura). A diferença média do quadro 0 para o quadro 1 caiu de 47,6 para 0,00 níveis de cinza.
  - **Prévia:** usa o mesmo `frame_geometry` do addon. Não foi medida em pixels: a captura do `<canvas>` por CDP não dá o quadro composto.
- **Nativos recompilados neste branch:**
  - `wgc-capture.exe` (`npm run build:native:win`, com os testes C++ passando; `findstr` acha `screen-encoder-ready`, controle `encoder-selection`);
  - `compositor_view.node` (`npm run build:native:compositor`; 462 testes Rust).
  - O `crates/target` da worktree é junction para o da checkout principal: o `compositor_view.dll` de lá agora é o deste branch.
- **Teste C++ instável:** `mixer-streaming-source-has-no-holes` (`audio_sample_utils_test`) falhou duas vezes com a CPU a 100 % e passou na terceira. O teste é de tempo real.

**Extras de gravação** (pedido de 12/10, branch `feat/recording-extras`; todos opcionais, Windows):

- **Desenhar na tela (roadmap #277).** Botão de caneta no HUD e atalho global **Ctrl+Shift+F6** (`drawingToggle`, configurável; registrou livre na máquina do usuário, e só conflita com o "janela anterior" do Excel e do Word). Duas janelas (`electron/recordingExtras/drawingOverlay.ts`, `extrasWindows.ts`):
  - a **camada de desenho**, transparente, sempre no topo (nível `screen-saver`), sobre a tela gravada (`getRecordingDrawingTarget` em `handlers.ts`: a tela da fonte escolhida), **sem** proteção de conteúdo, então os traços entram no vídeo. `focusable: false`: nunca rouba o foco do app gravado; só recebe o mouse no modo desenho e fica click-through fora dele, mesmo enquanto os traços somem;
  - a **barra de ferramentas**, com proteção de conteúdo (fora do vídeo, como o HUD): caneta, seta, retângulo, elipse, marca-texto, 6 cores, 3 espessuras, tempo para sumir (3, 5, 10 s ou nunca), desfazer, limpar, sair. Estilo salvo em `<userData>/drawing-overlay.json`.
  - Esc sai do modo desenho, Delete limpa, Ctrl+Z desfaz: atalhos globais registrados **só** enquanto desenha. Os traços somem depois do tempo escolhido (fade de 0,6 s). Fases puras em `src/lib/drawing/overlayState.ts` (`reduceDrawing`, `drawingWindowPlan`), traços em `strokes.ts`, desenho em `src/components/recording-extras/DrawingOverlay.tsx` / `DrawingToolbar.tsx`.
  - **Gravação de janela:** o WGC grava só os pixels da janela escolhida, e a camada é outra janela (de outro processo), então os traços **não** entram no vídeo. A camada fica sobre a tela onde a janela está, e a barra mostra o aviso "Você está gravando uma janela... grave a tela". Para desenhar no vídeo, grave a tela.
  - Tudo fecha junto com o HUD (`attachRecordingExtrasToHud` em `main.ts`), então nada sobra sobre o editor nem segura o app aberto.
- **Ver a câmera ao gravar (roadmap #500).** Botão ao lado de "Rosto / Tela + câmera" (Windows, câmera ligada). Abre uma janelinha redonda (ou quadrada arredondada, botão ao passar o mouse), arrastável, com a rolagem do mouse para mudar o tamanho (120 a 480 px), sempre no topo, **com proteção de conteúdo** (nunca entra no vídeo), espelhada. Posição, tamanho, formato e se estava ligada ficam em `<userData>/self-view-window.json` (`electron/recordingExtras/selfView.ts`).
  - Entre takes ela abre a câmera sozinha (getUserMedia). No take o helper é dono da câmera: o main pede à janela que solte a câmera **antes** de criar o helper (medido: 7 ms; espera no máximo 600 ms) e abre um named pipe `\\.\pipe\openscreen-selfview-<pid>-<take>`. O helper (`webcam_preview.{h,cpp}`, `SelfViewPreviewPublisher`) lê o último quadro da câmera numa thread própria, reduz para caber em 320 px, converte para RGBA e escreve a ~15 fps (medido: 237 quadros em 19,5 s, 12 fps); o main lê (`SelfViewFrameParser` em `electron/recording/selfViewStream.ts`) e manda só o mais novo para a janela (`LatestFrameMailbox`, com ack). Os quadros só são feitos com a janela aberta (`selfview on|off` no stdin do helper). Nada disso toca no ritmo do escritor de vídeo.
- **Aviso de microfone mudo.** O helper mede o microfone cru (antes do ganho) em janelas de 250 ms e imprime `{"event":"mic-level","peakDb":…,"rmsDb":…}` (`MicLevelMeter` em `audio_sample_utils.cpp`, escrito direto no handle do stdout para não cair no meio de outra linha). O main (`MicSilenceDetector` em `electron/recording/micSilence.ts`, `micSilenceWatch.ts`) conta silêncio quando o pico fica abaixo de **−60 dBFS**: **6 s** sem nenhum sinal desde o começo (contagem incluída) ou **30 s** depois de já ter havido voz (o NVIDIA Broadcast escreve silêncio digital entre as frases). Tempo sem linhas também conta como silêncio; pausa não conta. O HUD põe um ponto vermelho no microfone e um toast "Seu microfone parece mudo", que somem quando o sinal volta ou o take acaba. Liga/desliga em Configurações de dispositivos ("Avisar se o microfone parecer mudo", pref `micSilenceWarningEnabled`, ligado). Um endpoint mudo no Windows entrega silêncio digital, então cai no mesmo aviso.
  - **Teste sem mexer no Windows:** `OPENSCREEN_WGC_TEST_SILENT_MIC=1` no ambiente da instância faz o helper entregar silêncio no lugar do microfone.
- **Pendência 19 corrigida:** o início que estoura os 12 s agora (a) só para o leitor do cursor se ainda for o dono dele (`TakeOwnership` em `electron/recording/takeOwnership.ts`, `stopCursorRecording(token)`) e (b) põe a morte do helper em `nativeWindowsHelperExit`, que o próximo take espera.
- **Medido** (instância isolada, porta 9258, tela principal 1920×1080, uma janela branca de teste por baixo da barra e da câmera, C920 tampada): traços vermelho e verde no arquivo de 3,2 a 6,0 s e sumidos em 7,5 s (sumir em 3 s); a região da barra e a da câmera saíram 100 % brancas em todos os quadros (a barra esteve na tela de 1,2 a 4,4 s e a câmera o take inteiro); o app em primeiro plano não mudou ao entrar no modo desenho, e fora dele o clique passa para o app de baixo (`WindowFromPoint`). Com o microfone em silêncio de teste, o aviso apareceu aos 4 s de take (7 s depois do clique, contagem de 3 s); com o microfone real numa sala quieta, nenhum aviso em 14 s. Início com a câmera e a janelinha aberta: `afterCountdownMs` 20.

**Transcrição pt-BR para Microsoft e IA** (pedido de 11/10: "melhore o modelo de transcrição para português, principalmente para o universo Microsoft e IA"):

- **Modelo.** Configuração "Modelo de transcrição" no painel de mídia: **Automático** (padrão), **Preciso** (`ggml-large-v3-turbo-q8_0.bin`, 874 MB) ou **Rápido** (`ggml-small-q8_0.bin`, 264 MB). O Automático pergunta ao helper as GPUs que ele vê (`whisper-stt-server --list-devices`, `electron/stt/whisperDevices.ts`) **antes** de baixar qualquer coisa: GPU dedicada com 3,5 GiB ou mais (e 1,5 GiB livres, quando o driver informa) → turbo; senão, small. O download é o de antes (SHA-256, `.partial`, revisão fixa), com progresso na janela pós-gravação, agora limitado a 5 eventos/s (eram ~4.400 mensagens IPC para o small e ~14.000 para o turbo).
- **Volta ao small sozinho** quando o turbo não roda: download falhou (offline, disco cheio), o helper não carregou (um helper antigo **morre** com o turbo: 0xC0000005, "aheads_masks_init: tried to set alignment head on text layer 6, but model only has 4"), ou, no Automático, o helper caiu na CPU (o probe `GET /` agora diz o `backend`). A escolha explícita do Preciso fica no turbo mesmo na CPU.
- **Helper (C++).** `main.cpp` ganhou `--dtw-preset` (o turbo precisa de `WHISPER_AHEADS_LARGE_V3_TURBO`; o SMALL fixo impedia de carregar), `--list-devices` e `backend`/`dtw_preset` no `GET /`. Com o small, o helper novo dá **as mesmas palavras e tempos, byte a byte**, que o antigo (conferido em dois áudios).
- **Termos de sempre** (prompt do Whisper). Preferência `transcriptionVocabulary`, editável no painel de mídia ("Termos de sempre (Microsoft e IA)", com "Restaurar a lista padrão"). O padrão está em `src/lib/ai-edition/transcription/vocabulary.ts` (`DEFAULT_VOCABULARY`: Microsoft 365, Copilot Studio, Power Automate, SharePoint, Dataverse, Entra ID, Purview, Azure OpenAI, ChatGPT, IA generativa, RAG, MCP, tenant, licença E3...). `buildTranscriptionPrompt` junta com os "nomes e termos" do projeto (os do projeto por último, mais perto do áudio), sem repetir, e corta pelo fim da lista padrão em 640 caracteres, para o "Glossary:" não sair do limite de 224 tokens do Whisper.
- **Idioma.** Com o app em português, a transcrição sai **em português** (`pt`) em vez de detectar: `effectiveTranscriptionLanguage` em `userPreferences.ts`, usado pela fila de fundo, pela janela pós-gravação e pelo seletor do painel de mídia, que agora começa em Português e grava a escolha ("Detectar" continua lá).
- **Glossário.** `DEFAULT_GLOSSARY` ganhou as grafias erradas que os dois modelos escreveram de verdade (Timoz/tims → Teams, Tenet/tênet → tenant, Andrile → OneDrive, Pervil/pervio → Purview, EJAR/Eger → Azure, Febric → Fabric, chat GPT → ChatGPT, licença e três → licença E3...). Ficaram de fora de propósito palavras que também são português: defender, ordem, cloud, a gente. Um glossário salvo que ainda é o padrão antigo (não editado) passa para o novo ao carregar (`upgradeStoredGlossary`); um editado fica como está.
- **Medido** (roteiro de tutorial M365/IA de 19 frases lido pela Maria (SAPI, 159 s) e pelo Daniel (OneCore, 121 s), mais o Daniel acelerado 1,12× com eco, filtro de banda e ruído rosa (108 s). Cada configuração passou pelo helper como o app faz, em pedaços de 90 s. WER sobre palavras minúsculas sem pontuação; "termos certos" = ocorrências dos 40 termos com a grafia exata):

  | Configuração | WER Maria | WER Daniel | WER ruidoso | Termos certos |
  |---|---|---|---|---|
  | **Antes** (small, detectar, sem termos, glossário antigo) | 8,9% | 8,6% | 10,2% | 61–63% |
  | small, pt, sem termos | 8,9% | 8,6% | 10,5% | 57–61% |
  | small, pt, termos de sempre | 3,8% | 3,5% | 6,7% | 78–90% |
  | **small, pt, termos + glossário novo** | 3,2% | 3,5% | 5,1% | 90–94% |
  | turbo q8, pt, sem termos | 5,1% | 3,8% | 4,8% | 73–80% |
  | turbo q8, pt, termos de sempre | 4,1% | 3,2% | 3,8% | 82–84% |
  | **turbo q8, pt, termos + glossário novo** (novo padrão na RTX) | 3,5% | 2,9% | 3,2% | 86–88% |
  | turbo q5, pt, termos + glossário novo | 3,5% | 2,2% | 2,9% | 86–90% |

  - O "Glossary:" em inglês ganhou do "Glossário:" (small ruidoso 6,7% contra 7,3%; turbo Daniel 2,5% contra 2,9%) e ficou como está.
  - Os erros que sobram são quase todos da voz sintética: "Azure AI Foundry" lido como "Azure iPhone 3", "IA" como "aí a", "Claude" como "Cloud", "E3" como "I3" (turbo).
  - **Take real** (`recording-1791731439127.voice.m4a`, 34 s, só lido): o small escreve "eu posso **volar** essa tela" e "arquivo, ar-seção e inativas"; o turbo q5, "**acumular**"; o **turbo q8 escreve "rolar" e "arquivar seções inativas"**, com e sem termos. Os termos não inseriram nenhuma palavra que não foi dita. Por isso o padrão é o q8, não o q5 (300 MB menor).
  - **Tempo das palavras** (DTW, contra as marcas de palavra do SAPI na voz da Maria): small com mediana de 16–17 ms e p90 ~150 ms; turbo com mediana de 26–28 ms e p90 190–260 ms. Um pouco pior, e ainda bem abaixo do que o auto-zoom pela fala (`speechCues.ts`) precisa.
  - **Velocidade na RTX 3060 (Vulkan)**, rtf = tempo/áudio: no banco de teste, small 0,03–0,05 e turbo 0,035–0,06; no app (prévia aberta na mesma GPU), turbo 0,04–0,08 (13–25× o tempo real) e small 0,04. Carregar: small 3 s, turbo ~11 s na primeira vez. VRAM: small ~0,7 GB, turbo ~1,4 GB. Na CPU (i7-11800H, 8 threads, take de 34 s): small rtf 3,8 e turbo 1,3, os dois lentos; sem GPU o Automático fica no small pelo download menor.
  - **No app** (instância isolada, porta 9252): um vídeo com o áudio TTS entregue como take → "Usar a transcrição" → `[stt] model "auto" -> large-v3-turbo (NVIDIA GeForce RTX 3060 Laptop GPU, 5.9 GB)`, `dtw_preset=large-v3-turbo`, Vulkan, 107,6 s em 8,5 s, transcrição em `pt` com tenant e Purview já corrigidos. Trocar para o Rápido baixou o small (264 MB) com progresso e recarregou o helper.
- **Helper novo:** o `whisper-stt-server.exe` com `--list-devices` e `--dtw-preset` já está no `electron/native/bin/win32-x64` da checkout principal (copiado em 12/10; o antigo não carrega o turbo). Confira com `findstr /M /C:"list-devices"` (controle: `/C:"guardrail"`). Ele foi compilado sem o SDK do Vulkan e usa as DLLs Vulkan da pasta; o build completo é `npm run build:whisper-binaries` numa máquina com o SDK.

**Ferramentas da transcrição** (branch `feat/transcript-tools`, pedido de 12/10: "Limpar fala", "Quem está falando", palavras sensíveis próprias):

- **Limpar fala** (botão de varinha no cabeçalho da Transcrição, só na trilha da gravação). Sem IA: lê a transcrição e monta uma lista para revisar, tudo marcado, cada item desmarcável, com o total de cortes e de segundos a menos. "Cortar N" grava **uma** escrita desfazível (`handleApplySpeechCleanup`, linha no `documentWriteAudit`), que replaneja dentro da fila de escrita e corta só os itens que ainda existem.
  - **Hesitações** ("né", "éé", "ãã", "ahn", "hum", "humm", "hmm", "hm", "uhm"): sempre cortadas, como palavra inteira.
  - **Muletas que também são palavras** ("tipo", "então", "então assim", "quer dizer", "sabe"): só quando **isoladas** (pausa dos dois lados: 0,3 s ou mais, ou 0,12 s ou mais depois de pontuação que o Whisper escreveu; a borda do clipe conta como pausa) ou **repetidas** ("então, então vamos": corta todas menos a última). "Um tipo de coluna" e "então a gente abre" ficam. O interruptor "Cortar essas palavras em qualquer lugar" corta sempre.
  - **Silêncios** acima de 0,8 s entre duas palavras mantidas viram 0,3 s (metade de cada lado), em vez de sumir. Uma muleta numa pausa leva a pausa junto pela mesma regra. Silêncio antes da primeira e depois da última palavra do clipe fica.
  - **Nunca** corta dentro de uma palavra (todo corte fica entre o fim de uma palavra mantida e o começo da próxima), num trecho que já tem trim (nem fora do centro) nem uma palavra inserida. Funciona por clipe (o trim leva o `clipId`; clipes duplicados ganham cortes próprios) e passa por `mergeCloseCuts`.
  - Comparação por palavra inteira, sem maiúsculas e pontuação, "ééé"/"hummm" iguais a "éé"/"humm"; os acentos contam ("e" e "é" são palavras).
  - Listas e regras em "Palavras e regras", dentro do próprio painel, salvas nas preferências (`speechFillers`, `speechContextualFillers`, `speechCleanupAggressive`, `speechSilenceMinSec`, `speechSilenceKeepSec`), com "Restaurar o padrão".
- **Quem está falando.** Num take com stems de voz e computador, cada palavra e segmento ganha `speaker` ("mic" = Você, "system" = Convidado; campo opcional no schema, sem subir a versão). É o RMS do envelope de picos de cada stem (`getAudioPeaks`, o mesmo cache `.f32` da forma de onda) sobre o tempo da palavra, cada stem dividido pelo próprio nível de fala (percentil 95, no mínimo 0,02): o lado mais alto por 3 dB ganha; empate ou silêncio herda da palavra anterior do segmento, ou da mais próxima decidida. Roda sozinho depois de cada transcrição (`transcriptionStore`) e pelo botão "Quem fala" (escrita desfazível `handleLabelSpeakers`).
  - Por padrão, um take com stems continua transcrito **só pela voz**, então o convidado nem entra na transcrição. A opção "Transcrever também o som do computador (convidado)" no painel de mídia (`transcribeGuestAudio`) transcreve a trilha mista.
  - Na transcrição, um rótulo "Você" / "Convidado" a cada troca (só quando os dois lados falam). Nas legendas, "Mostrar quem fala" (em Legendas, só com dois falantes) quebra a linha na troca e põe "[Nome] " na prévia, no export e no `.srt`; os nomes são editáveis e ficam no documento.
  - **Limite:** duas pessoas no mesmo microfone são um falante só (os stems separam dispositivos, não vozes). Convidado no alto-falante vaza no microfone; funciona enquanto a chamada for mais alta no stem dela do que o eco no mic.
- **Palavras sensíveis próprias.** "Minhas palavras sensíveis" no painel de mídia, embaixo do desfoque automático (`autoRedactTerms`, uma por linha, mínimo 3 caracteres). O OCR casa sem maiúsculas e acentos, também dentro de uma palavra ("fabrikam" em "fabrikam-interno") e entre palavras ("João Silva"); a caixa é a da palavra OCR inteira. Os detectores de sempre vêm antes: um termo dentro de um e-mail sai com o e-mail. "Procurar de novo" (`rescanAutoRedactions` em `recordingImport.ts`) roda o OCR de novo nas gravações da timeline e troca os desfoques automáticos (`annotationSource` auto-redact) pelos novos, mantendo os do usuário, numa escrita desfazível. Só lê takes da pasta de gravações (a regra do `scan-recording-text`).
- **Verificado** numa instância isolada (porta 9255, perfil e pasta de gravações temporários): take sintético de 37 s (voz da Maria com "né", "Tipo." isolado, "Então, então" e pausas de 0,6 a 2,8 s no stem de voz; a mesma voz com o tom 18% mais baixo no stem do sistema, e 6% dela vazando no mic) entregue pelo `set-current-recording-session`. Na importação, 4 desfoques: o e-mail (padrão), "Fabrikam", "Joao Silva" (termo "João Silva") e "4021-7788" (termo "4021"). Transcrição pelo small na trilha mista: as 13 palavras do convidado saíram "system" e as 43 da voz, "mic". Limpar fala listou 6 itens ("Tipo," entre pausas e 5 silêncios, 8,7 s); com um desmarcado, 5 trims numa escrita, e um Ctrl+Z tirou os 5. "Procurar de novo" com os termos trocados substituiu os 4 desfoques por 3. Legenda na prévia: "[Convidado] Oi, obrigado pelo convite."

**Correções do E2E da 2.5.0** (branch `fix/e2e25`; relatório E-1 a E-7 no scratchpad do agente, `e2e25/RELATORIO-E2E-2.5.0.md`). E-4 (certificado autoassinado e o `publisherName` do atualizador) e E-6 (chunks velhos do main no `app.asar`) são do build e ficaram com o usuário; E-7 é só desempenho.

- **E-1, "Inclinar para o clique" e o impacto de clique com desfoque.** `click_lean_at` e `click_impact_at` (`frame_geometry.rs`) desligavam tudo enquanto **qualquer** desfoque estava visível, como margem de segurança. Os desfoques automáticos cobrem o clipe inteiro, então num take com e-mail na tela a inclinação nunca rodava. A margem não comprava nada: o `privacy_mask` já desenha cada máscara pelo mesmo quad do `screen_tilt` (parte dinâmica inclusa, e a trilha do desfoque de movimento) e o recuo da tela reta só mexe no `s_dst`, onde a máscara reta é medida. A porta saiu. Testes: `the_screen_leans_under_a_blur_and_the_mask_leans_with_it` (a inclinação com um desfoque do clipe inteiro é a mesma de sem desfoque, e os quatro cantos da máscara ficam a menos de 3,5 px dos cantos do conteúdo inclinado, sempre por fora) e `every_gate_cancels_the_click_impact` (o desfoque visível deixou de ser porta, inclinado e reto). **Medido** em exports pela CLI de um vídeo sintético (testsrc2 com um retângulo de ruído no lugar do "segredo" e um desfoque automático do clipe inteiro por cima, cliques em 3 s e 8 s): inclinação × sem inclinação, com o desfoque, 0 antes do clique, até 4,45/255 de 3,1 a 4,6 s e de 8,1 a 9,6 s, 0,14 (ruído do encoder) no resto; os ladrilhos de 8 px do ruído inclinado (56 a 109 por quadro, 167 deles fora do lugar de repouso) ficam todos desfocados no export com desfoque (nitidez máxima 2,2 a 3,3 contra 83 a 90 sem desfoque, 0 ladrilhos nítidos) em 1,0 / 3,5 / 3,8 / 8,6 s.
- **E-2, legendas e `.srt` sem as palavras cortadas.** `deriveCaptionCues` (`captions/cues.ts`) montava as linhas antes do corte; um corte do Limpar fala no **meio** de uma linha deixava o "né?" no texto. Agora `captionFilm` tira das linhas, antes de agrupar, toda palavra que a edição cortou, pela mesma regra do painel da transcrição (`buildClipSection`: o centro da palavra, no tempo bruto da régua, fora de `removedRawSpans`; vale para qualquer trim e para o vão entre clipes), e mede a pausa que quebra a linha como ela toca, sem o corte (`groupTimedCaptionWordsIntoLines` ganhou o `gapSec`), então a linha fecha em volta do buraco e é retemporizada. Uma unidade **traduzida** fica inteira (a tradução não tem tempo por palavra); sem tradução, as palavras originais passam pelo filtro. Testes em `captions.test.ts` e `srt.test.ts`. **Medido:** o `.srt` do mesmo projeto ("Pessoal, né? hoje vamos ver…" com o "né?" cortado) saía "Pessoal, né? hoje vamos ver" com o código da 2.5.0 e sai "Pessoal, hoje vamos ver" (0,500 → 2,350) agora; o export pela CLI mostra "Pessoal, hoje vamos ver", "o Copilot Studio." e "o próximo passo." queimados, 9,65 s de 12 s.
- **E-3, Cancelar durante o download do modelo para o download.** O `ensureModels` do `load()` não recebia sinal, e o `transcribe()` lia o `cancelEpoch` **depois** do `init()`, então um cancelamento durante o download ou a carga já estava contado e a execução seguia. Agora `ensureModels` aceita `signal` (aborta o arquivo em andamento, cujo `.partial` o `ensureFile` já apaga, e não começa o próximo), o `SttManager` guarda o download (`modelDownload`) e o `cancel()` aborta; um download abortado não cai para o small (que baixaria o outro modelo), não sobe o helper, e o `init` rejeitado não fica em cache. O `transcribe()` lê o epoch antes do `init()` e confere depois. Um modelo que terminou de baixar fica no disco; um helper que terminou de carregar fica quente para a próxima. **O download não é retomável:** o `.partial` some no cancelamento e a próxima tentativa começa do zero. Testes em `electron/stt/index.test.ts` ("cancel during setup") e `modelManager.test.ts`.
- **E-5, a pergunta "Gravação em andamento" fecha quando o take acaba por outro caminho.** `createQuitWhileRecordingPrompt` ganhou `dismiss()`: o `ask` recebe um `AbortSignal` que vai no `showMessageBox` (o Electron fecha o diálogo como se fosse cancelado), e o `main.ts` chama `dismiss()` quando o renderer diz que a gravação parou. Um "Parar e abrir" que corre com o dismiss não para nada. No macOS o `signal` não fecha um diálogo sem janela dona (limite do Electron). Testes em `quitWhileRecording.test.ts`. **Não medido** numa instância real.

**Auto-zoom diretor** (pedido de 12/10, branch `feat/autozoom-director`). O motivo: num take real de 51 s, o auto-zoom deu 2 zooms. O usuário abria os menus do Edge passando o mouse, sem clicar, e o algoritmo perdeu tudo isso. Um dos zooms ainda caiu no botão do HUD, que é invisível no vídeo.

- **Por que o planner antigo errava:**
  - o menu alto do Edge (72 % da altura) não cabia num zoom, e o plano inteiro era descartado;
  - um ponteiro parado não contava, nem com um submenu abrindo embaixo dele;
  - o clique em "Exibir aplicativos" fechava o menu, contava como navegação e era descartado;
  - o clique no HUD (Rosto) virava zoom;
  - os pedaços "Tela cheia" não chegaram ao documento, então o trecho só de câmera não estava reservado.
- **O pipeline novo** (`timeline/zoom-director.ts`, sinais em `zoom-signals.ts`, a fachada continua em `zoom-suggestions.ts`). São quatro passos.
  1. **Beats.** Cada momento em que o espectador deve olhar para um lugar vira um beat, com a caixa que precisa aparecer e a escala que ele merece.
     - Um clique vira dois beats: o que foi apertado, e o que ele abriu (popup do UIA ou mudança nos quadros). Assim a câmera pode ir do item clicado ao diálogo que abriu no meio da tela.
     - Um ponteiro parado (`rests`, separado nos cliques) só vale com evidência: um menu abrindo por hover, estar dentro de um menu aberto, a tela respondendo perto do ponteiro (destaque, tooltip, menu web), a mãozinha, ou uma palavra de apontar.
     - Também viram beats as varreduras lentas (as longas, em trechos) e a digitação.
  2. **Planos.** Programação dinâmica sobre os beats.
     - Cada plano é o enquadramento que mostra todos os seus beats.
     - O custo é o que cada beat perde por aparecer menor do que merece, mais `MOVE_COST` por movimento de câmera.
     - Um plano curto paga um custo de ritmo (`CALM_SHOT_MS`, `PACE_FACTOR`).
     - Uma sequência que nenhum enquadramento segura pode virar um plano que **segue o ponteiro** (`FOLLOW_SCALE`, `FOLLOW_COST`).
     - Alvo pequeno de tamanho conhecido chega mais perto (×4/3 do máximo, teto 2,2). Clique sem alvo conhecido fica no máximo das configurações.
  3. **Tempo.**
     - O zoom chega antes da ação: na aproximação da mão, ou na palavra que a anuncia.
     - Ele segura enquanto o usuário age e fala.
     - Ele sai depois de uma cauda, quando o ponteiro sai do quadro, quando o item do menu é escolhido, ou logo depois de uma navegação.
  4. **Câmera.** Entre planos próximos, a câmera faz pan com zoom: a escala muda no caminho, e não há zoom out e zoom in. Ela só volta à tela inteira num plano aberto de verdade (`minWideSec`). Depois de uma troca de página, mostra a página nova inteira (`OVERVIEW_MS`) antes do próximo zoom.
- **Quadros** (`electron/media/screenActivity.ts`, diff em `timeline/screenActivity.ts`):
  - O ffmpeg decodifica o take uma vez em 160×90 cinza a 8 fps, e o main guarda só as caixas que mudaram.
  - O resultado fica em cache em `userData/screen-activity`.
  - IPC `get-screen-activity`; o renderer usa `getScreenActivityForZooms` (`framePopups.ts`).
  - O import já começa o scan junto com a telemetria.
  - A troca de página é detectada por `isPageChange`: muda muito, ou muda o suficiente espalhado pela tela. A tela escurecida de um diálogo não conta, porque um popup abre junto.
  - **Medido:** 2,6–3,0 s para os 51 s (cerca de 33 s por take de 10 min), num processo filho em prioridade abaixo do normal. O planejamento leva cerca de 10 ms.
- **Seguir o ponteiro por zoom:**
  - O plano que segue sai com `follow: true` e é gravado como `focusMode: "auto"` num zoom `source: "auto"`.
  - `resolveZoomRendering` agora respeita esse modo também na câmera fixa, com a lei calma do modo.
  - Nada mudou no compositor; a paridade vem do caminho único.
  - No preview TS, o pan encadeado sai da vista de seguir, e não do ponteiro cru. Isso igualou ao `resolve_focus` do Rust (teste em `calmMotion.parity.test.ts`).
- **Respeito à timeline:**
  - Os trechos "Rosto" são lidos do `asset.cameraLayout` do take, mesmo sem os pedaços no documento. Nenhum beat entra neles, e o clique logo antes de uma troca de layout (o botão do HUD) é ignorado.
  - Os pedaços "Tela cheia" do documento continuam reservados, agora com 1 s de tela aberta em volta (`CAMERA_SPAN_WIDE_MS`), e não um plano aberto inteiro.
  - O clique de parar fica de fora até 1,5 s antes do fim (antes 1 s; o sampler segue 1,2 s depois do clique).
  - Zooms manuais nunca mudam.
- **Entradas:**
  - auto-zoom depois de gravar (`recordingImport.ts`);
  - replanejamento pela transcrição (`autoZoomReplan.ts`);
  - varinha da timeline (`V4Timeline.tsx`);
  - `openscreen export --auto-zoom` (`CliExportRunner.tsx`).
  Todas passam o leitor de quadros. Sem ele (macOS, Linux, falha), o plano sai só do cursor e dos popups.
- **Medido no take de 12/10** (corte do diretor e pontuador fora do repo):
  - O antigo cobriu 3 de 8 momentos, com nota de enquadramento 34/100, 9,8 s de zoom no trecho Rosto, e metade do tempo com zoom mostrando nada.
  - O novo cobriu 8 de 8, com nota 99/100, 0,5 s de zoom fora do lugar (rampa) e 7 movimentos de câmera, os mesmos 7 do corte manual.
  - Sem os quadros, cobre 8 de 8, com 2,3 s fora do lugar.
  - Fixture destilada: `timeline/__fixtures__/edge-menus-take.json`, testada em `zoom-director.fixture.test.ts`.
- **Botões de ajuste:** todos estão no topo de `zoom-director.ts`, com comentário. Os principais:
  - escala: `FRAME_MARGIN`, `CLOSE_UP_FACTOR`, `SMALL_TARGET_SIDE`;
  - custos: `MOVE_COST`, `CALM_SHOT_MS`, `PACE_FACTOR`, `FOLLOW_COST`;
  - ponteiro parado: `DWELL_MIN_MS`, `DWELL_EVIDENCE`, `DWELL_QUIET_HOLD_MS`;
  - popups: `POPUP_REACH`, `WHOLE_POPUP_MIN_SCALE`;
  - troca de página: `NAVIGATION_SHARE`, `NAVIGATION_SPREAD_*`;
  - tempo: `OVERVIEW_MS`, `MAX_IDLE_HOLD_MS` e `MAX_TALKING_HOLD_MS`.

**Cursor atrasado no modo editável** (branch `fix/cursor-lag`, pedido de 12/10: "o movimento do mouse está atrasado em relação a onde o mouse realmente está"). Medido no take real `recording-1791836816491` (menu de contexto do Edge, 37–38 s, onde cada item acende sob o ponteiro de verdade) e num take de teste com uma janela de linhas que acendem sob o mouse movido por `SetCursorPos` (`hover-rig.ps1` no scratchpad do agente, `cursorlag/`):

- **Fonte 1, a suavização (quase todo o atraso).** O `CursorTrack::smoothed` (Rust, prévia e export) era uma mola: atraso de amortecimento/rigidez, **189 ms** no padrão 0,67. No export pela CLI do take real, o cursor desenhado ficou **198 ms** atrás do caminho gravado (correlação cruzada, erro 3 px contra o modelo da mola) e entrou em cada item do menu 67–167 ms depois de ele acender. Agora a suavização é **de fase zero**: uma gaussiana centrada no caminho inteiro (grade de 240 Hz, desvio de 30 ms × o controle), com as pontas de cada trecho visível seguradas e cada clique puxado de volta ao ponto bruto no instante dele (`pin_clicks`). Um ponteiro em velocidade constante sai onde está, na hora em que está; só tremor e as quinas do caminho de 30 Hz são arredondados. O padrão foi de 0,67 para **0,3** (9 ms). Mesmo export depois: **1 ms** de atraso (erro 2,5 px) e o cursor entra em cada item 17–67 ms *antes* de ele acender, como o ponteiro real (o Edge leva esse tempo para reagir). Prova: `cursorlag/proof/menu_t3_15s_src37.65.png` (Desinstalar aceso: antes o cursor ainda no item de cima, depois em cima dele) e `menu_before_after_quarter_speed.mp4`. O `cursorPathSmoothing.ts` (sem uso no app) espelha o Rust.
- **Fonte 2, o relógio do cursor.** O deslocamento entre o leitor do cursor e o 0 s do vídeo era medido na hora em que o main LIA "Recording started" (poll de 10 ms no helper, pipe, event loop): o cursor saía adiantado esse tanto. O `wgc-capture` agora calcula o instante de parede do primeiro quadro pelo timestamp WGC dele (`firstFrameEpochMs` no `recording-started`, `epochMsOfQpcHns` em `frame_slot_clock.h`), e o main usa `cursorOffsetToFirstFrameMs` (`nativeWindowsCaptureStop.ts`), com a leitura antiga só como reserva para helper velho ou valor impossível. Log: `firstFrameReadAfterMs` no `[native-wgc] capture started`. **Medido** num take de teste: 6,8 ms (mais com a CPU ocupada). Com o helper novo, o caminho gravado ficou **−2,7 ms** (mediana −2,4) do `SetCursorPos` real em 69 entradas de linha; a linha acende no vídeo 23,5 ms depois do ponteiro (a reação do WinForms e do DWM, igual na tela).
- **Fonte 3, 30 Hz.** A interpolação já era linear (sem segurar amostra), então não atrasava, mas cortava um gesto rápido em retas de 33 ms. O `cursor-sampler` agora faz 4 ticks por amostra (8,25 ms, `sleep_until` em prazos) e, entre as amostras completas, escreve só a posição e só se mudou (`{"type":"move"}`). Viram o `path` opcional do sidecar (`[timeMs, cx, cy]`), que o compositor junta ao caminho desenhado (`CursorTrack::load`). As amostras continuam a 30 Hz (33 ms, antes 34) porque o auto-zoom mede velocidade entre amostras com limiares de 30 Hz (`APPROACH_REST_SPEED` 0,08/s: um pixel de tremor a 8 ms passaria dele). O `path` passa pelo checkpoint (`{"type":"path"}`), pela pausa e pelo deslocamento; sidecar antigo sem `path` carrega igual (teste). O sidecar agora é gravado sem indentação.
- **Desfoque de movimento do cursor:** a traçada vai de `t − 0,35/60` a `t` e a ponta está em `t`; o centro visual fica ~3 ms atrás. Não mudou.
- **Helpers nativos recompilados** (`build:native:win`, `build:native:compositor`). Conferir: `firstFrameEpochMs` no `wgc-capture.exe` e `subdivisions` no `cursor-sampler.exe` (controle: `encoder-selection` e `inputEvents`).

**Biblioteca de gravações, nome no fim do take e gravação que sumiu** (pedidos 5, 6 e 7 de 13/10, branch `feat/recordings-library`):

- **Uma pasta por take.** Todo take novo é gravado em `<pasta de gravações>\recording-<id>\`, com tudo dele dentro: tela, câmera, stems, sidecars e `.session.json` (`takeOutputDir` em `handlers.ts`, nos três caminhos nativos; o caminho do navegador põe `recording-<id>*.webm` na mesma pasta por `resolveRecordingOutputPath`). Os arquivos **continuam** `recording-<id>.*`: todo sidecar, o manifesto, o cache da voz melhorada e o agrupamento dos takes antigos acham uns aos outros por esse nome, e renomear só a pasta é uma operação única (tudo ou nada). Um take cancelado antes do primeiro quadro apaga a pasta vazia (`removeEmptyTakeFolder`), e a biblioteca remove as que sobrarem.
- **Nome no fim do take** (`src/lib/ai-edition/freshTakeName.ts`, `TakeNameDialog.tsx`). O editor abre no take (o editor pré-aberto) e pergunta o nome **antes de importar**: no Windows uma pasta não pode ser renomeada com um arquivo dela aberto, e da importação em diante tudo abre o take (prévia, varredura de quadros, OCR, forma de onda). Antes da importação nada está aberto (todos os escritores fecharam no `outputs-closed`; o IPC `name-fresh-take` ainda espera o helper sair, até 4 s). Vem preenchido com "Gravação 13-10-2026, 14-05-11"; Enter salva, Esc, "Manter este nome" e o X mantêm a data. O nome vira o título do projeto. Só pergunta para um take numa pasta `recording-<id>` própria; um take antigo solto ou recuperado de outro lugar entra como antes.
- **Sequência com o auto-zoom pela transcrição:** nome, depois importação, depois a pergunta do auto-zoom. A pergunta é sobre o asset importado (`freshRecordingTranscriptOffer`) e a importação espera o nome, então as duas nunca aparecem juntas (conferido no E2E: `02-autozoom-after-name.png`).
- **O que o rename atualiza** (`followMove` em `electron/ipc/recordingsLibraryHandlers.ts`): os arquivos de projeto (`DocumentService.rewriteMediaPaths`, na fila de cada projeto, no JSON cru), o `.session.json` (tem caminhos absolutos: sem isso o editor perdia a câmera), o diário `.pending-takes.json`, o registro `media-links.registry.json`, os caches de picos e de atividade da tela (`moveCachedPeaks`, `moveCachedScreenActivity`: a chave tem o caminho; mover não muda tamanho nem data) e o take na vaga de entrega. O projeto **aberto** é reescrito na memória pelo editor, com as pilhas de desfazer (`rewriteOpenProjectMedia`, `mapHistory`), senão o próximo save gravava os caminhos velhos de volta. A regra pura de caminho fica em `src/lib/mediaPathRewrite.ts` (Windows sem maiúsculas e com as duas barras), igual nos dois processos.
- **Takes antigos soltos: não migrados.** Mover sozinho reescreveria projetos que o usuário não abriu, sem ganho pedido. A biblioteca agrupa os arquivos da raiz pelo prefixo `recording-<id>` ("Take antigo"); renomear um deles cria a pasta e move só aquele take (desfeito se um arquivo não puder mover).
- **Aba Mídia** (desde `fix/media-tab`, um card por gravação junto com a mídia do projeto; ver "Aba Mídia: excluir o take aberto…" abaixo): toda gravação da pasta com miniatura e duração (um ffmpeg por take, em cache em `userData/recording-library`, `electron/media/recordingPreview.ts`), data, tamanho, e os botões Adicionar à timeline, Abrir (o projeto mais recente que usa o take, ou um projeto novo com ele), Renomear, Mostrar no Explorador e Excluir. Atualiza com um `fs.watch` recursivo da pasta (600 ms de espera) e ao voltar o foco.
- **Excluir** vai para a **Lixeira** (`shell.trashItem`): a pasta inteira, ou os arquivos do take solto. A confirmação diz o que sai, quantos arquivos, que dá para restaurar da Lixeira, e se o take está no projeto aberto ou em outros. Se a Lixeira recusar, nada é apagado de vez. A Lixeira só é chamada com o take livre (ver "Aba Mídia: excluir o take aberto…" abaixo).
- **Segurança** (`electron/recording/recordingsLibrary.ts`): o renderer só manda a chave que a listagem deu (`folder:<nome>` ou `flat:recording-<id>`), nunca um caminho. O main resolve de novo dentro da pasta de gravações: sem `..` nem barras, nada que seja link ou junction, pai real igual à pasta real. Recusa o take que está gravando (`activeTakePaths`), que ainda está no diário (finalizando, sendo entregue ou esperando recuperação) ou que tem `.cursor.ndjson` (checkpoint de crash).
- **Take do projeto aberto:** a prévia segura o arquivo aberto. Renomear ou excluir esse take primeiro solta a mídia (`withMediaReleased`: a prévia e a timeline saem da tela por um instante), faz a operação e devolve a prévia com os caminhos novos. Excluir tira o take do projeto só depois de ele ir para a Lixeira.
- **Vista que vazava** (`electron/ipc/nativeBridge.ts`): a vista do compositor de uma janela que recarrega ou fecha (o editor fecha a cada take) nunca era destruída, e segurava o take aberto até o app sair; no Windows esse take não podia mais ser renomeado nem excluído. Agora o main destrói as vistas da janela no `destroyed` e no `did-start-navigation`.
- **Gravação que sumiu** (`MissingMediaPanel.tsx`, `src/lib/ai-edition/missingMedia.ts`): ao abrir um projeto (inclusive o último, restaurado ao abrir o Studio), quando os caminhos dele mudam, ao voltar o foco e quando a pasta muda, o editor pergunta ao main (`media-files-exist`) se a tela e a câmera de cada vídeo existem. Faltando uma, o lugar da prévia mostra "A gravação deste projeto sumiu" com **Localizar…** (mesmo nome de arquivo: a pasta inteira é reapontada, câmera e stems junto), **Remover do projeto** e **Fechar o projeto**; a timeline e o Exportar somem até resolver. Os stems ficam de fora (sem eles o take só perde os volumes separados).
- **Limites:** no Windows a pasta do take aberto na prévia não pode ser movida pelo Explorador (o próprio Windows recusa), então "sumiu com o projeto aberto" só acontece com o que não está aberto (outro disco, câmera fora da tela). Renomear enquanto o OCR do desfoque automático ainda lê o take pode fazer o OCR falhar (aviso normal de varredura). O "Localizar…" não foi testado no E2E (é um diálogo nativo); a regra tem teste.
- **Verificado** numa instância isolada (perfil e pasta temporários, porta própria, só cliques injetados nas janelas da instância; `scripts/fork-e2e/library-e2e.mjs`): 13 de 13. Take A de 5 s com o nome "Aula E2E: Teams" vira a pasta "Aula E2E- Teams" com os 3 arquivos, e o projeto aponta para ela; a pergunta do auto-zoom só vem depois; renomear pela aba Mídia com o projeto aberto leva pasta, projeto e `.session.json`, e a prévia volta; recarregar o editor reabre o projeto sem painel; take B com Esc fica "Gravação 13-10-2026, 01-14-18"; excluir B pela biblioteca com A aberto manda para a Lixeira; recarregar restaura o projeto de B e mostra o painel, sem timeline; "Remover do projeto" tira o painel; excluir A com o projeto aberto manda para a Lixeira e o asset sai.

**Aba Mídia: excluir o take aberto, sem timeline, um card por gravação** (3 defeitos relatados na 2.7.0 instalada em 13/10, branch `fix/media-tab`):

- **1. Excluir o take do projeto aberto pela aba Mídia: o Windows pedia confirmação e não excluía.**
  - **Causa.** O `shell.trashItem` do Electron liga `FOFX_SHOWELEVATIONPROMPT`, que passa por cima do "sem interface" do shell. Medido numa sonda isolada (pasta temporária, arquivo segurado por outro processo):
    - quem segura o arquivo **com** compartilhamento de exclusão (FileShare.Delete: o Node, o Rust, o Media Foundation, o Explorador com a prévia, um antivírus) faz o shell mostrar "Acesso à pasta negado" (Folder Access Denied) e depois falhar com "Failed to perform delete operation";
    - quem segura **sem** esse compartilhamento (o ffmpeg do compositor, o `_wsopen` do CRT) faz falhar calado ("Operation was aborted").
    - O código antigo chamava o `trashItem` até 8 vezes seguidas: com um dono do primeiro tipo, eram 8 avisos possíveis.
  - **Quem segurava o take** (Restart Manager por arquivo, `scripts/fork-e2e/probes/holders.ps1`): na aba Editar, só o processo main (a vista do compositor: tirar o `src` dos `<video>` não muda nada). Na aba Mídia, nenhum, depois que o editor desmonta a prévia. Também leem o take, por pouco tempo, os filhos que o main lança: o ffmpeg dos picos, da atividade da tela, da miniatura e do áudio da transcrição, e o `ocr-scan.exe` do desfoque. Um `<video>` com `file://` não segura nada depois de carregar (sonda), e o `fs.watch` só segura a pasta raiz. O defeito do usuário se explica por um desses filhos ainda lendo o take recém-gravado, ou por outro programa (o Explorador aberto pelo "Mostrar no Explorador", um antivírus) segurando um arquivo com FileShare.Delete na hora do clique.
  - **Correção:**
    - O main solta o que é dele antes da Lixeira (`electron/media/takeFileHolders.ts`): cada filho que lê mídia se registra com o arquivo (`trackFileReader`, nos 6 lugares que lançam ffmpeg ou `ocr-scan`) e é encerrado, e as vistas do compositor que receberam um arquivo do take (`viewsUsing` no `CompositorViewService`, registradas no `nativeBridge`) são destruídas. Um trabalho encerrado assim falha como cancelado e não grava cache. O log diz o que foi solto (`[library] let go of the take before the bin`).
    - A Lixeira só é chamada com o take livre (`waitUntilMovable` em `recordingsLibrary.ts`): move a pasta (ou cada arquivo do take solto) para `.deleting-<hora>-<nome>` e de volta, com espera crescente (25 ms dobrando, até 800 ms, cerca de 4 s). No Windows nada com um arquivo aberto pode ser renomeado, seja qual for o compartilhamento, então o movimento que passa garante que o shell não tem do que reclamar. A pasta vai para a Lixeira com o próprio nome (restaurar a devolve igual). O nome com ponto não aparece na listagem.
    - Se o take continuar preso, a Lixeira **não é chamada**, nada sai, e o toast diz em pt-BR: "Outro programa (o Explorador, um player ou o antivírus) ainda está com esta gravação aberta. Feche-o e tente de novo: nada foi apagado." Até 3 pedidos à Lixeira, cada um depois de um novo teste de movimento.
- **2. A timeline aparecia na aba Mídia** (a faixa "Organizar clipes" e a trilha verde dos clipes: a variante `media` do `V4Timeline`). A timeline agora é só da aba Editar (`showTimeline` em `NewEditorShell.tsx`). Reordenar clipes continua em Editar. Arrastar um card da aba Mídia continua levando para a linha do tempo: enquanto se arrasta, aparece embaixo uma faixa "Solte aqui para pôr na linha do tempo" (`MediaDropZone`), que aceita um asset do projeto ou uma gravação que ainda não está nele (importa e põe na linha do tempo). O código de arrastar e redimensionar da timeline não mudou.
- **3. Gravação duplicada na aba Mídia.** Eram duas listas: os assets do projeto (gradiente, `recording-<id>.mp4`, só o tamanho da tela, abriam os detalhes) e a seção "Gravações" (nome, miniatura, todos os arquivos, sem detalhes).
  - Agora é uma lista só (`src/lib/ai-edition/mediaCards.ts`, `buildMediaCards`): um card por gravação, com o asset do projeto quando ele tem esse take (casado pelo caminho da tela), e um card para cada outra mídia importada do disco. Primeiro o que está no projeto, na ordem dele, depois as outras gravações da pasta, mais novas primeiro.
  - Card de gravação: nome da biblioteca, miniatura real, duração, data e tamanho de **todos** os arquivos do take, selo "Neste projeto", e os botões Adicionar à timeline, Abrir, Renomear, Mostrar no Explorador e Excluir.
  - Clique em qualquer card abre o painel ao lado. Gravação do projeto ou mídia importada: "Transcrição da fonte" com as configurações de sempre. Gravação fora do projeto: "Adicionar ao projeto" e "Adicionar à linha do tempo"; depois de adicionar, o painel vira o da transcrição.
  - A busca, "Importar mídia", renomear e excluir continuam. A pasta de gravações aparece numa linha em cima, com atualizar e abrir a pasta. Um card é um `div` com um botão principal (miniatura e nome) e a fileira de ações, que não pode ficar dentro de um botão.
  - **Nome do asset:** o take novo entra no projeto com o nome dado no fim do take (`recordingImport.ts`), não `recording-<id>.mp4`. Renomear pela aba Mídia troca também o rótulo do asset no projeto aberto, com as pilhas de desfazer, quando o rótulo é automático (o nome do arquivo ou o da pasta antiga; `isAutomaticLabel` em `recordingName.ts`, `relabelMovedAssets` em `recordingMedia.ts`). Um rótulo digitado pelo usuário fica. Os projetos fechados mantêm o rótulo antigo no arquivo, mas a aba Mídia mostra o nome da biblioteca. Na timeline, um projeto antigo ainda mostra `recording-<id>.mp4` até o take ser renomeado.
- **Verificado** numa instância isolada (`node scripts/fork-e2e/library-e2e.mjs --scenario media-tab --port <p> --recordings <pasta> --profile <perfil> --out <saída>`: perfil novo e pasta temporária por execução, só CDP, nenhuma entrada do sistema operacional). 14 de 14:
  - o take de 6 s com o nome "Aula Mídia E2E" mostra a aba Mídia sem timeline e um card só, com o nome e a miniatura real;
  - o clique abre os detalhes;
  - arrastar o card mostra a faixa, e soltar põe o clipe na linha do tempo (1 → 2 clipes);
  - com o arquivo segurado por outro processo com FileShare.Delete por 14 s (`probes/hold.ps1`), excluir não mostra aviso do Windows, a pasta fica e o toast explica;
  - segurado por 1,5 s, a exclusão espera, termina em 3,3 s sem aviso, e a pasta vai para a Lixeira com o próprio nome;
  - o asset sai do projeto e a aba fica vazia.
  - `probes/dialogs.ps1` procura diálogos `#32770` dos processos da instância durante toda a exclusão e fecha qualquer um que aparecer, para um teste que falha não deixar janela na tela.

**"Todos os trechos", Restaurar e histórico do desfazer** (pedidos 11 a 13 de 13/10, branch `feat/editor-resets-history`):

- **11, "Todos os trechos" só mudava o trecho atual.** Causa: no painel do trecho da câmera, o escopo "Todos os trechos" gravava só o ajuste global (`legacyEditor`), e todo trecho com aparência própria para aquele ajuste continuava com o valor dele (`mergeCameraLook`: o do trecho vence). Além disso, o escopo voltava para "Este trecho" a cada trecho selecionado que tivesse aparência própria, então a mudança seguinte, pensada para todos, caía só no trecho clicado. Agora:
  - "Todos os trechos" grava o ajuste global **e** tira de cada trecho o valor próprio **daquele** ajuste, numa escrita só (`applyCameraLookToAllPieces` em `useEditorSettings.ts`, `clearCameraLookKeys` em `cameraSegments.ts`; o hook `useEditorSettings` ganhou `transform` e `historyLabel`). Todo trecho fica com o valor novo. Os ajustes que a mudança não toca continuam próprios: um trecho com tamanho próprio mantém o tamanho quando só a posição muda para todos.
  - O escopo escolhido vale para os próximos trechos selecionados na sessão (`pickedLookScope` em `FloatingInspector.tsx`).
  - O painel Layout (global) não mudou: continua sendo o padrão dos trechos sem aparência própria.
  - Um Ctrl+Z volta o ajuste global e os valores próprios juntos.
- **12, Restaurar.** No menu OpenScreen (marca no canto), "Restaurar" abre a lista; com o botão direito numa trilha da timeline, o menu daquela trilha (anotações → anotações; velocidade, cortes e clipes → vídeo; zoom → zooms; câmera → câmera) mais "Restaurar tudo". Cada um pede confirmação (`ProjectResetDialog.tsx`) e é **uma** escrita desfazível com nome no histórico. Funções puras em `src/lib/ai-edition/document/projectReset.ts`; a execução (zooms planejados de novo, uma escrita) em `src/components/ai-edition/projectReset.ts`.
  - **Câmera:** os trechos que o log "Rosto / Tela + câmera" do take faz (`cameraSegmentsFromRecordedLayouts`, que usa a mesma `cameraSegmentsFromRecordingLayout` da importação), sem aparência própria. Take sem log: PiP no take inteiro.
  - **Vídeo:** um clipe por gravação, inteira (até o aperto de Parar, como a importação: `recordedClipLengthSec`), na ordem em que tocavam: saem cortes, trims, velocidade, divisões, reordenação, recorte e palavras inseridas. Zooms, anotações, trechos da câmera e áudios **seguem a gravação** (o mesmo segundo da fonte), não a régua: `reanchorRows` (agora exportado de `timeline.ts`) junta as âncoras de todos os clipes de uma gravação no clipe que fica. O `restoreFullTimeline` antigo não serve: ele re-ancora pela régua, e um zoom depois de um corte cairia em outra imagem.
  - **Zooms:** todos saem e os automáticos são planejados de novo como depois de gravar (`planAutoZoomsOver` em `autoZoomReplan.ts`, a mesma telemetria, quadros e transcrição do replanejamento; só se a pref de auto-zoom depois de gravar estiver ligada, `readAutoZoomPref` exportado de `recordingImport.ts`). Se o planejamento falhar, ficam os zooms automáticos que já existiam.
  - **Anotações:** ficam só os desfoques automáticos (`annotationSource` auto-redact): o OCR acharia os mesmos no mesmo take, e "Procurar de novo" refaz com palavras novas.
  - **Tudo:** vídeo, câmera, anotações, zooms (planejados de novo), áudios importados e trechos silenciados. **Ficam:** a transcrição e as correções dela (transcrever de novo é caro), as mídias, o nome e a aparência do projeto (composição, fundo, cursor, estilo da câmera e das legendas, volumes). A aparência fica porque é o que uma importação nova herda (`newProjectLook` no document service).
  - Uma escrita que chega enquanto os zooms são planejados faz o reset ser montado de novo a partir do documento novo (uma vez). Um projeto que já está como importado não ganha passo vazio no histórico (só vale quando o resultado é igual byte a byte; a câmera regera ids, então "Restaurar trilha da câmera" sempre grava).
  - **Para conciliar com `fix/camera-layout-import`:** este branch **não** mexe em `applyFreshRecordingCameraLayout`. O reset chama a mesma `cameraSegmentsFromRecordingLayout` que a importação (e o fix) usam, então não há segunda versão do layout → trechos. Em `recordingImport.ts` só mudou `readAutoZoomPref`, que passou a ser exportado.
- **13, histórico no desfazer.** Botão direito, toque longo, Shift+F10 ou a tecla de menu nas setas de desfazer/refazer da barra de cima lista os passos, o mais perto primeiro ("Mover zoom", "Cortar trecho", "Resposta da IA", "Restaurar tudo"...), com −N / +N. Escolher um volta (ou avança) até ele num passo só. Setas e Enter navegam; Esc fecha e devolve o foco à seta. Mostra 20 linhas e diz quantos passos mais antigos ficaram fora (a pilha guarda 50). `HistoryMenu.tsx`.
  - **De onde vem o nome:** `DocumentWriteOptions.historyLabel` (opcional) em `saveDocument` / `setDocument`; sem ele, `inferHistoryLabel` (`store/historyLabels.ts`) lê a mudança comparando o documento antes e depois, campo a campo, pela referência primeiro (clipes antes de regiões, porque uma edição de clipe re-deriva as regiões; zooms e anotações: adicionar, remover, mover ou editar; câmera: dividir, aparência do trecho ou editar trilha). Sem nada reconhecível, "Edição". Nomes explícitos hoje: resposta da IA (`agentDocumentApply.ts`), Limpar fala, Limpar timeline, "Todos os trechos" e os resets. O nome é uma chave (`editor.history.labels.*`), traduzida na hora de mostrar.
  - **Como o salto funciona:** `undo(steps)` / `redo(steps)` em `undo.ts` andam vários passos e restauram o documento uma vez; cada passo leva o nome junto (`Snapshot.label` em `undoStack.ts`) de `past` para `future` e de volta. As chamadas de `pushFuture` / `pushPast` continuam só dentro de `undo` / `redo` (o `documentWriteAudit` confere), e "Desfazer esta resposta" da IA continua comparando a entrada pela identidade.
- **Verificado** numa instância isolada (porta 9273, perfil novo em `scratchpad/editor/profile-r3`, take sintético de 20 s com câmera e `.layout.json` com rosto de 4 a 7 s, entregue pelo `set-current-recording-session`, scripts em `scratchpad/editor/scripts/`, prints em `scratchpad/editor/shots/`): a importação deu o trecho "Câmera em tela cheia" de 4 a 7 s; trecho 1 com posição própria e depois "Todos os trechos" → Superior a partir do último trecho: o trecho 1 perdeu a posição própria, o global ficou `top`, e o trecho 1 abriu de novo em "Todos os trechos"; Ctrl+Z voltou os dois, Ctrl+Shift+Z refez. Depois de um corte (T), um zoom (Z), uma anotação (A) e uma divisão da câmera (B): "Restaurar trilha da câmera" (menu) → só o trecho de 4 a 7 s; "Restaurar trilha de vídeo" (botão direito na trilha de cortes) → clipe 0–20 s sem cortes, zoom e anotação no mesmo lugar; "Restaurar tudo" → o mesmo estado da importação (com a posição global escolhida, que é aparência); um Ctrl+Z depois de cada um voltou exatamente o estado editado. Histórico: "Desfazer até" listou Dividir câmera, Adicionar anotação, Adicionar zoom, Cortar trecho, Aparência da câmera em todos os trechos, Aparência do trecho, Editar trilha da câmera (a importação); escolher "Cortar trecho" voltou 4 passos de uma vez; "Refazer até" pelo teclado (Shift+F10, setas, Enter) até "Dividir câmera" voltou ao estado de antes do salto.
- **Ficou de fora:** o auto-zoom do take sintético não tinha telemetria do cursor, então o replanejamento dos zooms no E2E não gerou nenhum (está coberto por teste de unidade com o planejador injetado). O painel Layout global não ganhou "aplicar a todos". Os resets não regravam os desfoques automáticos pelo OCR (mantêm os que existem).

**Avisos do HUD e janela da câmera antes do take** (branch `fix/hud-notices-selfview`, pedidos 4 e 8 de 12/10):

- **Pedido 8: o X dos avisos do HUD não fechava, e eles não sumiam sozinhos.** Os avisos são toasts do sonner ("Pouco espaço em disco", microfone mudo, câmera escura, falhas). O HUD deixa o mouse passar e só volta a recebê-lo quando o ponteiro está sobre algo marcado `data-hud-interactive='true'` (o teste do poll `hud-overlay-cursor` e o `handleRootPointerMove`). O toast é do sonner, não do HUD, então nunca entrava nesse teste: o clique no X ia para o app de baixo. Vários pediam 15 s, e o de microfone mudo, "até o sinal voltar". O toast ainda ficava no canto inferior direito da janela, por cima dos botões da barra.
  - Agora o teste fica num lugar só, `isHudInteractiveTarget` / `HUD_INTERACTIVE_SELECTOR` (`src/lib/hudNotices.ts`). Ele conta cada toast (`[data-sonner-toaster] [data-sonner-toast]`), mas não a lista inteira, que ocupa a largura da janela, nem um toast que está saindo (`data-removed='true'`, invisível mas ainda no DOM). Qualquer aviso novo do sonner, ou um `HudNotice`, já nasce clicável.
  - O HUD tem toaster próprio, `HudToaster` (`src/components/launch/HudToaster.tsx`, escolhido em `App.tsx` para `hud-overlay`). Ele centraliza os toasts logo acima da barra: o `LaunchWindow` mantém `--hud-toast-bottom` na borda de cima da barra. Também fecha cada toast **3 s** depois de aparecer, seja qual for a duração pedida. Mostrar de novo com o mesmo id conta como nova aparição.
  - **Os que ficam:** as falhas em que o take se perdeu ou não foi salvo (`recording.stopFailed`, `saveFailedFileKept`, `webcamNotSaved`) e `startFailed`, que traz o motivo técnico na descrição. Eles usam `persistentToast()` e ficam até o X, que agora funciona. O microfone mudo fecha em 3 s como os outros, e o ponto vermelho no botão do microfone continua até o sinal voltar.
  - Os dois `HudNotice` (sugestão de idioma e aviso do encoder por software) são perguntas com botões, então **não** somem sozinhos. Eles já eram clicáveis.
  - **Tamanho da janela:** os toasts não mudam o tamanho do HUD, porque cabem na reserva acima da barra. Um `HudNotice` mais alto que a reserva aumenta a janela, e ela volta ao tamanho de antes quando ele fecha. A regra foi para `hudNeedsResize` (`hudGeometry.ts`), com testes.
  - **Medido** numa instância isolada (take real; o C: abaixo de 10,5 GB dispara o aviso de disco de verdade). Antes: no X, o `elementFromPoint` caía no botão, mas o seletor antigo dava `false`; o toast ficou 15 s e cobria a ponta direita da barra. Depois: o seletor novo dá `true`, um ponto logo acima do toast continua deixando o mouse passar, o toast fica acima da barra sem encostar nela e some **3002 ms** depois de aparecer.
- **Pedido 4: a janela da câmera saía quadrada antes do take, com um anel branco.** Antes do take, a janelinha mostra a câmera por um `<video>` (getUserMedia). No take, ela pinta num `<canvas>` os quadros do helper. O recorte era `overflow: hidden` mais `border-radius` no contêiner. O Chromium põe o `<video>` tocando numa camada própria do compositor, e essa camada não respeitava o canto arredondado. O canvas respeitava. Por isso a câmera aparecia inteira, quadrada, e o anel `border-white/15` desenhado por cima marcava onde o recorte deveria estar.
  - Agora as duas fontes pintam no **mesmo canvas**, com a mesma função (`paintCover`: espelhada e preenchendo a janela). O `<video>` virou só decodificador (1 px, transparente), lido por `requestVideoFrameCallback`. O recorte é um `clip-path` (`selfViewShapeStyle`: `circle(50%)` ou `inset(0 round 18%)`), e o anel saiu.
  - A proteção de conteúdo da janela não mudou.
  - **Medido** em capturas da área de trabalho (`CopyFromScreen`, a janela com `OPENSCREEN_DISABLE_CONTENT_PROTECTION=1`). Antes do take, era um quadrado com o anel por cima. Depois, a mesma janela redonda (e quadrada arredondada) antes e durante o take, sem anel.
- **Testes:** `HudToaster.test.tsx` (3 s, 15 s e infinito fecham em 3 s, mesmo id reinicia, persistente fica e o X fecha, posição), `hudNotices.test.ts` (seletor e persistência), `hudGeometry.test.ts` (`hudNeedsResize`), `SelfViewWindow.test.tsx` (recorte igual nas duas fontes, forma, sem anel, `<video>` escondido) e um caso em `LaunchWindow.test.tsx`: o cursor do poll sobre o X do toast devolve o mouse ao HUD.

**Padrões: configurações globais para todo projeto** (pedido de 13/10, branch `feat/global-defaults`: um lugar para configurar todos os parâmetros como padrão, por exemplo um glossário padrão para todo projeto, e cada projeto ainda editável no menu Mídia).

- **Onde fica.** Menu do app (logo OpenScreen) → **Padrões**, ao lado de Provedores de IA, e o link "Abrir Padrões" no painel de Mídia. Uma janela com seções: Transcrição, Privacidade, Limpar fala, Projetos novos, Legendas, Exportação, IA (`src/components/ai-edition/defaults/DefaultsDialog.tsx`, montada no `App.tsx` como o `ProviderSettingsDialog`, seção `"defaults"` do `EditorDialogsContext`).
- **Dois modelos, de propósito**, e cada seção diz qual segue:
  - **Transcrição, privacidade, Limpar fala e exportação: o projeto herda, a não ser que mude.** Esses valores já eram preferências globais (`userPreferences.ts`, localStorage), então um projeto antigo não tem nada próprio e continua igual. No painel de Mídia, cada valor mostra **Padrão** ou **Deste projeto**; mudar ali grava só no projeto (`legacyEditor.projectOverrides`, o blob passthrough: sem migração de schema, e um build antigo mantém a chave). "Usar o padrão" (seta circular) apaga o valor do projeto; "Salvar como padrão" (alfinete) leva o valor para os Padrões, e o projeto volta a seguir o padrão. Lógica pura em `src/lib/ai-edition/projectTranscriptionSettings.ts` (`resolveProjectTranscriptionSettings`, `withProjectOverrides`, `promoteOverrideToDefault`); UI em `v4/ProjectTranscriptionSettings.tsx`, um componente separado dentro do `MediaStage`.
  - **Glossário e palavras sensíveis: padrão + linhas do projeto.** A lista padrão vale em todo projeto (é para isso que ela existe) e o projeto só **acrescenta** ("Só deste projeto"). Uma linha do projeto com um termo que o padrão já tem substitui a linha do padrão (`mergeGlossary`). A lista padrão aparece dobrada e só de leitura ("Do padrão (N)"). O glossário padrão começa no `DEFAULT_GLOSSARY` de sempre e tem "Restaurar a lista que vem com o app".
  - **Aparência e edição de projetos novos: cópia na criação.** As configurações do editor de cada projeto ficam no `legacyEditor` dele, e uma chave que falta é lida como o valor de fábrica. Herdar na leitura mudaria a cara de todo projeto que já existe no momento em que um padrão mudasse; por isso os padrões são **copiados** para o projeto novo quando ele é criado e nunca mais mexem nele. O renderer manda os padrões no `aiEdition.create(title, editorDefaults)`, e o `DocumentService.createProject` monta o `legacyEditor` com `composeNewProjectEditor` (`src/lib/ai-edition/newProjectDefaults.ts`, seguro para o main): plaquinhas e anel de clique de fábrica, depois os Padrões e, por cima, o estilo marcado "para projetos novos", se houver (a janela avisa e oferece parar de usar). **Enquanto nenhum padrão foi salvo**, vale o comportamento antigo: o projeto novo copia a aparência do último projeto editado (a janela diz isso). Fica no `localStorage` numa chave própria (`openscreen_editor_defaults`, `editorDefaultsStore.ts`): um papel de parede próprio é uma imagem de vários MB e, junto das preferências, um estouro de cota faria todas pararem de salvar.
- **O que é padrão de projeto novo** (lista em `DEFAULTABLE_EDITOR_KEYS`): toda a aparência dos estilos (fundo, moldura, sombra, cantos, padding; câmera: layout, formato, arredondamento, tamanho, espelho, fundo; cursor: tamanho, suavização, desfoque, bounce, 3D, tipos, impacto e som de clique, tema, mostrar e ocultar), o formato (16:9...), preencher seguindo o cursor, a posição da câmera, dolly e inclinar para o clique, Melhorar a voz, plaquinhas de atalho, anel de clique, holofote, todos os ajustes do auto-zoom e o estilo das legendas. **Fica de fora** o que é da filmagem: recorte, enquadramento e pan da câmera, volumes, idioma e trilha da legenda.
- **Os controles são os do editor.** A seção "Projetos novos" mostra os próprios painéis do inspetor (`VideoEffectsPane`, `CursorPane`, `LayoutPane`, `AudioPane`, `AutoZoomSettings`) dentro de um `EditorSettingsSourceContext` (`useEditorSettings.ts`) que aponta para os Padrões em vez do projeto. Com `editingDefaults`, os painéis não empurram nada para a prévia nativa (que mostra o projeto aberto), escondem os volumes e o "replanejar", e tratam a câmera como presente. Botões: "Copiar do projeto aberto", "Aplicar ao projeto aberto" (uma escrita desfazível, `applyEditorDefaults`) e "Restaurar os de fábrica". Legendas: "Usar o estilo de legenda do projeto aberto" e restaurar (o painel de legendas depende da transcrição e não foi reaproveitado aqui).
- **Exportação:** formato, qualidade (o 1440p agora também é salvo) e quadros por segundo (`exportFps`, novo) são o começo de cada janela de export; −14 LUFS continua o mesmo toggle. **IA:** o "pedir aprovação" continua em Provedores de IA, e a seção só leva até lá. **Limpar fala:** os mesmos campos do painel ("Palavras e regras", agora o componente `SpeechCleanupRules`), globais como antes. **Dispositivos de gravação** continuam no HUD.
- **A transcrição usa os valores do projeto:** `transcribe.ts` monta o prompt do Whisper com os termos de sempre do projeto (ou do padrão) mais os "nomes e termos" do projeto, com o modelo e o "som do convidado" resolvidos; `transcriptionStore.ts` aplica o glossário mesclado (padrão + projeto) em cada transcrição nova e usa o idioma do projeto; `recordingImport.ts` usa o desfoque e as palavras sensíveis do projeto. Testes: `transcribe.test.ts` ("runs with the project's own standing terms and model") e `transcriptionStore.test.ts` ("corrects a new transcript with the default glossary plus the project's own lines").
- **Verificado** numa instância isolada (`node scripts/fork-e2e/defaults-flow.mjs --video <mp4 curto> --out <pasta>`: perfil novo e pasta de gravações dentro de `--out`, só CDP, e fecha a própria instância filtrando por nome e perfil). Glossário semeado com a lista de sempre; uma linha "Contoso" e o cursor em 2,4 salvos nos Padrões; um vídeo de 8 s (ffmpeg `testsrc2` + `h264_mf`) entregue pelo `set-current-recording-session` virou um projeto novo com `cursorSize` 2,4 e com "Contoso" no glossário do projeto; idioma trocado no painel de Mídia → "Deste projeto" e `projectOverrides` no arquivo; "Usar o padrão" → chave apagada; "Salvar como padrão" → `transcriptionLanguage` nas preferências e o projeto de volta ao padrão. 13 de 13 checagens.
- **Não verificado ponta a ponta:** uma transcrição real com o glossário mesclado (precisaria baixar o modelo); está coberta pelos testes de unidade acima.

**Correções do E2E da 2.7.0** (branch `fix/e2e27`; build `release/2.7.0/win-unpacked` numa instância isolada, só CDP, sem entrada de mouse ou teclado do sistema; takes reais de 6 a 15 s, tela do notebook, C920):

- **Restaurar trazia de volta o clique de parar.** Desde a #45 a importação termina o clipe no aperto de Parar (`asset.recordedEndSec`), mas "Restaurar trilha de vídeo" e "Restaurar tudo" refaziam o clipe até o fim do arquivo: no take de 14,4 s parado em 14,295 s, o clipe voltava a 14,424 s, com os ~130 ms depois do aperto (o clique no HUD e o que o helper escreveu depois). Agora `resetVideoTrack` (`projectReset.ts`) usa o mesmo `recordedClipLengthSec` da importação. O que passa do aperto continua no arquivo, e arrastar a borda do clipe ainda traz de volta. Teste em `projectReset.test.ts`. **Medido de novo** num take real (build da worktree): clipe importado 0–6,252 s, corte em 2 s, "Restaurar trilha de vídeo" e "Restaurar tudo" → 0–6,252 s (o arquivo tem 6,282 s).
- **Teste instável do scan de quadros.** `screenActivity.test.ts` (ffmpeg real) passava em 0,3 s sozinho e estourava os 30 s na suíte inteira: o scan roda o ffmpeg em prioridade abaixo do normal, e com todos os núcleos ocupados ele ficava sem CPU. O teste agora desliga só a troca de prioridade (`os.setPriority`), que não é o que ele confere.
- **Ferramenta nova:** `scripts/fork-e2e/activity-rig.cjs`, uma janela sem foco e sem mouse que abre um menu perto do ponteiro parado e depois um diálogo no meio da tela, para dar atividade de tela a um take sem mexer no mouse.
- **Conferido sem defeito** (detalhes no relatório do agente e na linha do `manual-e2e-checklist.md`): pasta por take e nome antes da importação, pergunta do auto-zoom depois do nome, contagem de 5 s com o primeiro quadro 29–39 ms depois do fim, `stopAtMs` a +1 ms do aperto, trocas Rosto/Tela a +2/+3 ms e corte seco no export (≤ 1 quadro), quadro 0 limpo num take que começa no rosto, pedaços da câmera na importação, "Todos os trechos", histórico (botão direito, Shift+F10, toque longo), Restaurar câmera, biblioteca (renomear com o projeto aberto e fechado, excluir para a Lixeira, painel de gravação que sumiu), Padrões (cursor e glossário num projeto novo, selo Padrão), toast do HUD acima da barra e fechando em 3 s, janela da câmera redonda antes e durante o take, export H.264 High/BT.709.
- **Não deu para conferir sem mouse de verdade:** o caminho click-through do HUD, o filtro dos cliques do HUD no cursor, o auto-zoom diretor com hover de verdade (um ponteiro que nunca se mexe não gera zoom, como esperado) e o cursor sem atraso.

**Ímã na timeline: bordas grudam no cursor de reprodução** (pedido de 13/10, branch `feat/timeline-snap`: "ao redimensionar qualquer elemento na timeline, deveria haver uma 'pega' do elemento no cursor da timeline, para eu fazer o elemento terminar exatamente onde o cursor está"):

- **O que gruda.** Toda borda arrastada (redimensionar) e, ao mover um elemento inteiro, qualquer uma das duas bordas. Em todas as trilhas: anotações (texto, desfoque, destaque, passo), velocidade, cortes, zooms, a borda entre dois trechos da câmera, áudios e narrações (borda e corpo), e as alças de início e fim do clipe na janela "Editar clipe" (no cursor dessa janela). Os clipes da trilha principal só são reordenados (não têm borda para arrastar), e o recorte é espacial, não da timeline.
- **No que gruda, nesta ordem.** 1) o **cursor de reprodução**, sempre primeiro: um corte entre clipes ou uma borda mais perto não rouba a vez; 2) o resto, o mais perto primeiro: início e fim de cada clipe (pontos de corte), início e fim da linha do tempo, as bordas dos outros elementos em todas as trilhas e os marcadores. Uma borda nunca gruda em si mesma.
- **Raio:** 8 px na tela (`SNAP_RADIUS_PX`), convertido em segundos pelo zoom atual (`snapRadiusSec(pxPerSec)`): o ímã é o mesmo com o zoom aberto numa palavra ou fechado num take de meia hora. Passou do raio, solta.
- **Alt (Option no Mac) desliga o ímã** enquanto estiver apertado, também se for apertado no meio do arraste sem mexer o mouse (`watchAltDuringDrag`). Durante o arraste a tecla é consumida: no Windows um Alt sozinho que chega à janela mostra a barra de menu escondida (`setAutoHideMenuBar`). **Sem conflito:** nenhum atalho do app usa Alt; o Alt no corpo de um áudio no momento do clique continua sendo o "deslizar a mídia" (decidido no clique, sem ímã).
- **Valor exato.** A borda recebe o valor do alvo, não um empurrão até perto dele. Gravado no grid de ms de sempre: o `endMs` de um zoom ou anotação grudado é `Math.round(cursor × 1000)`, e a âncora do clipe (`sourceStartSec` / `sourceEndSec`) volta para esse ms (teste com um segundo clipe que toca a fonte 20–30 s em 10–20 s). Cortes ficam em segundos da fonte, sem arredondar. Ao mover, a borda que gruda recebe o valor e a outra segue pelo comprimento.
- **O que aparece.** Grudado no cursor, o próprio cursor acende (mais largo, com brilho), sem uma segunda linha por cima. Grudado em outra coisa, a linha guia vermelha de sempre. Nos dois casos, uma etiqueta embaixo do ponteiro diz em quê e onde ("Cursor de reprodução · 0:11.4", "Borda de item", "Borda do clipe", "Início/Fim da linha do tempo", "Marcador"). A dica "Alt+Arrastar Sem ímã" fica ao lado das de rolagem. Textos novos nos 15 idiomas (`timeline.snap.*`, `timeline.labels.dragKey` / `noSnap`).
- **Histórico:** continua uma escrita por arraste, no soltar, com o nome que o #42 já dava (Mover zoom, Mover anotação, Editar corte, Velocidade, Editar trilha da câmera, Áudio).
- **Onde está:** `src/lib/ai-edition/timeline/snap.ts` (puro: `findSnap`, `snapEdge`, `snapSpan`, `buildSnapTargets`, `landedOn`); ligado em `V4Timeline.tsx` (`snapTargetsFor`, `snapEdgesRef`, `snapCue`, nos arrastes `startPillDrag`, `startAudioDrag` e `startCameraEdgeDrag`) e no `startDrag` do `EditClipModal` (`Modals.tsx`), que gruda no cursor que estava parado no clique (a alça empurra o cursor ao passar por ele, e um ímã que o seguisse nunca soltaria). O antigo `PILL_SNAP_PX` (só cortes entre clipes e pontas) saiu.
- **Testes:** `snap.test.ts` (raio por zoom, prioridade, Alt, soltar, mover pelas duas bordas, e a ida e volta pela fonte de zoom, anotação, câmera e corte), `V4Timeline.snap.test.tsx` (cada trilha, o cursor aceso, a etiqueta, Alt antes e no meio do arraste, zoom ampliado, borda de outra trilha, corte entre clipes, fim, marcador, nunca a própria borda, o deslizar do áudio intacto), `EditClipModal.test.tsx` e `historyLabels.test.ts`.
- **Verificado** numa instância isolada (`node scripts/fork-e2e/snap-flow.mjs --video <mp4> --out <pasta>`: perfil novo e pasta de gravações dentro de `--out`, porta 9287, só CDP, sem mouse nem teclado do sistema; fecha a própria instância filtrando por nome e perfil). Take sintético de 20 s (ffmpeg `testsrc2` + `h264_mf`) entregue pelo `set-current-recording-session`; zoom (Z) e anotação (A) em 3 s; cursor parado em 11,370000000000001 s por um clique na régua; a borda final do zoom levada a 3 px antes do cursor e a da anotação a 4 px depois: as duas gravadas com `endMs` 11370, e a âncora do zoom volta a 11,37; o cursor aceso e a etiqueta "Cursor de reprodução · 0:11.4" nos prints; Alt no meio do arraste soltou (11423); um Ctrl+Z voltou a anotação para 11370. 13 de 13 checagens, em três execuções seguidas.
- **Não verificado:** com mouse e teclado de verdade (o Alt físico e a barra de menu do Windows, o raio sentido na mão). Um print recortado (`page.screenshot` com `clip`) faz o Playwright mudar a viewport no meio do arraste, e o Chromium manda um movimento falso: a borda vai parar em outro lugar. É do teste, não do app; o script só tira prints da janela inteira.

Os PRs do fork são abertos e mesclados com `gh pr merge N --merge`, sem CI. Antes do merge, rode todo o portão de validação abaixo.

## Onde mora cada recurso do fork

| Recurso | Arquivos principais | Padrão |
|---|---|---|
| Idioma nativo pt-BR | `DEFAULT_LOCALE` e `FALLBACK_LOCALE` em `src/i18n/config.ts`; `currentLocale` inicial em `electron/i18n.ts` (menus, bandeja e diálogos antes do renderer falar); `systemSpeaksNativeLocale` no `I18nContext.tsx` não oferece trocar de idioma se o pt aparece em `navigator.languages`; nomes de tela do Chromium em `src/lib/sourceDisplayName.ts`. O `en` continua sendo a referência do `i18n:check`, e os testes rodam em inglês por `src/test-setup/pinEnglishLocale.ts` | pt-BR sem escolha salva; chave faltando cai no `en`; os 15 idiomas continuam no seletor, pt-BR primeiro |
| Pasta de gravações | `defaultCaptureOutputDir()` em `electron/ipc/handlers.ts`; setting `recording.recordingsFolder`; UI no modo Record (`RecStage.tsx`); uma pasta por take (`takeOutputDir`) | `Vídeos\OpenScreen\recording-<id>\` |
| Biblioteca de gravações (aba Mídia) | `electron/recording/recordingsLibrary.ts` (listar, resolver com segurança, renomear, Lixeira); IPC `recordings-library:*` e `followMove` em `electron/ipc/recordingsLibraryHandlers.ts`; miniaturas em `electron/media/recordingPreview.ts`; UI: cards em `src/components/ai-edition/v4/MediaStage.tsx` (lista única de `src/lib/ai-edition/mediaCards.ts`), estado e ações em `v4/RecordingsLibrary.tsx` (`useRecordingsLibrary`); projeto aberto em `src/lib/ai-edition/store/recordingMedia.ts` (`withMediaReleased`, `rewriteOpenProjectMedia`, `relabelMovedAssets`); caminhos em `src/lib/mediaPathRewrite.ts`; o que o main solta antes da Lixeira em `electron/media/takeFileHolders.ts` | takes antigos soltos agrupados, não migrados; excluir vai para a Lixeira só com o take livre; aba Mídia sem timeline |
| Nome no fim do take | `src/lib/ai-edition/freshTakeName.ts`, `TakeNameDialog.tsx`, IPC `name-fresh-take`; nomes válidos em `src/lib/recordingName.ts` | data e hora; antes da importação |
| Gravação que sumiu | `src/lib/ai-edition/missingMedia.ts`, `MissingMediaPanel.tsx` (`useMissingMedia`), IPC `media-files-exist`; vistas vazadas destruídas em `electron/ipc/nativeBridge.ts` | painel no lugar da prévia e da timeline |
| Atalhos globais | `DEFAULT_SHORTCUTS` em `src/lib/shortcuts.ts`; `electron/globalShortcut.ts` | Ctrl+Shift+F9 grava/para; F10 pausa; F8 marcador; F7 Rosto / Tela + câmera; F6 desenhar na tela; F12 mostra o app |
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
| Cursor desenhado no tempo certo | suavização de fase zero `CursorTrack::smoothed` / `pin_clicks` (`cursor.rs`, espelho `cursorPathSmoothing.ts`); `path` fino do `cursor-sampler` (`move`, 4 ticks por amostra) lido por `CursorTrack::load`; deslocamento pelo `firstFrameEpochMs` do helper (`cursorOffsetToFirstFrameMs`) | suavização 0,3 (9 ms) |
| Spotlight | Rust `spotlight_cb` (modo 20 — o 19 é o Glass Lens —, **só D3D11/Windows**); TS `cursor.spotlight` / `cursorSpotlight`; toggle "Holofote" | desligado |
| Atalhos na tela | `src/lib/ai-edition/keystrokes.ts` (seguro para o main) + `keystrokeRegions.ts` (renderer) | ligado em projeto novo |
| Desfoque automático (OCR) | `ocr-scan.cpp` → `electron/recording/ocrScan.ts` → `src/lib/ai-edition/redaction.ts`; `recordingImport.applyFreshRecordingRedactions`; pref `autoRedact` | ligado (como sugestão) |
| Palavras sensíveis próprias | `parseSensitiveTerms` / `foldForMatch` / `replaceAutoRedactions` em `redaction.ts`; `rescanAutoRedactions` em `recordingImport.ts`; UI no `MediaStage.tsx`; pref `autoRedactTerms` | lista vazia |
| Limpar fala | `src/lib/ai-edition/timeline/speechCleanup.ts` (`planSpeechCleanup`, `applySpeechCleanupPicks`); `SpeechCleanupPanel.tsx`; botão no `TranscriptPane` (`RightPanes.tsx`); escrita `handleApplySpeechCleanup` (`NewEditorShell.tsx`); prefs `speechFillers`, `speechContextualFillers`, `speechCleanupAggressive`, `speechSilenceMinSec`, `speechSilenceKeepSec` (`speechCleanupOptions` em `userPreferences.ts`) | conservador, só pela revisão |
| Quem está falando | `src/lib/ai-edition/transcription/speakers.ts` (`labelSpeakers`) e `speakerStems.ts`; `speaker` em `wordSchema` / `transcriptSegmentSchema`; rótulos `SpeakerLabel` (`RightPanes.tsx`); legendas `speakerLabels` / `speakerNameMic` / `speakerNameSystem` (`captions/settings.ts`, `speakerLabelledLines` em `cues.ts`); pref `transcribeGuestAudio` (`transcribe.ts`) | rótulos automáticos; legenda e trilha mista desligadas |
| Menus de sites no auto-zoom | `ocr-scan.exe --popups`; `src/lib/ai-edition/timeline/framePopups.ts`; e o scan de quadros do take inteiro, `electron/media/screenActivity.ts` + `timeline/screenActivity.ts` | ligado |
| Auto-zoom diretor | `timeline/zoom-director.ts` (beats → planos por programação dinâmica → tempo → câmera; botões no topo), `zoom-signals.ts`, `zoom-suggestions.ts` (fachada, clipes, reservas), `zoom-motion.ts` (`resolveZoomRendering`, `MIN_WIDE_SEC_OPTIONS`), `AutoZoomSettings` | calmo, 2,5 s |
| Auto-zoom guiado pela fala | `timeline/speechCues.ts` (palavras de apontar, frases, rolagem); `zoom-suggestions.ts` (`words` / `wordsByAssetId`); `zoom-director.ts` (`speechAwareEnd`, `talkingUntil`); `apply-auto-zooms.ts` (`transcriptWordsByAssetId`, `transcriptSignature`, `legacyEditor.autoZoomTranscript`); `autoZoomReplan.ts`; janela pós-gravação `TranscriptAutoZoomDialog.tsx`; aviso `TranscriptAutoZoomBar.tsx` no painel da transcrição; pref `autoZoomAfterRecording` | pergunta depois de gravar |
| Acelerar esperas | `timeline/waits.ts` (`WAIT_SPEED = 4`); Auto-enhance no `V4Timeline` | só sugere |
| Padrões (configurações globais) | janela `src/components/ai-edition/defaults/DefaultsDialog.tsx` (menu do app → Padrões; seção `"defaults"` do `EditorDialogsContext`); projeto novo: `newProjectDefaults.ts` (`composeNewProjectEditor`, `pickEditorDefaults`, `applyEditorDefaults`), `editorDefaultsStore.ts` (chave `openscreen_editor_defaults`), `DocumentService.createProject(title, editorDefaults)`; por projeto: `projectTranscriptionSettings.ts` (`legacyEditor.projectOverrides`) e `v4/ProjectTranscriptionSettings.tsx` no painel de Mídia; painéis do editor reaproveitados pelo `EditorSettingsSourceContext` (`useEditorSettings.ts`) | aparência copiada na criação; transcrição e privacidade herdadas, e cada projeto pode mudar; glossário e palavras sensíveis = padrão + linhas do projeto |
| Glossário | `src/lib/ai-edition/transcription/glossary.ts` (`upgradeStoredGlossary` troca um padrão antigo não editado); aplicado em `transcriptionStore.ts` junto com as linhas do projeto (`mergeGlossary`); pref `glossary`, editada em Padrões | lista padrão M365 e IA |
| Modelo de transcrição | `WHISPER_MODELS` em `electron/stt/modelManager.ts`; escolha em `electron/stt/whisperDevices.ts` (`resolveWhisperModel`, `--list-devices`); `prepare`/`load` em `electron/stt/index.ts`; `--dtw-preset` no helper (`electron/native/whisper-stt/src/main.cpp`); pref `transcriptionModel`; seletor no `MediaStage.tsx` | Automático: large-v3-turbo q8 numa GPU dedicada, small no resto |
| Termos de sempre (prompt) | `src/lib/ai-edition/transcription/vocabulary.ts` (`DEFAULT_VOCABULARY`, `buildTranscriptionPrompt`); usado em `document/transcribe.ts`; pref `transcriptionVocabulary` | lista M365 e IA |
| Idioma da transcrição | `effectiveTranscriptionLanguage` em `src/lib/userPreferences.ts`; pref `transcriptionLanguage` | `pt` com o app em português |
| Transcrição automática | pref `autoTranscribe` (Media stage) | **desligada** |
| Capítulos e `.srt` | `chapters.ts`, `captions/srt.ts`, `YouTubeChapters.tsx`, IPC `write-subtitles-beside`, `electron/ai-edition/chapter-titles.ts` | no fim do export |
| Loudness YouTube | `src/lib/ai-edition/deliveryLoudness.ts` (+2 dB, −16 → −14 LUFS); pref `youtubeLoudness` | ligado |
| Sair ou fechar o Recorder durante um take | `createQuitWhileRecordingPrompt` (`electron/quitWhileRecording.ts`); `close` do HUD, `hud-overlay-close` e `before-quit` em `main.ts` | pergunta (parar e abrir no editor / continuar) |
| Datas e números no idioma da UI | `src/i18n/format.ts`; `currentLocale()` em `src/i18n/toastText.ts`; nome do export em `src/lib/exportFileName.ts` | locale do i18n, não o do sistema |
| Esc/fechar durante um export | `ExportDialog` (`export-confirm-close`); proteção ao sair do app em `main.ts` (`exportJobs.isRunning`) | pergunta |
| Webcam na contagem | `useScreenRecorder` (`deferWebcamToCountdown`, win32); helper: espera do quadro visível até o fim da contagem, aviso `webcam-dark` → toast `recording.cameraDark` | sempre |
| Diagnóstico | `handlers.ts`: `gpu: {compositor, chromium}` | — |
| Studio e Recorder (Windows) | `electron/launchMode.ts`; `openLaunchTarget` / `handleSecondInstance` em `main.ts`; `applyRecorderTaskbarIdentity` em `windows.ts`; `build/installer.nsh`; ícone por `scripts/generate-recorder-icon.mjs` | sem argumento abre o Studio; `--recorder` abre o HUD |
| Trilha da câmera (schema v9) | `document.cameraSegments`; edições puras em `src/lib/ai-edition/document/cameraSegments.ts`; migração `upgradeV8DocumentToV9`; trilha `renderCameraTrack` em `V4Timeline.tsx`; painel do trecho em `FloatingInspector.tsx`; escritas em `useTimeline.ts` (`saveCameraEdit`); atalho `splitCamera` (B) | cada trecho PiP, Tela cheia ou Sem câmera |
| Sem câmera | cena `cameraHiddenRegions`; Rust `camera_hidden_regions` + `webcam_hidden` (`frame_geometry.rs`, três backends); prévia em `PreviewCanvas.tsx` | — |
| Desenhar na tela | `electron/recordingExtras/drawingOverlay.ts` (janelas em `extrasWindows.ts`); fases em `src/lib/drawing/overlayState.ts`, traços em `strokes.ts`; `src/components/recording-extras/DrawingOverlay.tsx` e `DrawingToolbar.tsx`; botão `HudDrawButton`; atalho `drawingToggle` | desligado; Ctrl+Shift+F6 |
| Ver a câmera ao gravar | `electron/recordingExtras/selfView.ts`; helper `webcam_preview.{h,cpp}` (pipe; `selfViewPipe` e `selfViewPreview` no config; `selfview on` / `selfview off` no stdin); `electron/recording/selfViewStream.ts`; `SelfViewWindow.tsx` (as duas fontes no mesmo canvas, recorte por `clip-path`); botão `HudSelfViewButton` | desligado; lembra posição e tamanho |
| Avisos (toasts) do HUD | `HudToaster` (`src/components/launch/HudToaster.tsx`, em `App.tsx`); seletor clicável e persistentes em `src/lib/hudNotices.ts` (`isHudInteractiveTarget`, `persistentToast`); `--hud-toast-bottom` no `LaunchWindow` | 3 s; falhas de take ficam até o X |
| Aviso de microfone mudo | helper `MicLevelMeter` (`mic-level`); `electron/recording/micSilence.ts` e `electron/recordingExtras/micSilenceWatch.ts`; badge em `HudMicButton`; pref `micSilenceWarningEnabled` | ligado; −60 dBFS, 6 s / 30 s |
| Rosto / Tela + câmera (HUD) | botão `HudCameraLayoutButton` (`HudControls.tsx`, só no Windows e com a câmera ligada) e atalho `cameraLayoutToggle`; pref `cameraLayout` (`app-settings.ts`); no main `switchRecordingCameraLayout` (`handlers.ts`) e `TakeCameraLayoutLog` / `takeMediaTimeMs` (`electron/recording/takeCameraLayout.ts`); sidecar `<take>.mp4.layout.json` (`src/lib/recordingLayout.ts`); `asset.cameraLayout` (`readRecordingLayout` no `document-service.ts`); peças em `cameraSegmentsFromRecordingLayout` (`cameraSegments.ts`), gravadas por `applyFreshRecordingCameraLayout` (`recordingImport.ts`); auto-zoom reserva os trechos de câmera cheia (`apply-auto-zooms.ts`) | Tela + câmera |
| Take termina no aperto de Parar; cliques do HUD fora do cursor | `pressHandlers` (`src/components/launch/hudPress.ts`); `stopAtMs` no `.session.json` → `asset.recordedEndSec` (`document-service.ts`) → `recordedClipLengthSec` (`timeline.ts`); `note-recording-control-press` → `dropControlPressClicks` (`electron/recording/takeControlPresses.ts`) | sempre (Windows) |
| Turnos do agente (aprovar e desfazer) | cada resposta do chat devolve UM documento final (as ferramentas editam uma cópia no main), aplicado por `applyAgentDocumentIfCurrent` como uma única entrada de undo; `runAgentTurn` (`agentDocumentApply.ts`) guarda o handle da entrada e recusa aplicar em outro projeto; estado por resposta em `src/lib/ai-edition/store/agentTurns.ts` (`useAgentTurnStore`: pendente/aplicada/descartada/desfeita, resumo `summarizeAgentTurnChanges`); "Desfazer esta resposta" em `agentTurnUndo.ts` (só se for a última alteração; senão orienta usar Ctrl+Z); UI `AgentTurnFooter` em `LeftPanel.tsx`; config `requireAgentEditApproval` (`llm-config-store.ts`), toggle em `ProviderSettings.tsx` | **pede aprovação** (Aplicar/Descartar); desligado, aplica na hora e mantém o desfazer |
| Movimentos de câmera 3D | `effects.dolly` (0..1) e `effects.leanToClicks` na cena (`SceneEffects`); `plan_frame` (`frame_geometry.rs`): o dolly escala `s_box` e a caixa da câmera em torno do centro do quadro por `1 + DOLLY_MAX (8%) × dolly × força do zoom` (frame anterior também, então o desfoque de movimento existente pega o empurrão); a inclinação é `regions::click_lean` (clique → o lado clicado chega perto, até 1,6°/2,6°, entra em 0,35 s e volta até 1,8 s) somada a `zoom_rotation_dyn`, só com a tela reta e o ponteiro visível (com ou sem desfoque, E-1 do E2E da 2.5.0), e `FrameGeometry::tilted()` passou a contar a parte dinâmica. Desfoque de movimento: era o existente (`effects.motionBlur`), só verificado. Prefs `dollyAmount` / `leanToClicks`; controles na seção "Movimento" do `VideoEffectsPane`. Medido no export: caixa 1611→1743 px no zoom (×1,082, centrada), igual fora dele; inclinação: 0 de diferença antes do clique, até 3,1/255 de média logo depois, 0,13 (ruído do encoder) depois de 1,8 s; borda com desfoque 20→37 px no empurrão. Três backends pelo `plan_frame` comum | desligados |
| Melhorar a voz | Rust `crates/compositor/src/voice_enhance.rs` (RNNoise do crate `nnnoiseless`, BSD-3, puro Rust, + passa-altas 80 Hz + presença 3,5 kHz até +3 dB; atraso de um quadro de 480 amostras descontado); `EnhanceStream` antes do esticamento de velocidade em `ProgrammeAudio::clip_source` (Windows) e `enhance_pcm` em `decode_and_stretch_clip_audio` (mac/Linux); cena `voiceEnhance` (fora de `audio`, que só tem ganhos lineares); a prévia toca a cópia que o addon renderiza (`enhanceVoiceFile` → IPC `prepare-enhanced-voice`, WAV em `userData/preview-audio`) no lugar da voz; prefs `voiceEnhance` / `voiceEnhanceStrength` no editorSettings; toggle no `AudioPane`. Medido (TTS Maria + ruído rosa + 60 Hz): SNR 17,3 → 42,8 dB no export (80%), cópia da prévia 42,9 dB, atraso −1 amostra (0,02 ms), 64× o tempo real. Sem stems, o som do computador também é reduzido | desligado |
| Destaque e passos numerados | tipos `highlight` e `step` em `document.annotations` (`highlightData`, `stepData`, sem subir o schema); entradas da cena em `src/lib/ai-edition/annotations/tutorialMarks.ts` (`tutorialSceneEntries`: o destaque vira um `kind: "shape"` invertido; o passo, o disco + o número + o rótulo em texto); Rust `SceneAnnotationShape` (`scene.rs`), `frame_geometry::shape_annotation_cb` e o **modo 21** nos três shaders; posição pelo ponteiro gravado em `annotations/pointerPlacement.ts`; `addTutorialMark` (`useTimeline.ts`), atalhos `addHighlight` (H) e `addStep` (N), botões da timeline; painéis `HighlightControls` / `StepControls` (`FloatingInspector.tsx`) | nada até o usuário criar |
| Aparência por trecho da câmera | `overrides` em `document.cameraSegments` (sem subir o schema); edições `setCameraPieceLook` / `clearCameraPieceLook` / `setCameraPieceStyle` e `deriveCameraLookRuns` em `cameraSegments.ts`; cena `cameraLayoutRegions`; Rust `camera_layout_regions` (`scene.rs`), `camera_look_at` (`regions.rs`), `resolve_camera_look` e `FrameGeometry::webcam_mirror`; controles `CameraLookControls` (`RightPanes.tsx`), painel do trecho `CameraPieceLook` (`FloatingInspector.tsx`); escritas `setCameraLook` / `updateCameraLookLive` / `commitCameraLook` / `clearCameraLook` / `setCameraStyle` (`useTimeline.ts`) | cada trecho segue os ajustes globais até ganhar os seus ("Este trecho"); "Todos os trechos" vale também para os que têm aparência própria (`applyCameraLookToAllPieces`) |
| Restaurar (trilha ou projeto) | puros em `src/lib/ai-edition/document/projectReset.ts`; execução e pedido em `src/components/ai-edition/projectReset.ts`; confirmação `ProjectResetDialog.tsx`; menu OpenScreen (`EditorTopBar.tsx`) e botão direito nas trilhas (`v4/TrackResetMenu.tsx`) | pergunta antes; um Ctrl+Z desfaz |
| Histórico do desfazer | `Snapshot.label` (`undoStack.ts`); `historyLabel` em `DocumentWriteOptions` e `inferHistoryLabel` (`store/historyLabels.ts`); `undo(steps)` / `redo(steps)` / `historyEntries` (`undo.ts`); `HistoryButton` (`v4/HistoryMenu.tsx`) | botão direito nas setas; 20 linhas |
| Ímã na timeline | `src/lib/ai-edition/timeline/snap.ts` (`SNAP_RADIUS_PX`, `snapEdge`, `snapSpan`, `buildSnapTargets`, `watchAltDuringDrag`); `snapTargetsFor`, `snapEdgesRef`, `snapCue` e os arrastes em `V4Timeline.tsx`; alças do `EditClipModal` (`Modals.tsx`); E2E `scripts/fork-e2e/snap-flow.mjs` | 8 px; cursor primeiro, depois cortes, pontas, bordas e marcadores; Alt desliga |

**Arquivos que podem aparecer ao lado de cada gravação** (desde a biblioteca, dentro da pasta do take, `<pasta de gravações>\<nome>\`; os takes antigos ficam soltos na raiz):

- `<take>.session.json`
- `<take>.mp4.cursor.json`
- `<take>.mp4.cursor.ndjson`
- `<take>.mp4.markers.json`
- `<take>.mp4.layout.json` (Rosto / Tela + câmera; só quando o take não ficou em "Tela + câmera" do início ao fim)
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

  São 461 testes (e 1 ignorado). O script carrega o ambiente MSVC e o ffmpeg.

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
   node_modules/electron/dist/electron.exe . --recorder --user-data-dir=<perfil> --remote-debugging-port=9233
   ```

   Rode em background.
4. **Grave:**

   ```bash
   node scripts/fork-e2e/record-take.mjs --port 9233 --keys
   ```

   - `--marker` mostra um quadrado no canto da tela principal (`stop-marker.cjs`) que fica branco 0,5 s antes do clique de parar: os quadros brancos no fim do arquivo, menos esse meio segundo, são o que foi gravado depois do clique. Toda execução imprime `stop timing:` (HUD, janela do editor, prévia).

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
- **Smoke test do instalador:** abra `release/X.Y.Z/win-unpacked/Openscreen.exe --recorder --user-data-dir=<temp> --remote-debugging-port=9232` e rode `node scripts/fork-e2e/smoke-hud.mjs --port 9232`. Feche filtrando por `Name='Openscreen.exe'` **e** pelo perfil, porque o app instalado do usuário tem o mesmo nome.

### Release local

Ancorado como `release-local`. A ordem:

1. Branch de feature → PR no fork → `gh pr merge N --merge --repo yagoangelini/openscreen` → `git pull` na `main`.
2. `npm version X.Y.Z --no-git-tag-version`, depois `git commit -am "chore: release X.Y.Z of the fork"` e push.
3. `npm run build:win -- --publish never`. Este passo recompila **todos** os nativos e o addon, e o resultado vai para `release/X.Y.Z/`.
4. Smoke test: abra `release/X.Y.Z/win-unpacked/Openscreen.exe --user-data-dir=<temp>` e confira se o Studio abre; com `--recorder`, o HUD.
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
- **Identidade:** num merge do upstream, ficam os valores do fork em `appId`, `nsis.guid`, `copyright`, `package.json` (`author`, `maintainers`, `homepage`), `electron/about.ts`, `REPO_URL` (`star-prompt.ts`) e os IDs de `launchMode.ts` / `installer.nsh`. O `launchMode.test.ts` e o `about.test.ts` falham se um deles voltar ao do upstream.
- **Dependências:** `@noble/hashes` está declarado em `devDependencies`. O npm 11 não instala dependências peer opcionais, e o teste do AppImage precisa dele.

## Assinatura

O fork assina tudo com um certificado **autoassinado**, decisão do usuário em 12/10: nada de assinatura externa.

- **O certificado:** `CN=Yago Angelini, O=Yago Angelini, C=BR`, de assinatura de código, RSA 3072, válido até 10/2031.
  - Thumbprint: `54D7FCA1B3EA8B6CFA1FC379302E61EC0F253690`.
  - Fica em `Cert:\CurrentUser\My` com a chave **não exportável**.
  - A parte pública está em `%USERPROFILE%\.openscreen-signing\openscreen-yago-angelini.cer`.
- **O que é assinado:** `electron-builder.json5` (`win.signtoolOptions` com `certificateSubjectName` e o carimbo de tempo da DigiCert, e `signExts` [.exe, .node]) assina:
  - o instalador e o `Openscreen.exe`;
  - os helpers (`wgc-capture`, `cursor-sampler`, `ocr-scan`, `whisper-stt-server`, `ffmpeg-shared`) e o addon do compositor.
  - As DLLs ficam de fora: a `onnxruntime.dll` mantém a assinatura da Microsoft.
- **Onde vale:** o Windows só confia no certificado onde ele foi importado como raiz, ou seja, o PC do usuário. Para outras pessoas continua "editor desconhecido".
- **Para o usuário confiar:** importar o `.cer` em `Cert:\CurrentUser\Root` e em `Cert:\CurrentUser\TrustedPublisher`. É ele que faz isso, porque mexe em configuração de segurança.
- **Para o agente:** sem esse certificado na máquina, o `build:win` falha ao assinar. Numa máquina nova, crie outro com `New-SelfSignedCertificate -Type CodeSigningCert` e o mesmo Subject.
- **Ao extrair o `winCodeSign`,** o 7-Zip reclama de links simbólicos de arquivos do macOS ("A required privilege is not held"). É inofensivo no Windows: o `signtool` é extraído e assina.
- **O atualizador não confere o editor** (`win.verifyUpdateCodeSignature: false`, desde a 2.5.0). Com `publisherName` no `app-update.yml`, o electron-updater só aceita um instalador com assinatura `Valid`. O certificado autoassinado dá `UnknownError` onde não foi importado, então toda atualização a partir da 2.5.0 seria recusada (E2E 2.5.0, E-4). A integridade continua: HTTPS das releases do fork e o sha512 do `latest.yml`.
- **`dist-electron` é limpo antes do build** (`scripts/clean-dist-electron.mjs` no `build:win`). Sem isso, o `app.asar` da 2.5.0 levou 145 chunks velhos, 175 MB (E-6).
- **Conferir a assinatura:** `Get-AuthenticodeSignature` em cada `.exe`. Antes de o usuário confiar no certificado, o status sai `UnknownError`; depois, `Valid`.

## Armadilhas já encontradas

- **Imports `@/` no main.** Módulos que o processo main importa precisam de imports relativos: `keystrokes.ts`, que o `document-service` usa, e `zoomMath/constants.ts`, que o agente e o MCP leem. Só o `build-vite` pega isso.
- **`rm` com variável é bloqueado** pela checagem de segurança. Use caminhos literais. `rm -rf` é bloqueado pelo hook do usuário.
- **npm 11 não instala dependências peer opcionais** que o npm 10 do upstream instala. Se um teste do upstream não achar um módulo, declare-o em `devDependencies` (foi o caso de `@noble/hashes`).
- **Arquivo travado no Windows** (`UNKNOWN: unknown error, open`) durante uma escrita: é o antivírus ou um indexador. Tente de novo.
- **Heredoc no Bash estraga barras invertidas.** Para editar código, use a ferramenta Edit ou Write, ou um script `.cjs` com o padrão `edit(file, [[old, new]])`, que checa unicidade e chama `c.replace(a, () => b)`.
- **Worktrees com junctions.** O `git worktree remove` apagou o `node_modules` e o `crates/thirdparty` da checkout principal por causa das junctions. Antes de remover uma worktree, remova cada junction com `cmd /c rmdir <junction>`. Se acontecer, `npm ci` e `npm run fetch:ffmpeg` restauram tudo.
- **Fixados na barra e o instalador.** `WinShell::UninstShortcut` desafixa, e um `setup.exe` rodado à mão (sem `--updated`) não ganha `--keep-shortcuts`. A blindagem está em `build/installer.nsh`; não troque `nsis.shortcutName` e não remova `openscreenShieldPins` (ver "Correções do E2E da 2.4.0"). Para testar instalador, use um NSIS de teste contra `.lnk` e chave de registro falsos; nunca rode um instalador do app nesta máquina (mesmo GUID da instalação do usuário).
- **Binários nativos congelados.** Os arquivos em `electron/native/bin/win32-x64/` só mudam com `build:native:win` ou `build:native:compositor`. Confira com `findstr`, prefixando `MSYS_NO_PATHCONV=1` no Git Bash. Strings UTF-16 não aparecem no `findstr`.
- **ffmpeg LGPL sem libx264.** Para gerar vídeos de teste, use `h264_mf`.
- **Testes de auditoria.**
  - `documentWriteAudit.test.ts` exige uma linha para cada novo `saveDocument`.
  - O teste de paridade da scene exige que `audio` só tenha ganhos lineares.
  - O teste do CursorPane exige que o impacto de clique fique logo abaixo dos níveis de bounce.
- **Testes e o idioma nativo.** O setup `src/test-setup/pinEnglishLocale.ts` grava `en` no `localStorage` e no `setMainLocale` antes de cada teste. Um teste que faz `localStorage.clear()` no `beforeEach` apaga isso: grave `LOCALE_STORAGE_KEY = "en"` logo depois, ou o texto sai em pt-BR.
- **Texto novo na UI.** Toda string visível passa pelo i18n, com pt-BR de verdade e a chave nos 15 idiomas (os outros recebem o inglês). Erro técnico em toast vai como `description`, com um título traduzido.
- **`recordingImport.test`.** Um teste trava saves de propósito; describes novos entram **antes** dele.
- **Disco cheio.** O C: tem cerca de 9,7 GB livres e já encheu uma vez. Em 12/10 chegou a 1,4 GB: cada worktree que roda `cargo` cria um `crates/target` próprio (2 GB só do teste em debug). Numa worktree, faça `crates/target` uma junction para o da checkout principal (o `build:native:compositor` procura o `.dll` em `crates/target/release`) e remova a junction antes de remover a worktree. As pastas `release/1.13.0` a `1.19.0` são builds antigos que podem ir embora, mas só arquivo por arquivo ou pedindo ao usuário. `crates/target` também cresce (cerca de 3 GB).
- **Helper do Whisper novo.** O large-v3-turbo precisa do `whisper-stt-server.exe` com `--dtw-preset` e `--list-devices`. O `npm run build:win` **não** compila o helper (só copia `electron/native/bin/win32-x64`). O exe novo está em `openscreen-stt/electron/native/bin/win32-x64/whisper-stt-server.exe` e em `C:\wstb-stt\whisper-stt-server.exe` (a pasta de build, ~300 MB, que pode ser apagada depois de copiar).
  - Ele foi compilado **sem Vulkan** (não há Vulkan SDK nesta máquina): o `CMakeLists.txt` do helper com o CMake e o Ninja do VS 2022 Build Tools, numa pasta de build curta por causa do MAX_PATH. Ele usa o `whisper.dll` e o `ggml-vulkan.dll` que já estão na pasta: o exe só chama a API C do whisper e do ggml, e o Vulkan vem das DLLs.
  - Para a release, copie **só esse exe** para a pasta de binários da checkout principal e confira com `findstr /M /C:"list-devices" whisper-stt-server.exe` (controle, presente no antigo e no novo: `/C:"guardrail"`).
  - O jeito completo continua sendo `npm run build:whisper-binaries` numa máquina com o Vulkan SDK.
- **Playwright `browser.close()` fecha a instância isolada.** Num script que só conecta por CDP (`connectOverCDP`), termine com `process.exit(0)`: o `close()` derrubou o app inteiro no meio de um teste de transcrição.
- **Toast no HUD e `<video>` arredondado.** O HUD só recebe o mouse sobre o que `isHudInteractiveTarget` (`src/lib/hudNotices.ts`) aceita: um elemento flutuante novo entra ali, ou fica morto para o mouse real (o clique injetado funciona e engana). Um `<video>` tocando pode escapar do `overflow: hidden` com `border-radius` do pai: recorte com `clip-path` ou pinte num canvas, como a janela da câmera.
- **Kaspersky.** Ele colocou em quarentena um gravador que ficava parado esperando no stdin (o "início armado" de `0d9dc984`, revertido em `c956ea4e`). Desde a 2.1.1 o início durante a contagem usa `startAtEpochMs` e um `sleep_until`, sem ler o stdin antes de gravar. Se o `wgc-capture.exe` sumir depois de um build, esse é o primeiro suspeito.

## Pendências

**Plano em andamento** (decidido em 10/10 à tarde, `PLANO-FORK.md`):

1. 1.19.1, correções. **Feito.**
2. 2.1.0, OpenScreen 2.0. **Feito.**
3. **2.2.0, câmera e vinheta.** É o próximo passo.
4. Os extras aprovados, todos opcionais e editáveis:
   - aviso de microfone mudo durante a gravação (**feito**, ver "Extras de gravação");
   - palavras sensíveis no desfoque, com botão para procurar de novo (**feito**);
   - retângulo de destaque e passos numerados;
   - remover "né", "tipo", "éé" e silêncios sem IA (**feito**, "Limpar fala").

### Próximo passo: 2.2.0, trilha da câmera, câmera e vinheta

**Pedido de 11/10:** a câmera numa trilha própria da timeline, com cortes e cada pedaço editável. O plano completo, em fases, está em [`PLANO-TRILHA-CAMERA.md`](PLANO-TRILHA-CAMERA.md). Ele absorve os itens 1 e 2 abaixo: o HUD escreve pedaços da trilha, e "Sem câmera" é um modo do pedaço. As fases 0 a 3 estão na `main` (2.2.0 e 2.3.0); a tabela de status está no plano. **A fase 4 (o HUD escrevendo pedaços, item 1 abaixo) está no branch `feat/hud-camera-layout`**, descrito em "Estado atual". Falta só a vinheta (item 3).

O que o usuário pediu está em `PLANO-FORK.md`, "Decisões de 10/10/2026 (tarde)". O que já foi levantado no código:

1. **"Rosto / Tela + câmera" no HUD, mais um atalho global** (Ctrl+Shift+F7, configurável). **Feito** no branch `feat/hud-camera-layout`; o que segue é o levantamento original.
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
9. `appId` próprio do fork. **Feito** (`com.yagoangelini.openscreen`, com `nsis.guid` fixado e os atalhos regravados; veja "Identidade do fork"). A pasta de dados não mudou: ela vem do `productName`, não do `appId`.
10. ~~Whisper large-v3-turbo como padrão.~~ **Feito** (Automático numa GPU dedicada; veja "Transcrição pt-BR para Microsoft e IA"). Falta pôr o helper novo na pasta de binários antes da release.
11. Spotlight no Metal e no wgpu (mac/Linux), se um dia importar.
12. Poll do HUD ainda a cada 32 ms (item 3.5 não revisto).
13. Fila do mixer de áudio sem limite e sem compensar a diferença de relógio (`AudioMixer::append` em `audio_sample_utils.cpp`). Vai junto com o item 6. O colchão de 100 ms do 2.0 resolveu a oscilação (as microfalhas), não a deriva de relógio.
14. Erros WinRT: proteger `CreateFreeThreaded`, `CreateCaptureSession` e o caminho legado `onFrameArrived` (`wgc_session.cpp`).
15. Parada: `webcamCapture.stop()` roda antes de finalizar a tela (`main.cpp`), limitado só pelo watchdog de 8 s. A finalização da câmera ainda é depois da tela (não em paralelo, por falta de teste com câmera); o `outputs-closed` espera por ela.
16. Whisper em prioridade baixa, ou só com o player parado (`electron/stt/whisperServer.ts`).
17. Não incomodar como aviso antes de gravar. Hoje é uma linha fixa no modo Record.
18. Medir a parada e o início **com câmera** (1080p e 2160p, e a lente tampada para o D-4) depois do `perf/instant-stop`.
19. ~~Um início que estoura o prazo de 12 s deixava a limpeza atrasada parar o leitor do cursor do take seguinte.~~ **Corrigido** em `feat/recording-extras` (dono do leitor por take, e a morte do helper esperada pelo próximo take). O timeout em si não foi reproduzido; a guarda tem teste (`takeOwnership.test.ts`).
20. Extras de gravação, ainda abertos: a camada de desenho cobre a tela inteira, não o retângulo de uma janela gravada (na gravação de janela os traços não entram no vídeo de qualquer forma); o aviso de mudo não lê o estado "mudo" do endpoint (`IAudioEndpointVolume`), só o nível; a janelinha da câmera ficou preta com a lente tampada (o caminho de cor está testado no C++, mas não foi visto com imagem num take real); fora do Windows não há botões (os extras não foram testados no macOS).

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
