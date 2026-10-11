# Trilha da câmera na timeline: plano

Pedido do usuário, 11/10/2026: "A gravação da câmera precisa aparecer na trilha da timeline separadamente da tela, para que eu consiga ajustar a câmera diferente em algum ponto, cortando, removendo, mudando algo, e cada pedaço cortado é editado individualmente."

Este plano junta esse pedido aos itens 1 e 2 do 2.2.0 do [`HANDOFF.md`](HANDOFF.md) (o botão "Rosto / Tela + câmera" do HUD e a região "Sem câmera"). As linhas citadas são do commit `4de55e06`.

## Status (branch `feat/camera-track`, 11/10/2026)

| Fase | Status | Onde |
|---|---|---|
| 0. Modelo e migração | **Feito** | Schema v9 (`cameraSegmentSchema`, `upgradeV8DocumentToV9` em `schema/index.ts`); `src/lib/ai-edition/document/cameraSegments.ts` (+ `.test.ts`); leitores derivados: `sceneDescription.ts`, `useTimeline.ts`, `agent-tools.ts`, `migrate.ts` (volta ao v2), workbench. Paridade: os testes `buildSceneDescription.cameraFullscreenRegions` carregam cada fixture como v8 e esperam a cena de antes. |
| 1. A trilha | **Feito** | `V4Timeline.tsx` (`renderCameraTrack`, botão "Dividir a câmera"), `FloatingInspector.tsx` (painel do trecho), `useTimeline.ts` (`saveCameraEdit` e os callbacks), atalho `splitCamera` = **B** em `shortcuts.ts`, Ctrl+C/Ctrl+V do estilo em `NewEditorShell.tsx`. |
| 2. Sem câmera | **Feito** | Cena `cameraHiddenRegions`; Rust `camera_hidden_regions` (`scene.rs`), escala até 0 na âncora em `frame_geometry.rs` e `webcam_hidden` nos três backends; prévia web com opacidade (`PreviewCanvas.tsx`). Delete num trecho: sem câmera; Delete de novo: volta ao padrão. |
| 3. Aparência por pedaço | **Feito** (branch `feat/camera-look`) | `overrides` no `cameraSegmentSchema` (sem subir a versão); edições `setCameraPieceLook` / `clearCameraPieceLook` / `setCameraPieceStyle` e `deriveCameraLookRuns` em `cameraSegments.ts`; cena `cameraLayoutRegions` (`sceneDescription.ts`); Rust `camera_layout_regions` (`scene.rs`), `camera_look_at` (`regions.rs`), `resolve_camera_look` e `webcam_mirror` por frame (`frame_geometry.rs`, três backends); `CameraLookControls` (`RightPanes.tsx`) usado pelo painel global e pelo `CameraPieceLook` (`FloatingInspector.tsx`); prévia web em `PreviewCanvas.tsx`; ponto laranja na trilha. |
| 4–5 | Pendentes | — |

Decisões tomadas na implementação:

- **Dividir um trecho implícito guarda os dois lados** como PiP explícitos. O trecho da esquerda mantém o id; o da direita é novo e fica selecionado.
- **"C" (Câmera cheia) cria um trecho por cima** dos que estavam no intervalo (`setCameraModeOverSpan`), em vez de recusar a sobreposição. O agente faz o mesmo.
- **`setCameraFullscreen` do agente** move o trecho inteiro: onde ele estava volta a ser PiP padrão.
- **Delete em lote** (seleção múltipla) volta os trechos ao padrão direto, sem passar por "sem câmera".
- **Ctrl+V de um trecho** aplica o modo copiado ao trecho sob o cursor, sem mudar o tempo.
- **"Sem câmera" encolhe a webcam até zero na âncora**, na mesma envoltória da Câmera cheia, sem mexer em shader. Trecho sem câmera e trecho em tela cheia nunca se sobrepõem.
- **Nota da release:** uma build 2.1.x recusa o arquivo v9; abrir um projeto na 2.2 e voltar à 2.1 não funciona.

Decisões da fase 3:

