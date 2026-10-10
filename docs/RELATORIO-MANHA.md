# Relatório da noite (09–10/10/2026)

> **Retrato histórico** do que foi entregue na noite de 09–10/10/2026 (v1.16.0 e v1.17.0) e das perguntas feitas ao usuário, todas já respondidas. As respostas estão em [`PLANO-FORK.md`](PLANO-FORK.md) ("Decisões da manhã"), e o estado atual em [`HANDOFF.md`](HANDOFF.md).

## Resumo

Publiquei **duas versões novas**, a 1.16.0 e a 1.17.0, na página de releases do seu fork. Ao abrir, o seu OpenScreen instalado deve oferecer a atualização (a 1.15.0 nunca chegou a ser publicada, por falta de espaço em disco). As duas passaram:

- typecheck, lint e i18n;
- todos os testes: 3835 passaram e 4 foram pulados;
- testes nativos (C++ e Rust);
- testes ponta a ponta que eu mesmo rodei numa instância isolada, sem mexer no seu app instalado;
- um smoke test do instalador.

Os PRs ficaram no seu fork: yagoangelini/openscreen#1 e yagoangelini/openscreen#2.

## O que mudou

### Gravação (Fase 5 + 6)

| O quê | Como validei |
|---|---|
| Atalhos globais Ctrl+Shift+F9 (gravar/parar), F10 (pausar), F8 (marcador), F12 (mostrar app) | Atalhos registrados (log) e marcadores gravados no teste ponta a ponta |
| Gravações em **Vídeos\OpenScreen**, com checagem de espaço em disco antes de começar | Teste ponta a ponta |
| Microfone que tem som **só num canal** (interface USB) agora sai nos dois ouvidos | Testes unitários nativos |
| **Limitador suave** no lugar do corte seco quando a mistura estoura | Testes unitários nativos |
| **Microfone ou fone que desconecta** no meio da gravação é reconectado sozinho, e o app avisa quanto tempo ficou sem som | Código e testes; **falta o seu teste real** |
| **Cursor salvo durante a gravação**: se o app travar, a gravação recuperada mantém o cursor e os auto-zooms | Matei o app no meio de uma gravação de teste e recuperei 241 amostras de 14 s |
| O cursor não para mais de ser rastreado com um aviso de UAC ou a tela de bloqueio | Testes |

### Edição

| O quê | Padrão |
|---|---|
| **Atalhos na tela**: Ctrl+C, Win+Shift+S e outros viram uma plaquinha no vídeo. Só combinações com Ctrl, Alt ou Win; digitação comum nunca é gravada | Ligado em projetos novos |
| **Destaque de clique**: um anel suave em cada clique | Ligado em projetos novos |
| **Desfoque automático de dados sensíveis** (e-mails, domínios de tenant, GUIDs, segredos, telefones), feito pelo OCR do próprio Windows, offline. Cada desfoque é uma anotação que você pode apagar | Ligado; desliga em Mídia |
| **Acelerar esperas** (varinha → Acelerar esperas): lista os trechos parados e em silêncio, e você marca quais acelerar a 4× | Só sugere |

Validações:

- O OCR achou e desfocou o e-mail `yago.angelini@…` na tela de login de uma gravação sua, do começo ao fim. Levou 5,6 s.
- A plaquinha de atalho e o anel de clique foram renderizados numa exportação de teste.

### Exportação

- **Volume do YouTube (−14 LUFS)**: ligado por padrão no MP4.
- **Capítulos do YouTube** prontos para copiar no fim da exportação, mais o botão **Melhorar títulos com IA**, que usa o provedor configurado no agente.
- **Salvar legendas (.srt)**: grava um `.srt` ao lado do MP4, já ajustado aos cortes e às velocidades.
- Fechar o editor durante uma exportação **pede confirmação**.
- O Salvar Diagnóstico agora informa qual GPU foi usada.

## O que você precisa validar

1. **Atualizar pelo app**: abra o OpenScreen e aceite a atualização para a 1.17.0.
2. **Grave duas vezes seguidas** pelo app instalado (pergunta 12 abaixo). Use os atalhos F9 (gravar), F10 (pausar e retomar) e F8 (marcar).
3. **Desconecte o microfone ou o fone USB/Bluetooth** no meio de uma gravação e reconecte: o áudio tem que voltar e o aviso tem que aparecer ao parar.
4. Numa gravação com **cliques e atalhos** (Ctrl+C, por exemplo), confira a plaquinha e o anel no editor e no vídeo exportado.
5. Grave uma tela com **o seu e-mail ou o tenant à mostra** e veja se o desfoque aparece sozinho.
6. **Exporte para o YouTube** e confira o volume (botão direito no vídeo → "Estatísticas para nerds" → *content loudness* perto de 0 dB).
7. Experimente **Melhorar títulos com IA** (precisa de um provedor configurado no agente) e **Salvar legendas (.srt)** (precisa da transcrição).
8. O **auto-zoom calmo** (perguntas 4–8).

