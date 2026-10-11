# Plano do fork — OpenScreen para tutoriais M365 / Copilot / Power Platform

Decidido em 2026-10-09, a partir de uma auditoria completa feita em 7 frentes: gravador nativo, renderização (export), lado do app, auto-zoom, GPU e falhas gerais. O plano é executado por fases. Cada fase tem a própria branch e o próprio PR, e você aprova uma fase antes de a próxima começar. Todo recurso novo é **opcional e editável**.

## Fase 0 — Ambiente

- **Pré-requisitos a instalar:** Node 24.15.0 com npm 11.12.1 (já instalados), Visual Studio 2022 Build Tools (C++, Windows SDK), CMake, Ninja, Rust no alvo MSVC e LLVM/libclang.
- **Comandos de preparação:** `npm ci`, `npm run fetch:ffmpeg`, `npm run fetch:onnxruntime`, `npm run stage:vcomp`, `npm run build:native:win`, `npm run build:native:compositor`.
- **Linha de base:** rodar `npx tsc --noEmit`, `npm run lint` e `npm run test`, e fazer uma gravação curta seguida de export para confirmar que tudo funciona antes das mudanças.

## Fase 1 — Gravação nunca se perde (P1 + parte do P5)

- **Queda do gravador avisada na hora.** O gravador passa a emitir um evento `capture-failed`, e o app detecta quando ele termina sem ter sido mandado parar. O HUD avisa imediatamente e salva o que já foi gravado.
- **Gravação fechada direito sempre que possível.** O gravador envia `recording-stopped` sempre que o arquivo foi finalizado (marcando `truncated` se foi cortado). A gravação do cursor e do arquivo de dados da sessão vira "melhor esforço": se falharem, a gravação não é dada como perdida.
- **Sair do app no meio da gravação.** Quit, Alt+F4 ou logoff do Windows durante a gravação passam a parar e salvar antes de fechar. O botão Sair fica bloqueado ou pede confirmação.
- **Parar mesmo com o HUD travado.** O "Parar" da bandeja do sistema passa a funcionar sem depender da janela do HUD. Se a janela travar (`render-process-gone`), o app se recupera.
- **Recuperação ao abrir o app.** Gravações que ficaram sem dados de sessão são encontradas e oferecidas para abrir.
- **Erro de GPU não derruba o gravador.** As chamadas WinRT que pegam os quadros passam a tratar erros, então um reset da GPU deixa de encerrar o gravador à força.
- **Webcam travada não bloqueia a tela.** A ordem de parada muda para que uma webcam travada não impeça o fechamento do arquivo da tela.
- **Intervalo de quadros-chave fixo.** O GOP fica definido explicitamente, garantindo fragmentos de cerca de 1 a 2 s (é isso que limita quanto se perde num travamento).
- **Aviso no fallback.** Se o formato resistente a falhas não funcionar, o app avisa e tenta MP4 comum com codificação de hardware antes de cair para a de software.
- **Espaço em disco.** Verificação antes de começar e a cada 30 s durante a gravação. A pasta de gravações passa a ser configurável.
- **Reiniciar e Cancelar** pedem confirmação depois de 10 s de gravação.
- **Modo reserva (sem gravador nativo)** deixa de apagar o arquivo quando algo falha ao finalizar.

## Fase 2 — Export robusto (P2)

- **Áudio processado em pedaços.** O áudio é decodificado e codificado em janelas, em vez de o vídeo inteiro ficar na memória. Isso elimina o estouro de memória em vídeos de 2 h e também mistura áudio e vídeo ao longo do arquivo.
- **Erro interno não fecha o app.** Os pontos de entrada nativos (napi) passam a conter falhas internas (`catch_unwind`). O `Map().unwrap()` deixa de quebrar no reset do driver, que vira a mensagem "a GPU foi reiniciada".
- **Cancelar o export MP4.** O arquivo é escrito como `.partial` e só ganha o nome final ao terminar, então o export anterior não é apagado. Recursos do ffmpeg são liberados corretamente, e a barra mostra a fase "finalizando".
- **Menos memória de vídeo.** Vídeos de origem que não serão mais usados são fechados, a tela deixa de ser aberta duas vezes quando não há câmera, e o pool de texturas fica menor (sua GPU tem 6 GB).
- **Proteções extras.** Um pacote corrompido no fim do vídeo é tratado como fim do arquivo, em vez de abortar o export. Um projeto ilegível ou com zero quadros gera erro, em vez de exportar vídeo cru ou vazio. Fechar o editor durante um export pede confirmação.