- **Sem subir o schema.** `overrides` é opcional dentro do v9. O zod de uma build 2.2.0 descarta a chave: o projeto abre com todos os trechos na aparência global, e salvar ali perde as aparências próprias. Avisar na nota da release.
- **Cada chave é opcional.** O trecho mostra `{...globais, ...overrides}`; uma chave ausente segue o global, inclusive quando o global muda depois. Um valor ilegível cai sozinho (`.catch`), sem recusar o documento; números entram na faixa de `SETTING_BOUNDS`.
- **A identidade inclui a aparência.** Dois trechos vizinhos com aparências diferentes continuam duas pílulas (a regra de junção lê `overrides`). Dividir mantém a aparência nos dois lados; juntar fica com a do trecho da esquerda; a borda (roll) mantém a de cada lado.
- **Na cena, a aparência é resolvida no TS**, com o mesmo `computeCompositeLayout` do `layoutByClip`, sobre os ajustes fusionados, por clipe. O Rust só interpola: caixa, raio e âncora deslizam com um smoothstep em `TRANSITION_WINDOW_S` para cada lado (no máximo metade do trecho), contido no trecho como a Câmera cheia.
- **Trechos que se tocam vão direto de um para o outro.** O primeiro segura até o fim (`continuesAfter`) e o segundo parte dele (`from`), sem voltar ao canto padrão no meio. A mesma aparência numa emenda de clipes segura dos dois lados. Trechos com a mesma aparência e modos diferentes viram uma região só.
- **Espelho:** troca no meio do movimento, ou na primeira frame do trecho quando a caixa não se move. Só vai na cena quando o trecho o muda; senão o nativo segue o espelho global ao vivo (`LiveParams::webcam_mirror`). Os backends leem `FrameGeometry::webcam_mirror`.
- **Parâmetros nativos:** o escopo "Este trecho" nunca chama `setNativeParam`; o trecho chega à prévia nativa pela cena, e a região dele vence o parâmetro global. Medido: com o espelho global ligado, um trecho com espelho desligado sai sem espelho na prévia e no export.
- **Painel:** a chave "Este trecho / Todos os trechos" abre em "Este trecho" quando o trecho já tem aparência própria. "Restaurar padrão" limpa os overrides e mantém o trecho e o modo. Sliders escrevem ao vivo e gravam um passo de desfazer ao soltar (`updateCameraLookLive` / `commitCameraLook`); a primeira escrita de um trecho implícito o guarda e troca a chave, e o arrasto continua nele.
- **Ctrl+C / Ctrl+V** levam modo e aparência juntos (`setCameraStyle`).
- **Arrastar a câmera na prévia** sobre um trecho que tem posição própria move a posição do trecho, não a global.
- **Verificado** numa instância isolada (vídeos sintéticos, 12 s, export 1080p pela CLI, caixa da câmera medida nos quadros): padrão 242×242 em (1656, 816); trecho 4–8 s no canto superior esquerdo, círculo, 24 %: 146×146 em (22, 22), chegando em ~1 s sem salto (4,25 s → 1410; 4,55 s → 742; 4,85 s → 141); trecho 8–12 s no canto superior direito: vai direto (y fica em 22 de 8,1 a 9,2 s) e volta ao padrão no último segundo (11,2 → 114; 11,8 → 736). A prévia nativa mostrou o mesmo.
- **Fora do escopo:** "Encolher no zoom", enquadramento e fundo da câmera continuam globais (o enquadramento por trecho é da fase 5).

## O que já existe e não muda

- **Sincronia de tempo.** Cada clipe da cena leva `webcamPath` e `webcamOffsetSec` (`assetCameraSource`, `src/lib/ai-edition/timeline/camera.ts:44`; montado em `src/native/sceneDescription.ts:983-1006`). Cortar, aparar, reordenar ou apagar o clipe da tela corta a câmera junto, na prévia e no export.
- **A câmera não ganha tempo próprio.** A voz mora na gravação da tela (`audioStems`): deslocar a câmera quebraria a sincronia dos lábios. A trilha só muda **apresentação** (PiP, tela cheia, sem câmera, aparência), nunca o tempo.
- Para uma câmera que derivou na captura existe `cameraTrack.offsetMs`; um slider global "Sincronia da câmera (ms)" é opcional (fase 5).

## Modelo

Coleção nova do documento, ancorada nos clipes como `zoomRanges`, com um campo de identidade como o `trackId` do áudio:

