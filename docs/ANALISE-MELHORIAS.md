# Análise de melhorias — 10/10/2026, depois da v1.19.0

O que ainda vale melhorar no fork, item por item, conferido no código. Para fazer a análise:

- três varreduras em paralelo: limitações documentadas e TODOs, inventário de recursos para tutoriais, e revisão de defeitos dos recursos do fork;
- comparação com o projeto original (upstream `getopenscreen/openscreen`).

Tudo o que aparece como **confirmado** eu mesmo verifiquei no código. O que veio só da revisão automática está marcado como **apontado, não medido**.

## Ordem recomendada

1. **v1.19.1, correções rápidas** (§2): defeitos em código só do fork, com conserto pequeno e sem conflito com o upstream.
2. **v2.1.0, o OpenScreen 2.0 dentro do fork** (§1): é o maior ganho, porque traz cerca de 200 correções, várias delas de bugs de Windows que afetam toda gravação.
3. **v2.2.0, câmera e vinheta** (§3): feito sobre a base nova, porque o 2.0 mexeu justamente na câmera.
4. Depois: pendências do plano (§4) e ideias novas (§5).

## 1. O upstream andou 408 commits desde que o fork nasceu

> **Feito na 2.1.0** (PR yagoangelini/openscreen#7). As decisões tomadas no merge estão em [`HANDOFF.md`](HANDOFF.md#sincronizar-com-o-upstream).
>
> **Conferido numa gravação real:**
>
> - H.264 High em BT.709 no caminho de CPU;
> - áudio do tamanho do vídeo, com diferença de 0,3 ms, onde antes sobrava meio segundo;
> - NVENC/DXGI na RTX intacto;
> - stems, plates de atalho e export funcionando.

O fork partiu do `main` do upstream em 28/09 (merge base `2416e44c`). Desde então:

- o upstream lançou a **v2.0.0** em 03/10 e continuou;
- são 408 commits: 197 `fix`, 61 `feat`, 20 `perf`, 62 `docs` e outros;
- o fork tem 81 commits próprios.

### Correções do 2.0 que valem para o seu Windows

O fork **não** tem nenhuma das correções abaixo. Conferi no código.

| Correção no upstream | Commit | O que muda para você |
|---|---|---|
| O mixer escreve 100 ms atrás do tempo real (#911) | `af5d8fd3` | Acabam as microfalhas: buracos de até 10 ms dentro das palavras, "dez ou mais em 25 s" medidos lá. Hoje afetam a voz, a faixa mixada e os stems. |
| H.264 High e BT.709 em todos os caminhos | `c7298340` | Cores certas também ao gravar a tela do notebook (Intel, caminho de CPU). Hoje esse caminho sai em BT.601 sem marcação, e o compositor lê como BT.709. O caminho NVENC da RTX já está certo no fork. Os encoders também deixam o perfil Constrained Baseline. |
| O áudio termina junto com o vídeo | `f9c40355` | O upstream mediu de 0,44 a 0,58 s de áudio sobrando no fim de cada take. O fork usa o mesmo mixer. |
| A tela não apaga durante a gravação | `303eb7da` | Hoje o fork não tem `powerSaveBlocker`. |
| Menus e popups entram na gravação de **janela** (Win 11 24H2+) | `b8b9049b` | Menus de contexto passam a aparecer quando você grava uma janela. O seu Windows é 24H2. |
| Tela e webcam no mesmo relógio; o vídeo mantém o relógio quando o writer perde ticks (#945) | `e8b85444`, `4ebe3ce7` | Sincronia entre a câmera e a tela. |
| Webcam gravada na resolução e no fps reais | `d93a2b1a` | Rosto mais nítido, o que importa para a intro. |
| Prévia com frames como texturas de GPU compartilhadas, sem re-seek em cada corte ou trecho acelerado | vários `perf/fix(preview)` | Prévia mais fluida. |
| Transcrição: VAD, alinhador CTC na GPU e prompt com "nomes e termos" do projeto | vários `feat/fix(stt)` | As legendas deixam de atrasar. Os nomes M365 são reconhecidos já na transcrição, somando ao glossário do fork, que corrige depois. |
| Cancelar o export MP4; só publica arquivo completo | `f2012f99`, `c4e43e2c` | O fork já tem algo parecido (`.partial`); é preciso unificar. |
| Remover palavras de preenchimento selecionadas; som de clique opcional; cursor Glass Lens; pan entre zooms desenhado na timeline | vários `feat` | Recursos novos. |

### Custo e riscos do merge

**Conflitos** (`git merge-tree` em `main` × `upstream/main`):

- 95 arquivos em conflito. 46 são traduções, de resolução mecânica, porque os dois lados só acrescentaram chaves.
- 49 são de código, documentação e pacotes, com cerca de 105 trechos.
- Os maiores estão em `pipeline_windows.rs` (10), `handlers.ts` (9), `compositor-view-napi/src/lib.rs` (8), `ExportDialog.tsx` (6), `export_control.rs` (6), `nativeBridge.ts` (5) e no mixer `audio_sample_utils.cpp` (4).
- O merge automático pode esconder conflitos de sentido, por isso a validação completa é obrigatória.

**Recursos que os dois lados fizeram, um de cada:**

- pasta de gravações configurável;
- recusa de gravar com o disco quase cheio;
- cancelamento e publicação segura do export.

**Colisão real:** o upstream usa o **modo 19** do shader para o Glass Lens. O spotlight do fork precisa passar para o modo 20, nos dois lados: `shaders.hlsl` e `frame_geometry.rs`.

**Decisões do fork que precisam sobreviver ao merge:**

- 16:9 por padrão (o 2.0 usa "Auto");
- NVENC na RTX;
- transcrição automática desligada;
- clique em anel ligado e impacto desligado.

**Ganho extra para a segurança das gravações:** no 2.0 o caminho de CPU também entrega NV12 ao encoder. Com isso fica viável cair para a CPU **no meio** do take quando o caminho NVENC/DXGI falha. Hoje uma falha dessas encerra a gravação (`technical-documentation/architecture/recording.md`, gap #336), e esse é o principal risco do padrão NVENC que o fork adotou.

**Validação:**

- portão completo;
- `build:native:win`, `build:native:compositor` e testes Rust;
- passe e2e na instância isolada;
- uma gravação real sua.

**Versão:** com o código 2.0 dentro, sugiro numerar **2.1.0**. O app instalado atualiza normalmente, porque só lê as releases do fork.

## 2. Defeitos confirmados nos recursos do fork

> **Corrigidos na 1.19.1:** os 10 itens de prioridade alta e média abaixo e, dos de prioridade baixa:
>
> - plates sobre legendas no topo;
> - contagem "x5";
> - `ocr-scan.exe` encerrado ao sair;
> - escrita atômica do `.cursor.json` e parada do timer do checkpoint.
>
> **Ficaram para depois:**
>
> - o botão "procurar dados sensíveis de novo", que vai junto com o extra "palavras sensíveis";
> - o ducking da música com stems;
> - a pausa durante um crash no checkpoint do cursor;
> - o OCR de texto pequeno, que ainda não foi medido;
> - o adiantamento do áudio nas pausas, que deve vir com o merge do 2.0.

Conserto pequeno = horas. Médio = cerca de meio dia.

### Prioridade alta

1. **Os capítulos do YouTube ignoram cortes e acelerações.** `src/lib/ai-edition/chapters.ts` usa o tempo bruto da timeline (`sourceSpanToTimelineSpans`), enquanto o `.srt` converte por cortes e velocidade (`captions/srt.ts`, `projectRawTimelineSecToPlayback`). Depois de "Cortes inteligentes" ou "Acelerar esperas", os tempos colados no YouTube apontam para o lugar errado. Conserto pequeno.
2. **O desfoque automático cobre `make.powerapps.com`.** O padrão "tenant" em `src/lib/ai-edition/redaction.ts:103` aceita qualquer `*.powerapps.com`. Em tutorial de Power Apps, a barra de endereço fica borrada o vídeo inteiro. Além disso, o padrão de telefone (`:119`) pega o final de qualquer sequência de 10 dígitos ou mais, como IDs e execuções do Power Automate. Conserto pequeno: aceitar só hosts de tenant e exigir formato de telefone.
3. **Um stem quebrado ou movido deixa a prévia muda.**
   - Depois de um crash, os `.m4a` ficam sem índice (o `moov` só é gravado ao finalizar), mas `readRecordingStems` (`electron/ai-edition/document-service.ts:190`) só confere se o tamanho é maior que zero e os aceita.
   - Se você mover ou apagar os stems, a prévia não volta para a faixa mixada: os `<audio>` não têm `onError` (`VirtualPreview.tsx:1624`).
   - A transcrição falha, porque usa o stem de voz.
   - "Reconectar mídia" (`electron/media/projectMediaRelinker.ts`) ignora os stems.
   - O export se salva, porque cai na faixa mixada.
   - Conserto médio: validar o arquivo, voltar para a faixa mixada na prévia e na transcrição, e reconectar os stems junto com o vídeo.
4. **Uma falha de escrita de um stem no meio do take o deixa truncado, mas ele é dado como finalizado.** `audio_sample_utils.cpp:909` desliga o callback; `main.cpp:1822` finaliza mesmo assim e anuncia os stems. Resultado: a voz some do ponto da falha em diante, enquanto a faixa mixada completa fica sem uso. É raro. Conserto pequeno: avisar no `recording-stopped` que o stem caiu.
5. **A busca de menus web trava as edições de um take novo por até 60 s.** `getTelemetryWithFramePopups` (`timeline/framePopups.ts:84`) roda dentro da mesma fila das edições (`NewEditorShell.tsx:540`). Num tutorial web com muitos cliques, cortes e trims esperam até 1 minuto para aplicar. Conserto médio: rodar fora da fila e aplicar o resultado depois.
6. **A varredura OCR interrompida estende o último desfoque até o fim do vídeo.**
   - `trackDetections` fecha os trechos abertos na duração total (`redaction.ts:221`) mesmo quando a varredura parou no limite de 10 min, num take longo.
   - Qualquer falha do OCR é silenciosa: exe bloqueado (Kaspersky), codec, ou o processo morto no meio.
   - Não há botão para rodar de novo.
   - Conserto médio.

### Prioridade média

7. **Atalhos na tela podem mostrar texto digitado.** As teclas modificadoras são acompanhadas só pelos eventos do hook (`input_signals.cpp:21`), sem reler o estado real. Se um Ctrl, Alt ou Win "prender" (Win+L, a tela do UAC, uma janela elevada), letras comuns passam a sair como "Ctrl+A", "Ctrl+P" e assim por diante, inclusive em senhas. Conserto pequeno: reler com `GetAsyncKeyState` a cada tecla.
8. **A narração (tecla V) grava do microfone padrão do Windows**, não do escolhido no HUD, e com o filtro de ruído do navegador por cima do NVIDIA Broadcast (`AddAudioLayerDialog.tsx:163`). Conserto pequeno.
9. **Cortar um silêncio pelo chip da transcrição corta o intervalo inteiro, sem respiro, e as palavras ficam grudadas** (`RightPanes.tsx:1679`). Os cortes por palavra deixam 70 ms de respiro (`cut-breath.ts`); o chip não. Conserto pequeno.
10. **O glossário só vale para transcrições novas.** Editar a lista não corrige as que já existem (`transcriptionStore.ts:426` é a única chamada). Conserto pequeno: um botão "Aplicar glossário a esta transcrição".

### Prioridade baixa (apontados pela revisão)

- As plates de atalhos ficam por cima de legendas ancoradas no **topo** (`keystrokeRegions.ts:68`).
- O "x5" dos atalhos repetidos aparece cedo demais e a plate dura mais do que devia (`keystrokes.ts:45`).
- Em takes com stems, a música abaixa sob o som do computador no export, mas não na prévia.
- Cada pausa adianta o áudio alguns milissegundos em relação ao vídeo. O mixer do 2.0 ("keep the mixer's cushion across an instant resume and anchor its clock exactly") provavelmente resolve isso; a confirmar no merge.
- O `ocr-scan.exe` continua rodando se o app fechar no meio.
- Casos raros de crash no momento errado do checkpoint do cursor.
- O OCR pode não ler um texto pequeno que aparece sem mudar o resto da tela (`ocr-scan.cpp:97`). **Apontado, não medido.**

## 3. Seus pedidos: câmera e vinheta

### O que existe hoje

- **"Câmera cheia" (tecla C):** uma região na timeline que leva a câmera para tela cheia com transição e depois a devolve. A câmera é gravada num arquivo separado da tela, por isso dá para mudar o layout depois.
- **Importar mídia e "Adicionar à linha do tempo":** o clipe entra **no fim**.

### O que não existe

- Trocar o layout **durante** a gravação.
- Esconder a câmera em trechos.
- Vinheta pronta.
- **Dividir o clipe no cursor** (nem no upstream).
- Clipe em tela cheia sem moldura: hoje um vídeo importado entra com o fundo, o padding e a moldura do projeto.

### Proposta

1. **HUD: "Rosto" ou "Tela + câmera".**
   - Um botão no HUD e um atalho global (sugiro Ctrl+Shift+F7, configurável).
   - A tela e a câmera são **sempre** gravadas; o botão só marca os trechos.
   - Ao parar, o editor abre com os trechos de "Câmera cheia" já criados, e você ajusta ou desfaz como qualquer região.
   - A escolha antes de gravar é o modo inicial: começar no rosto, para a intro.
   - Gravar só a câmera, sem a tela, impediria justamente a troca no meio do take. Gravar a tela junto custa pouco.
   - Nos trechos de rosto, o auto-zoom não planeja zooms.
2. **Edição: região "Sem câmera".**
   - Esconde a câmera com fade, no mesmo modelo da "Câmera cheia".
   - No compositor, vira um novo conjunto de regiões, como `camera_fullscreen_regions`.
   - Ganha tecla e lane próprias.
   - Pode vir também de um terceiro estado no HUD ("só tela").
3. **Vinheta.**
   - Você configura uma vez a "Minha vinheta" (um MP4).
   - No editor, o botão "Inserir vinheta" divide o clipe no cursor e insere a vinheta ali. A divisão no cursor também passa a existir como ferramenta geral.
   - A vinheta toca **em tela cheia, sem moldura**, cursor, zoom, câmera, legendas ou plates, e com o volume próprio dela.
   - Se o take começa no rosto e passa para a tela, o editor propõe a vinheta exatamente nesse ponto.

**Esforço aproximado:**

- item 1: 1 dia;
- item 2: 1 dia;
- item 3: 1,5 a 2 dias, porque o clipe sem moldura mexe no compositor.

Melhor fazer depois do merge, porque o 2.0 mudou a câmera e as regiões de "Câmera cheia":

- "keep Full Camera full across a trim";
- "fan out across an insertion".

## 4. Pendências do plano (já em `HANDOFF.md`)

1. Kaspersky e o início armado.
2. Confirmação no botão Sair do HUD.
3. `UserGpuPreferences`.
4. Sincronia por `qpcPosition` e fila do mixer sem limite. O 2.0 resolve parte.
5. Aviso quando o leitor do cursor desiste.
6. Projeto danificado na lista.
7. `appId` próprio.
8. Whisper large-v3-turbo. Hoje há **um** modelo fixo, sem escolha; agora há 12 GB livres.
9. Spotlight no Metal e no wgpu.
10. Poll do HUD.
11. Erros WinRT.
12. Parada da webcam.
13. Prioridade do whisper.
14. Não incomodar como aviso.

## 5. Ideias novas que combinam com o canal

Da mais útil para a menos útil:

1. **Aviso de microfone mudo durante a gravação.** Hoje o medidor só existe antes do take (`LaunchWindow.tsx:155` trava o painel), e a perda do microfone só é avisada ao parar. Protege o take.
2. **Palavras sensíveis personalizadas no desfoque**: seu nome, o tenant real, clientes. Mais um botão "Procurar dados sensíveis de novo". Hoje os padrões são fixos.
3. **Remover "né", "tipo", "éé" e silêncios longos sem IA**, com respiro. O 2.0 traz a remoção de palavras selecionadas; falta a lista pt-BR. Hoje "Cortes inteligentes" exige um provedor de IA.
4. **Marcador "errei"** durante a gravação, que sugere cortar do início da frase até o marcador.
5. **Retângulo de destaque e passos numerados** (1, 2, 3) nas anotações. Hoje só existem seta, texto, imagem e desfoque.
6. **Miniatura**: exportar o quadro atual como PNG 1280×720. Hoje só há MP4 e GIF.
7. **Descrição do YouTube**: capítulos já corrigidos mais título, descrição e tags pelo provedor de IA já configurado.
8. **`.srt` em inglês além do pt-BR.** A tradução existe, mas o `.srt` de outro idioma sobrescreve o primeiro (`handlers.ts:4488`).
9. **Short 9:16 do mesmo projeto.** O 9:16 com "Seguir o cursor" já existe; falta exportar as duas versões sem trocar o formato do projeto.
10. **Prévia do rosto enquanto grava**, para enquadrar a intro (ROADMAP #500).

## 6. Manutenção

- **Disco:** 12 GB livres. Dá para liberar cerca de 3,4 GB:
  - `crates/target`, 2,9 GB, recriado ao compilar;
  - `release/1.13.0` a `release/1.18.0`, cerca de 560 MB.
  - Precisa da sua autorização: o hook bloqueia exclusão recursiva.
- **Docs técnicos com afirmações já vencidas** (varredura de limitações):
  - "janela com tamanho ímpar dá vídeo preto" (`recording.md`), já corrigido com `roundUpToEven`;
  - "prévia de edição sem som" (`preview.md`, `native-compositor.md`);
  - "GIF sem encoder nativo" (`export-pipeline.md`);
  - "pasta de gravações em andamento" (`ROADMAP.md`).
- Os quatro testes "pulados" são condicionais à plataforma, não pendências.