## Fase 3 — GPU (RTX 3060)

- **Compositor na RTX.** O compositor escolhe a GPU de alto desempenho (`EnumAdapterByGpuPreference`) e aceita uma variável de ambiente para forçar outra.
- **NVENC primeiro.** Na NVIDIA, o codificador de hardware NVENC é tentado antes dos outros. A GPU e o codificador usados aparecem no "Salvar diagnóstico".
- **Captura na GPU do monitor.** O gravador cria o dispositivo na GPU que liga o monitor gravado, para nunca copiar quadros entre GPUs. O fornecedor do codificador passa a constar no evento `encoder-selection`.
- **Transcrição na RTX — feito antes da fase (2026-10-09).** O whisper passou a escolher a GPU dedicada e a usar no máximo 4 threads. Medido num take de 19 s: 28,7 s na Intel com 16 threads, 1,8 s na RTX com 4 threads. Uma rejeição do guardrail DTW não é mais tentada 3 vezes.
- **Preferência do Windows (opcional).** Uma opção grava "Alto desempenho" para `Openscreen.exe`, `wgc-capture.exe` e `whisper-stt-server.exe`.

## Fase 3.5 — Performance (pedido em 2026-10-09)

Medido pela investigação: hoje passam cerca de 5 a 8 s entre o clique em gravar e o cronômetro começar.

- **Preparar o gravador durante a contagem regressiva.** O gravador e o leitor do cursor iniciam junto com a contagem e só começam a gravar com um comando "vai". Hoje tudo começa depois dela (o Linux já faz assim). Ganho estimado: 1 a 3 s.
- **Leitor do cursor em paralelo com o gravador**, e não um depois do outro.
- **Não abrir a webcam ao abrir o HUD no Windows.** Hoje ela é aberta só para a pré-visualização, e o gravador precisa reabri-la ao começar. Abrir só quando a pré-visualização de configurações for aberta.
- **Janela da contagem regressiva criada antecipadamente**, e cache da consulta do registro da webcam (`reg.exe`).
- **Contagem regressiva configurável**: 0, 3 ou 5 s.
- **HUD mais responsivo ao clique.** A verificação de passagem de clique (poll do cursor a cada 32 ms) é revista.
- **Abertura do app mais rápida.** Medir com `console.time` o caminho app pronto → HUD carregado. Avaliar o bundle do HUD (1,3 MB + 0,46 MB) e a primeira inicialização da GPU.
- **Abertura do editor mais leve.** A transcrição automática passa a ser de baixa prioridade, ou só roda quando o player está parado, e ganha uma opção para desligá-la.

## Fase 4 — Novo auto-zoom calmo

- **Foco fixo no alvo.** O zoom usa `focusMode` manual. Clique, popup e campo de texto entram juntos no enquadramento desde o início, sem reenquadrar depois.
- **Pan suave entre alvos.** Cliques próximos no tempo viram uma cena só. O próximo alvo, mesmo longe, é alcançado com pan suave sem voltar a 1x. A volta a 1x só acontece depois de ~5 s sem ação.
- **Modo da câmera no editor.** Uma opção troca **todos** os auto-zooms de uma vez entre fixo, híbrido (zona morta) e seguir o mouse.
- **Enquadrar menus e popups.** UI Automation do Windows dá o retângulo do elemento clicado e dos menus (só a posição, nunca o texto). A diferença de quadros antes e depois do clique cobre web e painéis. Quando a página inteira muda, o app afasta o zoom em vez de aproximar.
- **Hover explicativo (decidido 2026-10-09).** Quando o mouse passa devagar sobre opções sem clicar, o zoom é leve e enquadra toda a área percorrida (menu, lista), parado, sem seguir item a item.
- **Ritmo (feedback do 1º teste).** Os zooms de 2 s a 1,8x "entram e saem rápido demais" e caem em lugar ou momento errado. O novo preset usa zooms mais longos, transições mais lentas e foco no conjunto da ação.
- **Antecipação.** O zoom começa junto com o movimento do mouse em direção ao alvo e fica completo 0,7 s antes do clique.
- **Novos sinais.** Digitar segura o zoom (o app registra só o instante das teclas, nunca quais foram). Clique direito, duplo-clique e roda passam a contar. Ficar parado ou navegar devolve a 1x.
- **Preset "Tutorial".** Zoom de até 1,5x (1,8x só para alvos pequenos), transição simétrica de ~1,1 s e no mínimo 2,5 s parado. Sliders no editor permitem ajustar.
- **Correções de base.** A primeira hora do cursor deixa de ser descartada em gravações longas, o instante exato do clique passa a ser usado, e o cursor é corrigido em captura de janela (`DWMWA_EXTENDED_FRAME_BOUNDS`).