```ts
cameraSegmentSchema = {
  id, segmentId?,            // segmentId junta os fragmentos de um pedaço em clipes vizinhos
  startMs, endMs, ...clipAnchorShape,
  mode: "pip" | "fullscreen" | "hidden",
  overrides?: { webcamAnchor, webcamSizePreset, webcamMaskShape, webcamRoundness, webcamMirrored },
  origin: "system" | "agent" | "user",
}
```

- **Guardado esparso, mostrado contínuo.** Só os pedaços que o usuário criou ficam salvos. O tempo descoberto é um pedaço implícito: PiP com os ajustes globais. A trilha desenha os implícitos nos vãos.
- O `segmentId` entra na identidade da regra de junção (`timelineMap.ts:122-187`). Sem isso, dois pedaços vizinhos iguais virariam uma pílula só e o "cortar e editar cada um" não funcionaria.
- Ajuste efetivo de um pedaço: `{...ajustes globais, ...overrides}`. O painel global da câmera passa a ser "Todos os trechos".
- **Schema v9.** `upgradeV8DocumentToV9` move `legacyEditor.cameraFullscreenRegions` para `cameraSegments` com `mode: "fullscreen"`, agrupando os fragmentos com `coalesceRegionsForRuler`. Uma build 2.1.x recusa o arquivo v9 em vez de perder as regiões ao salvar: avisar na nota da release.

## Fases (cada uma é publicável sozinha)

0. **Modelo e migração, sem mudança visível.**
   - Schema v9 e `src/lib/ai-edition/document/cameraSegments.ts`, com split, modo, overrides, borda (roll), junção, remoção e `deriveCameraModeRuns`.
   - Os leitores trocam para o novo modelo, e a "Câmera cheia" passa a ser derivada dos segmentos.
   - Rust intacto. Um teste de paridade prova que a cena sai igual.
1. **A trilha.**
   - Ela substitui a faixa "Full Camera" em `V4Timeline.tsx:2491-2503`, logo acima dos clipes, mais alta, com o rótulo "Câmera".
   - **B** divide no cursor (o S já é velocidade). Clicar seleciona; as bordas internas são edição de rolagem.
   - No painel: modo PiP / Tela cheia, "Juntar com o próximo" e "Dividir no cursor".
   - Ctrl+C / Ctrl+V copiam e colam o estilo de um pedaço.
2. **Sem câmera.**
   - `cameraHiddenRegions` na cena, com alpha da webcam nos três backends Rust. Uma alternativa sem shader é escalar até 0 na âncora.
   - Opacidade na prévia web.
   - Delete num pedaço deixa o pedaço sem câmera; Delete de novo volta ao padrão.
3. **Aparência por pedaço.**
   - `cameraLayoutRegions` na cena, com transição suave: posição, tamanho, forma, arredondamento e espelho.
   - O painel ganha a chave "Este trecho / Todos os trechos".
   - Extrair os controles de `LayoutPane` (`RightPanes.tsx:2801-3180`) para `CameraLayoutControls`. No escopo "trecho", nunca chamar `setNativeParam`.
4. **"Rosto / Tela + câmera" no HUD** (item 1 do 2.2.0).
   - O sidecar `<take>.mp4.layout.json` vira pedaços fullscreen/pip na importação, ao lado de `applyFreshRecordingRedactions`.
   - Atalho global Ctrl+Shift+F7.
5. **Opcional.** Miniaturas na trilha, enquadramento por pedaço, predefinição por pedaço (lado a lado) e sincronia global da câmera.

## Cuidados

- **Pedaços sem identidade se juntam.** Dois pedaços "Câmera cheia" vizinhos fazem a câmera piscar na emenda, porque cada região entra e sai. A cena junta pedaços consecutivos do mesmo modo antes de emitir os envelopes (`deriveCameraModeRuns`).
- **Parâmetros nativos ao vivo são globais.** `setNativeParam("webcamMirror" | "webcamShape")` está em `RightPanes.tsx:2915-2981`. O override por pedaço precisa ganhar deles.
- **Testes de auditoria.**
  - Cada callback novo de `useTimeline.ts` ganha uma linha no `documentWriteAudit.test.ts`.
  - As chaves novas vão para os 15 locais.
  - Os cenários do workbench que leem `cameraFullscreenRegions` (`workbench/scenarios/camera-track.scn.ts` e outros) mudam junto.
