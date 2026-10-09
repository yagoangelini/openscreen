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
- **Preferência do Windows (opcional).** Uma opção grava "Alto desempenho" para `Openscreen.exe`, `wgc-capture.exe` e `whisper-stt-server.exe`.

## Fase 4 — Novo auto-zoom calmo

- **Foco fixo no alvo.** O zoom usa `focusMode` manual. Clique, popup e campo de texto entram juntos no enquadramento desde o início, sem reenquadrar depois.
- **Pan suave entre alvos.** Cliques próximos no tempo viram uma cena só. O próximo alvo, mesmo longe, é alcançado com pan suave sem voltar a 1x. A volta a 1x só acontece depois de ~5 s sem ação.
- **Modo da câmera no editor.** Uma opção troca **todos** os auto-zooms de uma vez entre fixo, híbrido (zona morta) e seguir o mouse.
- **Enquadrar menus e popups.** UI Automation do Windows dá o retângulo do elemento clicado e dos menus (só a posição, nunca o texto). A diferença de quadros antes e depois do clique cobre web e painéis. Quando a página inteira muda, o app afasta o zoom em vez de aproximar.
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