## Fase 5 — Áudio e cursor (P3 + P4)

- **Fone ou mic desconectado.** O dispositivo é reaberto automaticamente e o app avisa.
- **Sincronia em gravações longas.** O áudio é posicionado pelo relógio do sistema (`qpcPosition`), a fila tem limite e a diferença de relógio é compensada.
- **Mic estéreo.** Novo modo de canal (Auto/L/R/Mix) para interfaces de áudio que gravam a voz num canal só. O corte duro de volume vira um limitador suave.
- **Áudio de export a 320 kbps.** Mic e sistema ficam em faixas separadas, se for viável.
- **Cursor gravado durante a gravação.** Os dados são escritos em NDJSON incremental e o app avisa se a captura do cursor parar.
- **Sem estouro de tempo em arquivos grandes.** Os limites fixos de 60 s da transcrição e da forma de onda passam a valer só para inatividade.

## Fase 6 — Fork e UX (P6)

- **Atualizações do seu fork.** O auto-update passa a olhar `yagoangelini/openscreen` (ou fica desativado) e ganha `appId` próprio. Também é corrigida a oferta de "atualizar" para versões mais antigas.
- **Atalhos.** Ctrl+Shift+O deixa de ser o padrão. Atalhos do editor param de disparar com um dropdown focado, o Caps Lock deixa de quebrar Ctrl+S, e o avanço quadro a quadro usa o fps real do vídeo.
- **Textos em pt-BR.** Os avisos que estão em inglês fixo no código passam a ser traduzidos.
- **Export 1440p.**
- **Largura do export.** O 1º teste saiu em 1752×1080, e não em 1920×1080 (16:9). Investigar a causa.
- **Projeto corrompido.** Aparece na lista como danificado, e um `.bak` é mantido a cada salvamento.

## Fase 7 — Recursos novos (todos opcionais e editáveis)

**Foco visual**
- destaque de clique;
- spotlight (escurecer o resto da tela);
- atalhos de teclado mostrados na tela;
- desfoque automático de dados sensíveis por OCR.

**Edição**
- acelerar esperas (Copilot gerando, flow rodando);
- marcadores por atalho durante a gravação;
- atalhos globais para iniciar, parar e pausar;
- modo não perturbe do Windows durante a gravação.

**YouTube**
- preset de export: 1440p/1080p, −14 LUFS, 320 kbps;
- legendas pt-BR com modelo maior e glossário técnico, exportáveis em `.srt`;
- capítulos automáticos;
- redução de ruído do microfone.

## Validação por fase

- **Sempre:** testes unitários dos arquivos tocados, os dois typechecks, lint e um teste completo no fim da fase.
- **Fases 1, 2, 3 e 5:** passe manual pelo [manual-e2e-checklist](../technical-documentation/testing/manual-e2e-checklist.md) usando computer-use, com gravação curta, gravação de 1 h ou mais, export 1080p/1440p e checagem de NVENC no `nvidia-smi`.

## Decisões para a execução noturna (2026-10-09)

