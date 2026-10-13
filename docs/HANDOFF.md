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

`main` do fork = **v2.6.0**, publicada e marcada como Latest. Desde a 2.1.0 o fork contém o **OpenScreen 2.0** do upstream (veja "Sincronizar com o upstream" abaixo). O histórico do fork, em ordem:

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

Os PRs do fork são abertos e mesclados com `gh pr merge N --merge`, sem CI. Antes do merge, rode todo o portão de validação abaixo.

## Onde mora cada recurso do fork

| Recurso | Arquivos principais | Padrão |
|---|---|---|
| Idioma nativo pt-BR | `DEFAULT_LOCALE` e `FALLBACK_LOCALE` em `src/i18n/config.ts`; `currentLocale` inicial em `electron/i18n.ts` (menus, bandeja e diálogos antes do renderer falar); `systemSpeaksNativeLocale` no `I18nContext.tsx` não oferece trocar de idioma se o pt aparece em `navigator.languages`; nomes de tela do Chromium em `src/lib/sourceDisplayName.ts`. O `en` continua sendo a referência do `i18n:check`, e os testes rodam em inglês por `src/test-setup/pinEnglishLocale.ts` | pt-BR sem escolha salva; chave faltando cai no `en`; os 15 idiomas continuam no seletor, pt-BR primeiro |
| Pasta de gravações | `defaultCaptureOutputDir()` em `electron/ipc/handlers.ts`; setting `recording.recordingsFolder`; UI no modo Record (`RecStage.tsx`) | `Vídeos\OpenScreen` |
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
| Ver a câmera ao gravar | `electron/recordingExtras/selfView.ts`; helper `webcam_preview.{h,cpp}` (pipe; `selfViewPipe` e `selfViewPreview` no config; `selfview on` / `selfview off` no stdin); `electron/recording/selfViewStream.ts`; `SelfViewWindow.tsx`; botão `HudSelfViewButton` | desligado; lembra posição e tamanho |
| Aviso de microfone mudo | helper `MicLevelMeter` (`mic-level`); `electron/recording/micSilence.ts` e `electron/recordingExtras/micSilenceWatch.ts`; badge em `HudMicButton`; pref `micSilenceWarningEnabled` | ligado; −60 dBFS, 6 s / 30 s |
| Rosto / Tela + câmera (HUD) | botão `HudCameraLayoutButton` (`HudControls.tsx`, só no Windows e com a câmera ligada) e atalho `cameraLayoutToggle`; pref `cameraLayout` (`app-settings.ts`); no main `switchRecordingCameraLayout` (`handlers.ts`) e `TakeCameraLayoutLog` / `takeMediaTimeMs` (`electron/recording/takeCameraLayout.ts`); sidecar `<take>.mp4.layout.json` (`src/lib/recordingLayout.ts`); `asset.cameraLayout` (`readRecordingLayout` no `document-service.ts`); peças em `cameraSegmentsFromRecordingLayout` (`cameraSegments.ts`), gravadas por `applyFreshRecordingCameraLayout` (`recordingImport.ts`); auto-zoom reserva os trechos de câmera cheia (`apply-auto-zooms.ts`) | Tela + câmera |
| Turnos do agente (aprovar e desfazer) | cada resposta do chat devolve UM documento final (as ferramentas editam uma cópia no main), aplicado por `applyAgentDocumentIfCurrent` como uma única entrada de undo; `runAgentTurn` (`agentDocumentApply.ts`) guarda o handle da entrada e recusa aplicar em outro projeto; estado por resposta em `src/lib/ai-edition/store/agentTurns.ts` (`useAgentTurnStore`: pendente/aplicada/descartada/desfeita, resumo `summarizeAgentTurnChanges`); "Desfazer esta resposta" em `agentTurnUndo.ts` (só se for a última alteração; senão orienta usar Ctrl+Z); UI `AgentTurnFooter` em `LeftPanel.tsx`; config `requireAgentEditApproval` (`llm-config-store.ts`), toggle em `ProviderSettings.tsx` | **pede aprovação** (Aplicar/Descartar); desligado, aplica na hora e mantém o desfazer |
| Movimentos de câmera 3D | `effects.dolly` (0..1) e `effects.leanToClicks` na cena (`SceneEffects`); `plan_frame` (`frame_geometry.rs`): o dolly escala `s_box` e a caixa da câmera em torno do centro do quadro por `1 + DOLLY_MAX (8%) × dolly × força do zoom` (frame anterior também, então o desfoque de movimento existente pega o empurrão); a inclinação é `regions::click_lean` (clique → o lado clicado chega perto, até 1,6°/2,6°, entra em 0,35 s e volta até 1,8 s) somada a `zoom_rotation_dyn`, só com a tela reta e o ponteiro visível (com ou sem desfoque, E-1 do E2E da 2.5.0), e `FrameGeometry::tilted()` passou a contar a parte dinâmica. Desfoque de movimento: era o existente (`effects.motionBlur`), só verificado. Prefs `dollyAmount` / `leanToClicks`; controles na seção "Movimento" do `VideoEffectsPane`. Medido no export: caixa 1611→1743 px no zoom (×1,082, centrada), igual fora dele; inclinação: 0 de diferença antes do clique, até 3,1/255 de média logo depois, 0,13 (ruído do encoder) depois de 1,8 s; borda com desfoque 20→37 px no empurrão. Três backends pelo `plan_frame` comum | desligados |
| Melhorar a voz | Rust `crates/compositor/src/voice_enhance.rs` (RNNoise do crate `nnnoiseless`, BSD-3, puro Rust, + passa-altas 80 Hz + presença 3,5 kHz até +3 dB; atraso de um quadro de 480 amostras descontado); `EnhanceStream` antes do esticamento de velocidade em `ProgrammeAudio::clip_source` (Windows) e `enhance_pcm` em `decode_and_stretch_clip_audio` (mac/Linux); cena `voiceEnhance` (fora de `audio`, que só tem ganhos lineares); a prévia toca a cópia que o addon renderiza (`enhanceVoiceFile` → IPC `prepare-enhanced-voice`, WAV em `userData/preview-audio`) no lugar da voz; prefs `voiceEnhance` / `voiceEnhanceStrength` no editorSettings; toggle no `AudioPane`. Medido (TTS Maria + ruído rosa + 60 Hz): SNR 17,3 → 42,8 dB no export (80%), cópia da prévia 42,9 dB, atraso −1 amostra (0,02 ms), 64× o tempo real. Sem stems, o som do computador também é reduzido | desligado |
| Destaque e passos numerados | tipos `highlight` e `step` em `document.annotations` (`highlightData`, `stepData`, sem subir o schema); entradas da cena em `src/lib/ai-edition/annotations/tutorialMarks.ts` (`tutorialSceneEntries`: o destaque vira um `kind: "shape"` invertido; o passo, o disco + o número + o rótulo em texto); Rust `SceneAnnotationShape` (`scene.rs`), `frame_geometry::shape_annotation_cb` e o **modo 21** nos três shaders; posição pelo ponteiro gravado em `annotations/pointerPlacement.ts`; `addTutorialMark` (`useTimeline.ts`), atalhos `addHighlight` (H) e `addStep` (N), botões da timeline; painéis `HighlightControls` / `StepControls` (`FloatingInspector.tsx`) | nada até o usuário criar |
| Aparência por trecho da câmera | `overrides` em `document.cameraSegments` (sem subir o schema); edições `setCameraPieceLook` / `clearCameraPieceLook` / `setCameraPieceStyle` e `deriveCameraLookRuns` em `cameraSegments.ts`; cena `cameraLayoutRegions`; Rust `camera_layout_regions` (`scene.rs`), `camera_look_at` (`regions.rs`), `resolve_camera_look` e `FrameGeometry::webcam_mirror`; controles `CameraLookControls` (`RightPanes.tsx`), painel do trecho `CameraPieceLook` (`FloatingInspector.tsx`); escritas `setCameraLook` / `updateCameraLookLive` / `commitCameraLook` / `clearCameraLook` / `setCameraStyle` (`useTimeline.ts`) | cada trecho segue os ajustes globais até ganhar os seus ("Este trecho") |

**Arquivos que podem aparecer ao lado de cada gravação:**

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