## Espaço em disco (importante)

O C: está com **~1,5 GB livres**. Para continuar com segurança, apague:

- `C:\Users\Yago Angelini\Downloads\openscreen\.claude\worktrees\agent-*` (8,6 GB). São cópias de trabalho dos agentes da noite e não fazem falta.

Eu mesmo apaguei, um arquivo por vez, só o que eu tinha gerado (instaladores antigos, caches de build, vídeos de teste). Pastas inteiras não apaguei, porque a sua política bloqueia exclusão recursiva.

Também ficou em Vídeos\OpenScreen uma gravação de teste minha: `recording-1791603967068.mp4`, de 25 s, com a sua tela de login. Pode apagar.

## Perguntas (responda quando puder)

1. **DXGI/NVENC por padrão no monitor da RTX?** Medi: fica tudo na RTX, com 1 sessão NVENC e 14% de uso. O risco é que uma falha no meio encerra o take (o que foi gravado até ali fica salvo).
2. **Kaspersky**: ele põe em quarentena um gravador que fica "armado" esperando o comando. Por isso tirei esse modo, que ganhava ~2 s no início. Quer criar uma exclusão do OpenScreen no Kaspersky (só você pode) para eu reativar o modo armado?
3. **Webcam acesa no HUD** desde a abertura: posso deixar para abri-la só na contagem? Isso precisa do seu teste com a câmera.
4. **Auto-zoom, volta para 1x**: com o mínimo de 2,5 s de plano aberto, ações separadas por 4–7 s fazem pan em vez de abrir o zoom. Mantenho ou reduzo os 2,5 s?
5. **Auto-zoom e rolagem**: rolar logo depois de um clique segura o zoom; rolar sozinho não cria zoom. Serve para rolagens longas?
6. **Auto-zoom, modo de câmera e transição**: hoje valem só para os zooms automáticos. Aplico também aos zooms que você desenha à mão?
7. **Auto-zoom, sliders**: o zoom máximo e o tempo mínimo só valem depois de "Replanejar". Replanejo sozinho ao mexer?
8. **Auto-zoom e menus de sites** (dropdowns dentro da página) e navegação de página: ainda não são detectados (falta a análise por diferença de quadros). Implemento?
9. **16:9 como padrão** também para os seus projetos antigos que nunca escolheram formato. Ok?
10. **Esc ou fechar a janela de exportação** deve cancelar a exportação? Hoje só o botão Cancelar cancela (fechar o editor agora pergunta antes).
11. **Pausa pelo atalho F10**: não consegui validar sem ver a tela. Teste com o app instalado.
12. **Gravações seguidas**: no meu perfil de teste isolado, só a primeira gravação começou; as outras não iniciaram, sem erro. Acho que é coisa do perfil de teste. Confirme gravando 2 vezes seguidas no app instalado.
13. **Redução de ruído**: você tem o NVIDIA Broadcast. Recomendo usar o microfone "NVIDIA Broadcast" no OpenScreen, que é melhor do que qualquer filtro que eu faça. Prefere isso ou um filtro próprio no editor?
14. **Glossário nas legendas** (Power Automate, SharePoint…): o servidor de transcrição não aceita "prompt". Opção A: recompilar o whisper (precisa de Vulkan SDK e espaço em disco). Opção B: um dicionário que corrige os termos depois da transcrição. E o modelo large-v3-turbo como padrão precisa de ~1,6 GB livres.
15. **Mic e áudio do sistema em faixas separadas**: é uma mudança grande (gravador, editor e exportação). Proposta: gravar as duas faixas no MP4 e mostrar dois controles de volume no editor (voz e computador), com a exportação mixando com esses volumes. Pode ser assim?
16. **Canal do microfone**: fiz o modo **Automático** (detecta o canal mudo). Você quer também escolher à mão (Esquerdo, Direito ou Mix)?
17. **Spotlight** (escurecer tudo menos a área do cursor, desligado por padrão): precisa de um shader novo nos três backends de vídeo. Ainda quer?
18. **Impacto do clique** (a tela "recua" a cada clique): deixei desligado e separado do anel, porque vai contra o estilo calmo. Confirma?