- **Entrega:** cada fase é autovalidada, vai para a `main` do fork por merge e ganha uma release publicada pelo app. O GitHub Actions do fork está desligado.
- **Export:** o padrão é 1080p 16:9 (1920×1080), com 1440p como opção. Áudio a 320 kbps; o preset YouTube normaliza para −14 LUFS.
- **Transcrição automática:** desligada por padrão. Fica um botão para transcrever e uma opção para ligá-la.
- **Modelo Whisper:** large-v3-turbo vira o padrão e é baixado na primeira transcrição. Vem acompanhado do glossário técnico padrão, que pode ser editado.
- **Desfoque automático (OCR):** roda depois de gravar e cria regiões ativas como sugestão, para você revisar. Detecta e-mails, domínios do tenant M365, IDs/GUIDs, segredos, tokens e telefones.
- **Áudio:** microfone e sistema em faixas separadas, com volume independente no editor.
- **Pasta das gravações:** Vídeos\OpenScreen, com opção de trocar. As gravações antigas continuam onde estão.
- **Atalhos globais:**

  | Atalho | Ação |
  |---|---|
  | Ctrl+Shift+F9 | iniciar/parar |
  | Ctrl+Shift+F10 | pausar |
  | Ctrl+Shift+F8 | marcador |
  | Ctrl+Shift+F12 | mostrar o app |

  Todos configuráveis.
- **Não incomodar:** um aviso antes de gravar com botão que abre a configuração do Windows. Nada de mecanismo não documentado.
- **Capítulos:** gerados localmente, sem IA, com o botão "melhorar títulos com IA" quando houver chave de API.
- **Acelerar esperas:** só sugere; nada é aplicado sem a sua aprovação.
- **Recursos visuais em projetos novos:** destaque de clique e atalhos na tela vêm ligados; spotlight vem desligado. Todos podem ser ligados, desligados e editados.
- **Avisos:** só de manhã. Uma dúvida que surgir pausa aquela tarefa, e o trabalho segue nas outras.

## Decisões da manhã (10/10/2026)

- **Faixas separadas:** gravar mic e sistema em duas faixas no MP4; o editor mostra dois volumes (Voz e Computador) e a exportação mixa com eles. *(Implementado como dois `.m4a` ao lado do MP4; ver Status.)*
- **Redução de ruído:** recomendar o microfone do NVIDIA Broadcast (dica no app quando ele existir). Sem filtro próprio.
- **Glossário:** dicionário de correção depois da transcrição, com lista padrão editável.
- **Spotlight:** implementar, opcional na edição (desligado por padrão).
- **Auto-zoom:** escolher entre abrir após 2,5 s (calmo) ou 1,5 s; rolagem como está; modo de câmera e transição valem para todos os zooms, inclusive os manuais; sliders continuam valendo só com "Replanejar"; detectar menus de sites por diferença de quadros.
- **NVENC na RTX por padrão** ao gravar o monitor da RTX.
- **Kaspersky:** o usuário vai criar a exclusão do OpenScreen (lembrar). O início durante a contagem voltou na 2.1.1 sem ler o stdin (veja abaixo).
- **Webcam:** abrir só na contagem regressiva.
- **16:9** também nos projetos antigos que nunca escolheram formato.
- **Esc/fechar a janela de exportação** durante um export pergunta antes de cancelar.
- **Canal do microfone:** Automático mais escolha manual (Esquerdo, Direito, Mix).
- **Impacto do clique:** continua desligado.

## Status em 10/10/2026

Conferido no código da v1.19.0, item por item. As colunas de status:

- **Feito:** existe e está no código.
- **Parcial:** existe, mas falta o que está na nota.
- **Pendente:** não existe.

O que fazer a seguir e como fazer está em [`HANDOFF.md`](HANDOFF.md).

### O que ficou diferente do plano

- **Faixas separadas.** As faixas de voz e de computador **não** estão dentro do MP4. São dois arquivos `.m4a` ao lado da gravação (`<take>.voice.m4a` e `<take>.system.m4a`), e o MP4 continua com a faixa mixada. O resultado para o usuário é o pedido: dois volumes no editor, e o export mixa com eles.
- **Início armado durante a contagem.** Foi feito e depois **revertido** (commit c956ea4e): o Kaspersky põe em quarentena um gravador que fica esperando no stdin. **Voltou na 2.1.1 de outro jeito:** o helper recebe a hora do fim da contagem (`startAtEpochMs`), abre tudo e dorme até lá.
- **Modelo padrão da transcrição.** O large-v3-turbo **não** virou o padrão; o padrão continua `ggml-small-q8_0.bin`. Falta espaço em disco e a decisão de quando baixar.
- **Spotlight.** Só existe no Windows (Direct3D 11). Os shaders Metal e wgpu não têm o modo do spotlight (20 desde o merge do 2.0; o 19 é o Glass Lens do upstream).
- **Preset "Tutorial".** Não há um seletor de preset com esse nome. O próprio padrão é o preset: 1,5x, transição de 1,1 s e no mínimo 2,5 s parado. Os sliders ajustam esses valores, e "restaurar padrão" volta a eles.
- **Não incomodar.** É uma linha fixa no modo Record, com um botão que abre as notificações do Windows. Não aparece como aviso antes de cada gravação.

### Fase 1 — Gravação nunca se perde

| Item | Status | Nota |
|---|---|---|
| `capture-failed` e queda avisada | Feito | |
| `recording-stopped` com `truncated`; cursor e sessão como melhor esforço | Feito | |
| Salvar ao sair, Alt+F4 ou logoff | Feito | |
| Confirmação no botão Sair do HUD | Pendente | Hoje o app salva ao sair, sem perguntar. |
| Parar pela bandeja sem o HUD; `render-process-gone` | Feito | |
| Recuperação de gravações ao abrir | Feito | Inclui o cursor salvo durante a gravação (`.cursor.ndjson`). |
| Erros WinRT tratados | Parcial | `TryGetNextFrame` está protegido. `CreateFreeThreaded`, `CreateCaptureSession` e o caminho legado `onFrameArrived` não estão (`wgc_session.cpp`). |
| Webcam travada não bloqueia a tela | Parcial | A tela é finalizada antes da webcam. Mas `webcamCapture.stop()` ainda roda antes, e só o watchdog de 8 s o limita; o MP4 fragmentado salva o take. |
| GOP fixo | Feito | 2 s (`CODECAPI_AVEncMPVGOPSize`). |
| Aviso no fallback; MP4 comum com hardware antes de software | Feito | |
| Espaço em disco antes e durante | Feito | |
| Pasta de gravações configurável | Feito | Padrão `Vídeos\OpenScreen`. |
| Reiniciar e Cancelar pedem confirmação após 10 s | Feito | |
| Modo reserva não apaga o arquivo | Feito | |

### Fase 2 — Export robusto

| Item | Status | Nota |
|---|---|---|
| Áudio em janelas, sem estouro de memória | Feito | |
| `catch_unwind` e "a GPU foi reiniciada" | Feito | |
| `.partial`, cancelar, fase "finalizando" | Feito | |
| Menos memória de vídeo | Feito | O pool de decoders caiu de 32 para 24; o de encoder continua em 32. |
| Pacote corrompido no fim, projeto ilegível ou vazio, fechar durante o export | Feito | |

### Fase 3 — GPU

| Item | Status | Nota |
|---|---|---|
| Compositor na GPU de alto desempenho, com variável de ambiente | Feito | |
| NVENC primeiro, GPU no diagnóstico | Feito | |
| Captura na GPU do monitor; NVENC/DXGI na RTX por padrão | Feito | |
| Transcrição na RTX | Feito | |
| Preferência "Alto desempenho" do Windows | Pendente | |

### Fase 3.5 — Performance

| Item | Status | Nota |
|---|---|---|
| Gravador armado durante a contagem | Feito (2.1.1) | Com `startAtEpochMs` e `sleep_until`, sem stdin. |
| Leitor do cursor em paralelo | Feito | |
| Webcam aberta só na contagem | Feito | |
| Janela da contagem antecipada; cache do `reg.exe` | Feito | |
| Contagem de 0, 3 ou 5 s | Feito | |
| Poll do HUD | Pendente | Ainda a cada 32 ms. |
| Medir a abertura do app | Pendente | |
| Transcrição automática opcional | Parcial | Desligada por padrão, com opção. O whisper não roda em prioridade baixa e não espera o player parar. |

### Fase 4 — Auto-zoom

| Item | Status | Nota |
|---|---|---|
| Foco fixo, pan suave, modo de câmera para todos (inclusive os manuais) | Feito | |
| Popups por UI Automation e menus de sites por diferença de quadros | Feito | |
| Hover explicativo | Feito | |
| Antecipação; digitação, clique direito, duplo e roda; volta a 1x | Feito | |
| Preset calmo com sliders; abertura em 2,5 s ou 1,5 s | Feito | |
| Primeira hora do cursor; `DWMWA_EXTENDED_FRAME_BOUNDS` | Feito | |

### Fase 5 — Áudio e cursor

| Item | Status | Nota |
|---|---|---|
| Reabrir o dispositivo que cai, com aviso | Feito | |
| Sincronia pelo `qpcPosition`, fila com limite, compensar a diferença de relógio | Pendente | Fila sem limite (`AudioMixer::append`); `(void)qpcPosition`. |
| Canal do mic Auto/L/R/Mix e limitador suave | Feito | |
| Áudio a 320 kbps; voz e sistema separados | Feito | Separados como `.m4a` ao lado do MP4. |
| Cursor gravado durante a gravação | Feito | |
| Aviso no app quando o leitor do cursor desiste | Pendente | Hoje só vai para o log. |
| Tempo limite por inatividade (transcrição e forma de onda) | Feito | |

### Fase 6 — Fork e UX

| Item | Status | Nota |
|---|---|---|
| Atualizações do fork; proteção contra downgrade | Feito | |
| `appId` próprio | Pendente | Trocar muda a pasta de dados; precisa de migração. |
| Atalhos: F12; dropdown; Caps Lock; fps real | Feito | |
| Textos em pt-BR | Feito | |
| Export 1440p; 1080p 16:9 por padrão | Feito | |
| `.bak` e restauração | Feito | |
| Projeto danificado na lista | Pendente | |

### Fase 7 — Recursos novos

| Item | Status | Nota |
|---|---|---|
| Destaque de clique | Feito | O anel; o "impacto" continua desligado. |
| Spotlight | Feito | Só Windows. |
| Atalhos na tela | Feito | |
| Desfoque por OCR | Feito | |
| Acelerar esperas (sugestão) | Feito | |
| Marcador por atalho | Feito | |
| Atalhos globais | Feito | |
| Não incomodar | Parcial | Linha fixa no modo Record, não um aviso antes de gravar. |
| Preset YouTube (−14 LUFS, 320 kbps) | Feito | |
| Glossário e `.srt` | Feito | |
| Modelo maior (turbo) | Pendente | |
| Capítulos, com títulos por IA | Feito | |
| Redução de ruído | Feito | Por decisão, é a dica do NVIDIA Broadcast, sem filtro próprio. |

## Decisões de 10/10/2026 (tarde)

Tomadas a partir de [`ANALISE-MELHORIAS.md`](ANALISE-MELHORIAS.md).

- **Ordem de trabalho:**
  1. **1.19.1:** correções dos defeitos confirmados nos recursos do fork (§2 da análise). **Feito.**
  2. **2.1.0:** merge do OpenScreen 2.0 (upstream), mantendo as decisões do fork (16:9, NVENC na RTX, transcrição automática desligada e as demais). **Feito.**
  3. **2.2.0:** câmera e vinheta.
  4. Depois: os extras aprovados.
- **Câmera durante a gravação:** botão no HUD "Rosto / Tela + câmera" e um atalho global. Tela e câmera são sempre gravadas; o botão só marca os trechos, que chegam ao editor como regiões editáveis.
- **Câmera na edição:** nova região "Sem câmera", que esconde a câmera com fade.
- **Vinheta:** entra **só pelo botão** "Inserir vinheta", que divide o clipe no cursor e insere a vinheta ali. Não há inserção automática. Ela toca em tela cheia, sem moldura, cursor, zoom, câmera ou legendas.
- **Extras aprovados**, todos **sempre opcionais e editáveis**:
  - aviso de microfone mudo durante a gravação;
  - palavras sensíveis personalizadas no desfoque, mais um botão para procurar de novo;
  - retângulo de destaque e passos numerados nas anotações;
  - remoção de "né", "tipo", "éé" e silêncios longos sem IA, com respiro.
