//! Piste curseur depuis un `.cursor.json` openscreen. Fournit position interpolée
//! et facteur de « click bounce » — consommés par frame (temps fractionnaire), donc
//! le motion blur du curseur vient gratuitement du supersampling temporel.

use anyhow::{Context, Result};

// Paramètres de suivi auto — parité stricte avec
// `src/lib/zoomMath/constants.ts` (AUTO_FOLLOW_PARAMS), partagés
// là-bas entre preview et export pour que la caméra suive le curseur à l'identique.
const AUTO_FOLLOW_MIN_FACTOR: f32 = 0.1;
const AUTO_FOLLOW_MAX_FACTOR: f32 = 0.25;
const AUTO_FOLLOW_RAMP_DISTANCE: f32 = 0.15;
const AUTO_FOLLOW_REFERENCE_MS: f32 = 1000.0 / 40.0;

/// Part de la vue zoomée, par axe, où le pointeur bouge sans que la vue le suive : sa moitié
/// centrale (`follow_in_view`). Au-delà, la vue le rattrape juste assez pour le ramener au bord de
/// cette zone. Sans elle, la vue suivait chaque petit geste et le cadrage paraissait nerveux.
const FOLLOW_DEAD_ZONE: f32 = 0.5;

// Convergence du curseur dessiné sur le point cliqué (`pinned_at`). L'approche accompagne la
// plongée du curseur modélisé, et la tenue couvre son appui (du clic à 80 ms après).
const PIN_APPROACH_S: f32 = 0.25;
const PIN_HOLD_S: f32 = 0.1;
const PIN_RELEASE_S: f32 = 0.25;

/// Spread (one standard deviation) of the cursor smoothing at slider 1. The smoothing is a
/// centred Gaussian over the whole known path (`smoothed`): it rounds off tremor and the corners
/// of a 30 Hz track without moving the cursor in time. 30 ms at full strength keeps every corner
/// within about one 60 fps frame of the real one.
const SMOOTHING_SIGMA_MAX_S: f32 = 0.030;
/// Grid the smoothing runs on: fine enough for any export fps.
const SMOOTHING_STEP_S: f32 = 1.0 / 240.0;

fn smoothstep01(x: f32) -> f32 {
    let u = x.clamp(0.0, 1.0);
    u * u * (3.0 - 2.0 * u)
}

#[derive(Clone)]
pub struct CursorTrack {
    /// (t_secondes, cx, cy) normalisés dans le cadre screen, triés.
    samples: Vec<(f32, f32, f32)>,
    /// Même piste après lissage exponentiel adaptatif — ce que le suivi auto du zoom doit
    /// consommer. `samples` reste la piste BRUTE : le rendu du curseur lui-même et le click
    /// bounce doivent coller à la position réelle, seule la caméra est amortie.
    follow_samples: Vec<(f32, f32, f32)>,
    /// instants de clic (secondes) dans la fenêtre.
    clicks: Vec<f32>,
    /// Position BRUTE de chaque clic (même ordre que `clicks`) : le pixel où l'utilisateur a
    /// réellement cliqué. `smoothed()` la garde telle quelle, alors que la piste lissée passe
    /// ailleurs à cet instant (cf. `pinned_at`).
    click_points: Vec<(f32, f32)>,
    /// CHANGEMENTS de visibilité : `(instant, visible)`, triés. Comme `types`, c'est une
    /// fonction en escalier. Une piste ancienne sans champ `visible` reste visible.
    visibility: Vec<(f32, bool)>,
    /// CHANGEMENTS d'état du curseur : (instant, `"arrow"` / `"text"` / `"pointer"` / …), triés.
    /// Une fonction en escalier, pas une valeur par échantillon : l'état tient sur des secondes
    /// entières alors que la position est échantillonnée toutes les 33 ms (~30 Hz, cf.
    /// `CURSOR_SAMPLE_INTERVAL_MS` côté Electron), donc n'enregistrer que les
    /// transitions garde cette liste minuscule et rend `type_at` trivial.
    types: Vec<(f32, String)>,
    /// Les vues du suivi à zone morte déjà rejouées, par `(t0, fin, échelle)` : une par région auto
    /// (`follow_in_view`). Partagé entre clones, qui ont les mêmes échantillons.
    view_cache:
        std::sync::Arc<std::sync::Mutex<Vec<(ViewKey, std::sync::Arc<Vec<(f32, f32, f32)>>)>>>,
}

/// `(law, t0, fin, échelle, départ x, départ y, zone morte, τ)` en bits.
type ViewKey = [u32; 8];

/// How a dead-zone view re-frames (`view_states`).
#[derive(Clone, Copy)]
enum ViewLaw {
    /// The classic auto-follow: starts on the smoothed pointer, `FOLLOW_DEAD_ZONE`,
    /// distance-adaptive `follow_step`.
    Classic,
    /// An automatic zoom's following mode (`follow_view`).
    Calm {
        start: (f32, f32),
        dead_zone: f32,
        tau_s: f32,
    },
}

impl ViewLaw {
    fn key(self, t0: f32, t_end: f32, scale: f32) -> ViewKey {
        let (law, (sx, sy), dz, tau) = match self {
            ViewLaw::Classic => (0, (0.0, 0.0), 0.0, 0.0),
            ViewLaw::Calm {
                start,
                dead_zone,
                tau_s,
            } => (1, start, dead_zone, tau_s),
        };
        [
            law,
            t0.to_bits(),
            t_end.to_bits(),
            scale.to_bits(),
            f32::to_bits(sx),
            f32::to_bits(sy),
            f32::to_bits(dz),
            f32::to_bits(tau),
        ]
    }

    /// One step of the view toward the point that brings `cursor` back to the edge of the dead
    /// zone (the view itself when the pointer is inside it), over `dt_ms`. `half` is half the
    /// zoomed view's width.
    fn step(self, view: (f32, f32), cursor: (f32, f32), dt_ms: f32, half: f32) -> (f32, f32) {
        let zone = match self {
            ViewLaw::Classic => FOLLOW_DEAD_ZONE,
            ViewLaw::Calm { dead_zone, .. } => dead_zone,
        };
        let dead = half * zone;
        let pull = |c: f32, v: f32| c - (c - v).clamp(-dead, dead);
        let target = (pull(cursor.0, view.0), pull(cursor.1, view.1));
        match self {
            ViewLaw::Classic => follow_step(view, target, dt_ms),
            ViewLaw::Calm { tau_s, .. } => {
                if !(dt_ms > 0.0) {
                    return view;
                }
                let a = 1.0 - (-(dt_ms / 1000.0) / tau_s).exp();
                (
                    view.0 + (target.0 - view.0) * a,
                    view.1 + (target.1 - view.1) * a,
                )
            }
        }
    }
}
/// Assez pour toutes les régions auto d'un clip ; au-delà, la plus ancienne est rejouée.
const VIEW_CACHE_LEN: usize = 32;

/// Interpolation linéaire dans une liste `(t, x, y)` triée ; saturation aux bornes.
fn sample_at(samples: &[(f32, f32, f32)], t: f32) -> Option<(f32, f32)> {
    if samples.is_empty() {
        return None;
    }
    if t <= samples[0].0 {
        let s = samples[0];
        return Some((s.1, s.2));
    }
    if t >= samples[samples.len() - 1].0 {
        let s = *samples.last().unwrap();
        return Some((s.1, s.2));
    }
    // recherche du segment encadrant
    let i = samples.partition_point(|s| s.0 <= t);
    let a = samples[i - 1];
    let b = samples[i];
    let f = if b.0 > a.0 {
        (t - a.0) / (b.0 - a.0)
    } else {
        0.0
    };
    Some((a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f))
}

/// Port de `advanceFollowFocus` (`cursorFollowUtils.ts`) : lissage exponentiel dont le facteur
/// croît avec la distance à la cible (loin = rattrape vite, près = décélère), corrigé en temps
/// pour être indépendant de la cadence.
///
/// La version TS est **séquentielle** : elle avance un `prev` d'une frame à l'autre. Rejouer ça
/// par frame ici ferait dépendre l'image du chemin parcouru pour l'atteindre — deux rendus du
/// même instant divergeraient selon qu'on y arrive en lecture ou par un seek, et la preview ne
/// correspondrait plus à l'export. On applique donc le même filtre UNE fois, sur les
/// échantillons de télémétrie eux-mêmes : le résultat est identique en lecture linéaire et reste
/// une pure fonction de `t`.
fn smooth_follow_samples(samples: &[(f32, f32, f32)]) -> Vec<(f32, f32, f32)> {
    let mut smoothed: Vec<(f32, f32, f32)> = Vec::with_capacity(samples.len());
    let mut prev: Option<(f32, f32, f32)> = None;
    for &(t, x, y) in samples {
        let Some((prev_t, px, py)) = prev else {
            smoothed.push((t, x, y));
            prev = Some((t, x, y));
            continue;
        };
        let dt_ms = (t - prev_t) * 1000.0;
        if !(dt_ms > 0.0) {
            // Horodatages dupliqués : on garde la valeur déjà lissée plutôt que de diviser par 0.
            smoothed.push((t, px, py));
            prev = Some((t, px, py));
            continue;
        }
        let (nx, ny) = follow_step((px, py), (x, y), dt_ms);
        smoothed.push((t, nx, ny));
        prev = Some((t, nx, ny));
    }
    smoothed
}

/// Un pas du lissage de suivi : `from` avance vers `to` d'un facteur qui croît avec la distance
/// (loin = rattrape vite, près = décélère), corrigé en temps sur `dt_ms`.
fn follow_step(from: (f32, f32), to: (f32, f32), dt_ms: f32) -> (f32, f32) {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let distance = (dx * dx + dy * dy).sqrt();
    let ramp = (distance / AUTO_FOLLOW_RAMP_DISTANCE).min(1.0);
    let base = AUTO_FOLLOW_MIN_FACTOR + (AUTO_FOLLOW_MAX_FACTOR - AUTO_FOLLOW_MIN_FACTOR) * ramp;
    let factor = 1.0 - (1.0 - base).powf(dt_ms / AUTO_FOLLOW_REFERENCE_MS);
    (from.0 + dx * factor, from.1 + dy * factor)
}

impl CursorTrack {
    /// Seul point de construction : garantit que `follow_samples` est toujours dérivé des
    /// échantillons courants. Une piste re-lissée (`smoothed`) recalcule donc aussi son suivi,
    /// pour que la caméra suive la trajectoire que l'utilisateur voit réellement.
    pub(crate) fn new(
        samples: Vec<(f32, f32, f32)>,
        clicks: Vec<f32>,
        types: Vec<(f32, String)>,
    ) -> CursorTrack {
        CursorTrack::new_with_visibility(samples, clicks, types, Vec::new())
    }

    pub(crate) fn new_with_visibility(
        samples: Vec<(f32, f32, f32)>,
        clicks: Vec<f32>,
        types: Vec<(f32, String)>,
        visibility: Vec<(f32, bool)>,
    ) -> CursorTrack {
        let follow_samples = smooth_follow_samples(&samples);
        let click_points = clicks
            .iter()
            .map(|&tc| sample_at(&samples, tc).unwrap_or((0.0, 0.0)))
            .collect();
        CursorTrack {
            samples,
            follow_samples,
            clicks,
            click_points,
            visibility,
            types,
            view_cache: Default::default(),
        }
    }

    /// Visibilité enregistrée au temps `t`. Les anciens sidecars qui n'ont pas ce champ sont
    /// visibles par défaut, comme les lecteurs TypeScript.
    pub fn visible_at(&self, t: f32) -> bool {
        let i = self.visibility.partition_point(|(tc, _)| *tc <= t);
        if i == 0 {
            true
        } else {
            self.visibility[i - 1].1
        }
    }

    /// État du curseur au temps `t` : la dernière transition à `t` ou avant. `None` avant la
    /// première (enregistrement sans état tagué → l'appelant retombe sur la flèche).
    pub fn type_at(&self, t: f32) -> Option<&str> {
        let i = self.types.partition_point(|(tc, _)| *tc <= t);
        (i > 0).then(|| self.types[i - 1].1.as_str())
    }

    /// Nombre d'échantillons de la piste (utile au diag de chargement).
    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    /// Charge la fenêtre [offset_ms, offset_ms + dur_s*1000] et la ramène à t=0.
    pub fn load(path: &str, offset_ms: f64, dur_s: f64) -> Result<CursorTrack> {
        let txt = std::fs::read_to_string(path).with_context(|| format!("lecture {path}"))?;
        let v: serde_json::Value = serde_json::from_str(&txt)?;
        let arr = v["samples"].as_array().context("samples[]")?;
        let mut samples = Vec::new();
        let mut clicks = Vec::new();
        let mut types: Vec<(f32, String)> = Vec::new();
        let mut visibility_at_offset = true;
        let mut visibility_sample_time = f64::NEG_INFINITY;
        // A clipped track inherits the last recorded state at its source offset. Using the first
        // later sample would reveal a cursor early when that sample is the transition to visible.
        for s in arr {
            let tm = s["timeMs"].as_f64().unwrap_or(-1.0);
            if tm >= 0.0 && tm <= offset_ms && tm >= visibility_sample_time {
                visibility_sample_time = tm;
                visibility_at_offset = s
                    .get("visible")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(true);
            }
        }
        let mut visibility = vec![(0.0, visibility_at_offset)];
        let end = offset_ms + dur_s * 1000.0;
        for s in arr {
            let tm = s["timeMs"].as_f64().unwrap_or(-1.0);
            if tm < offset_ms || tm > end {
                continue;
            }
            let t = ((tm - offset_ms) / 1000.0) as f32;
            let cx = s["cx"].as_f64().unwrap_or(0.0) as f32;
            let cy = s["cy"].as_f64().unwrap_or(0.0) as f32;
            samples.push((t, cx, cy));
            let visible = s
                .get("visible")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            if visibility.last().map(|(_, previous)| *previous) != Some(visible) {
                visibility.push((t, visible));
            }
            if visible && s["interactionType"].as_str() == Some("click") {
                clicks.push((t, (cx, cy)));
            }
            // Seules les TRANSITIONS sont retenues — voir `types`. Le helper
            // macOS rend nil hors texte/pointeur pour que le rendu retombe sur
            // la flèche. Le sidecar stocke ça en JSON null ou omet la clé.
            // Ignorer ces échantillons gardait le dernier type sémantique
            // (`pointer`/`text`) : un thème restait collé après le retour à la
            // flèche. Null / absence = reset vers `arrow`.
            let ct = match s.get("cursorType") {
                Some(v) => v
                    .as_str()
                    .filter(|label| !label.is_empty())
                    .unwrap_or("arrow"),
                None => "arrow",
            };
            if types.last().map(|(_, prev)| prev.as_str()) != Some(ct) {
                types.push((t, ct.to_string()));
            }
        }
        // The pointer between the samples: `[timeMs, cx, cy]` points the Windows sampler reads at
        // ~120 Hz while the cursor moves (absent from older sidecars, and from other platforms).
        // Positions only: visibility, clicks and cursor states stay those of `samples`.
        if let Some(path) = v["path"].as_array() {
            for point in path {
                let Some([tm, cx, cy]) = point.as_array().and_then(|p| {
                    Some([p.first()?.as_f64()?, p.get(1)?.as_f64()?, p.get(2)?.as_f64()?])
                }) else {
                    continue;
                };
                if tm < offset_ms || tm > end {
                    continue;
                }
                samples.push((((tm - offset_ms) / 1000.0) as f32, cx as f32, cy as f32));
            }
        }
        samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        clicks.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        types.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        visibility.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let (click_times, click_points): (Vec<f32>, Vec<(f32, f32)>) = clicks.into_iter().unzip();
        // Each click lands on the point its own sample recorded (the hook's), not on whatever
        // the merged track interpolates to at that instant.
        Ok(CursorTrack {
            click_points,
            ..CursorTrack::new_with_visibility(samples, click_times, types, visibility)
        })
    }

    /// Position lissée au temps `t`, pour le suivi auto du zoom. La télémétrie brute est
    /// échantillonnée trop finement pour piloter une caméra directement : la suivre au sample
    /// près donne un pan nerveux. Voir `smooth_follow_samples`.
    pub fn follow_at(&self, t: f32) -> Option<(f32, f32)> {
        sample_at(&self.follow_samples, t)
    }

    /// Le centre de la vue d'un zoom auto d'échelle `scale` à `t`, parti de `follow_at(t0)` en
    /// `t0` : `follow_at` avec une zone morte. La vue ne bouge pas tant que le pointeur reste dans
    /// la part `FOLLOW_DEAD_ZONE` de sa largeur autour de son centre ; il en sort, elle le
    /// rattrape avec le même lissage, juste assez pour le ramener au bord de la zone. Bornée à ce
    /// qu'une vue de `1/scale` peut atteindre, pour que la zone se mesure contre la vue affichée.
    ///
    /// Rejouée depuis `t0` sur les échantillons BRUTS, puis mise en cache jusqu'à `t_end` : une
    /// fonction pure de `(t0, t, t_end)`, donc la même en preview et à l'export, après un seek
    /// comme en lecture. Le cache ne garde rien après la fenêtre de la région.
    pub fn follow_in_view(&self, t0: f32, t: f32, t_end: f32, scale: f32) -> Option<(f32, f32)> {
        self.view_at(ViewLaw::Classic, t0, t, t_end, scale)
    }

    /// The view of an AUTOMATIC zoom under a following focus mode (`resolve_focus`): like
    /// `follow_in_view`, but it starts on `start` (the planned focus) instead of on the pointer,
    /// holds still while the pointer stays inside `dead_zone` of the view, per axis, and once it
    /// leaves re-frames exponentially with time constant `tau_s`, just far enough to bring the
    /// pointer back to the edge of that zone. A wide zone and a slow `tau_s` give the "hybrid"
    /// camera, a narrow one the smooth follow. Same purity and cache as `follow_in_view`.
    /// Mirror of `followViewAt` (TS, `cursorFollowUtils.ts`).
    #[allow(clippy::too_many_arguments)]
    pub fn follow_view(
        &self,
        start: (f32, f32),
        t0: f32,
        t: f32,
        t_end: f32,
        scale: f32,
        dead_zone: f32,
        tau_s: f32,
    ) -> Option<(f32, f32)> {
        let law = ViewLaw::Calm {
            start,
            dead_zone: dead_zone.clamp(0.0, 1.0),
            tau_s: tau_s.max(1e-3),
        };
        self.view_at(law, t0, t, t_end, scale)
    }

    fn view_at(
        &self,
        law: ViewLaw,
        t0: f32,
        t: f32,
        t_end: f32,
        scale: f32,
    ) -> Option<(f32, f32)> {
        let t_end = t_end.max(t0);
        let t = t.clamp(t0, t_end);
        let states = self.view_states(law, t0, t_end, scale)?;
        let half = 0.5 / scale.max(1.0);
        let reach = |v: f32| v.clamp(half, 1.0 - half);
        // Après le dernier échantillon, la vue continue de rattraper le pointeur resté immobile
        // jusqu'au bord de la zone, au lieu de se figer à mi-course.
        let &(at, vx, vy) = states.last()?;
        if t > at {
            let (_, x, y) = *self.samples.last()?;
            let (nx, ny) = law.step((vx, vy), (x, y), (t - at) * 1000.0, half);
            return Some((reach(nx), reach(ny)));
        }
        if states.len() == 1 {
            return Some((vx, vy));
        }
        // Entre deux états, linéaire, comme `follow_at`.
        let i = states.partition_point(|s| s.0 < t).max(1);
        let (a, b) = (states[i - 1], states[i]);
        let f = if b.0 > a.0 {
            ((t - a.0) / (b.0 - a.0)).clamp(0.0, 1.0)
        } else {
            1.0
        };
        Some((a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f))
    }

    /// Les états `(t, x, y)` de `t0` à la fin de la fenêtre d'une région. Le dernier point est
    /// interpolé à `t_end` si le curseur a encore des échantillons après cette fenêtre.
    fn view_states(
        &self,
        law: ViewLaw,
        t0: f32,
        t_end: f32,
        scale: f32,
    ) -> Option<std::sync::Arc<Vec<(f32, f32, f32)>>> {
        let t_end = t_end.max(t0);
        let key = law.key(t0, t_end, scale);
        if let Some((_, v)) = self.view_cache.lock().ok()?.iter().find(|(k, _)| *k == key) {
            return Some(v.clone());
        }
        let half = 0.5 / scale.max(1.0);
        let reach = |v: f32| v.clamp(half, 1.0 - half);
        let (x0, y0) = match law {
            ViewLaw::Classic => self.follow_at(t0)?,
            // Not on the pointer: the planned focus, which a track without samples cannot move.
            ViewLaw::Calm { start, .. } => {
                self.samples.first()?;
                start
            }
        };
        let mut view = (reach(x0), reach(y0));
        let mut states = vec![(t0, view.0, view.1)];
        let first = self.samples.partition_point(|s| s.0 <= t0);
        let end = self.samples.partition_point(|s| s.0 <= t_end);
        for &(ts, x, y) in &self.samples[first..end] {
            let at = states.last().map_or(t0, |s| s.0);
            let (nx, ny) = law.step(view, (x, y), (ts - at) * 1000.0, half);
            view = (reach(nx), reach(ny));
            states.push((ts, view.0, view.1));
        }
        let at = states.last().map_or(t0, |s| s.0);
        if at < t_end {
            if let Some(&(ts, x, y)) = self.samples.get(end) {
                let (nx, ny) = law.step(view, (x, y), (ts - at) * 1000.0, half);
                let f = ((t_end - at) / (ts - at)).clamp(0.0, 1.0);
                states.push((
                    t_end,
                    view.0 + (nx - view.0) * f,
                    view.1 + (ny - view.1) * f,
                ));
            }
        }
        let states = std::sync::Arc::new(states);
        let mut cache = self.view_cache.lock().ok()?;
        if cache.len() >= VIEW_CACHE_LEN {
            cache.remove(0);
        }
        cache.push((key, states.clone()));
        Some(states)
    }

    /// Position (cx, cy) au temps `t` (interpolation linéaire), ou None si hors piste. Brute, sauf
    /// sur une piste `smoothed()`.
    pub fn at(&self, t: f32) -> Option<(f32, f32)> {
        sample_at(&self.samples, t)
    }

    /// `at(t)`, ramenée sur la position brute de chaque clic autour de lui : la pointe du curseur
    /// modélisé doit toucher le pixel cliqué pendant tout son appui, alors que la piste (lissée ou
    /// brute) dérive pendant le contact dès que la souris repart. La piste lissée passe déjà par le
    /// point cliqué à l'instant du clic (`smoothed`).
    ///
    /// Pour chaque clic `tc`, un poids vers son point : il monte en smoothstep sur
    /// `PIN_APPROACH_S`, vaut 1 sur `[tc, tc + PIN_HOLD_S]` (le contact), puis retombe en
    /// smoothstep sur `PIN_RELEASE_S`. Les clics s'appliquent dans l'ordre, le plus récent
    /// l'emporte. Continue et de pente continue en `t` ; hors de ces fenêtres, `at(t)` à l'identique.
    pub fn pinned_at(&self, t: f32) -> Option<(f32, f32)> {
        let (mut x, mut y) = self.at(t)?;
        let lo = self
            .clicks
            .partition_point(|&tc| tc <= t - PIN_HOLD_S - PIN_RELEASE_S);
        let hi = self.clicks.partition_point(|&tc| tc < t + PIN_APPROACH_S);
        for i in lo..hi.max(lo) {
            let d = t - self.clicks[i];
            let w = if d < 0.0 {
                smoothstep01(1.0 + d / PIN_APPROACH_S)
            } else {
                1.0 - smoothstep01((d - PIN_HOLD_S) / PIN_RELEASE_S)
            };
            let (cx, cy) = self.click_points[i];
            (x, y) = if w >= 1.0 {
                (cx, cy)
            } else {
                (x + (cx - x) * w, y + (cy - y) * w)
            };
        }
        Some((x, y))
    }

    /// Les clics de `(lo, hi]` avec leur position brute, triés.
    pub fn clicks_with_points(
        &self,
        lo: f32,
        hi: f32,
    ) -> impl Iterator<Item = (f32, (f32, f32))> + '_ {
        let a = self.clicks.partition_point(|&tc| tc <= lo);
        let b = self.clicks.partition_point(|&tc| tc <= hi).max(a);
        self.clicks[a..b]
            .iter()
            .copied()
            .zip(self.click_points[a..b].iter().copied())
    }

    /// Facteur d'échelle « click bounce ». Cette fonction est la SEULE référence de la courbe :
    /// son ancien jumeau TS (`nativeCursor.ts`) a été supprimé avec pixi.js, et
    /// `scripts/inspect-native-cursor-click-bounce.mjs` ne fait que la recopier. Le curseur
    /// PRESSE (rétrécit jusqu'à 0.76, 0..38% de la fenêtre d'animation) PUIS REBONDIT (grossit
    /// jusqu'à 1.16, 38..100%), pas un simple pop qui ne fait que grossir puis redécroître. Seul le clic le
    /// plus récent précédant `t` compte (au-delà de la fenêtre, un clic antérieur n'a plus
    /// aucun effet — contrairement à l'ancienne décroissance exponentielle à queue infinie qui
    /// masquait ce bug). L'amplitude utilisateur (clickBounce) s'applique dans `plan_cursor`.
    pub fn bounce(&self, t: f32) -> f32 {
        const ANIM_S: f32 = 0.26; // 260 ms
        const PRESS_FRAC: f32 = 0.38;
        let Some(tc) = self.last_click_at(t) else {
            return 1.0;
        };
        let elapsed = (t - tc) / ANIM_S;
        if elapsed >= 1.0 {
            return 1.0;
        }
        if elapsed < PRESS_FRAC {
            let press = (elapsed / PRESS_FRAC * std::f32::consts::PI).sin();
            1.0 - press * 0.24
        } else {
            let rebound =
                ((elapsed - PRESS_FRAC) / (1.0 - PRESS_FRAC) * std::f32::consts::PI).sin();
            1.0 + rebound * 0.16
        }
    }

    /// L'instant du dernier clic à `t` ou avant, `None` s'il n'y en a pas. C'est le point de
    /// départ commun du rebond d'échelle (`bounce`) et de l'abaissement de la hauteur du curseur
    /// modélisé — les deux doivent lire le MÊME contact, sinon le sprite s'écrase et se pose à
    /// deux instants différents. Les clics sont triés croissant (voir `CursorTrack::new`).
    pub(crate) fn last_click_at(&self, t: f32) -> Option<f32> {
        let i = self.clicks.partition_point(|&tc| tc <= t);
        if i == 0 {
            return None;
        }
        Some(self.clicks[i - 1])
    }

    /// Les instants de clic dans `(lo, hi]`, triés. L'impact du clic sur le plan
    /// (`regions::click_impact`) les somme tous, là où `bounce` ne garde que le dernier.
    pub fn clicks_between(&self, lo: f32, hi: f32) -> &[f32] {
        let a = self.clicks.partition_point(|&tc| tc <= lo);
        let b = self.clicks.partition_point(|&tc| tc <= hi);
        &self.clicks[a..b.max(a)]
    }

    /// The track as drawn at smoothing `factor` (the raw slider value, 0..1; 0 returns a clone).
    ///
    /// Zero-phase: the whole path is known, so each point is the centred Gaussian average of the
    /// raw path around it (`SMOOTHING_SIGMA_MAX_S` × `factor`), resampled on a 240 Hz grid. A
    /// pointer moving at any steady speed is drawn exactly where it is, at the time it is there;
    /// only tremor and the corners of the sampled path are rounded off. The spring this replaced
    /// trailed the pointer by its damping over its stiffness: 189 ms at the default 0.67, measured
    /// 198 ms behind the real pointer in an export of a real take.
    ///
    /// Each visible run is smoothed on its own, its ends held (a cursor that reappears starts on
    /// its first visible point), and each click is pulled back onto its raw point at its own
    /// instant (`pin_clicks`): the smoothed path passes exactly where the user clicked. Clicks and
    /// cursor states keep their raw instants. Mirrored by `cursorPathSmoothing.ts`.
    pub fn smoothed(&self, factor: f32) -> CursorTrack {
        let sigma = factor.clamp(0.0, 1.0) * SMOOTHING_SIGMA_MAX_S;
        if self.samples.len() < 2 || !(sigma > 0.0) {
            return CursorTrack {
                click_points: self.click_points.clone(),
                ..CursorTrack::new_with_visibility(
                    self.samples.clone(),
                    self.clicks.clone(),
                    self.types.clone(),
                    self.visibility.clone(),
                )
            };
        }
        let start = self.samples[0].0;
        let end = self.samples[self.samples.len() - 1].0;
        let step_count = (((end - start) / SMOOTHING_STEP_S).round() as usize).max(1);
        let n = step_count + 1;
        let mut times = Vec::with_capacity(n);
        let mut raw_x = Vec::with_capacity(n);
        let mut raw_y = Vec::with_capacity(n);
        for i in 0..n {
            let t = if i == n - 1 {
                end
            } else {
                start + i as f32 * SMOOTHING_STEP_S
            };
            let (cx, cy) = self.at(t).unwrap_or((0.0, 0.0));
            times.push(t);
            raw_x.push(cx);
            raw_y.push(cy);
        }
        let kernel = gaussian_kernel(sigma, SMOOTHING_STEP_S);
        let mut xs = Vec::with_capacity(n);
        let mut ys = Vec::with_capacity(n);
        let mut run_start = 0;
        while run_start < n {
            let visible = self.visible_at(times[run_start]);
            let mut run_end = run_start + 1;
            while run_end < n && self.visible_at(times[run_end]) == visible {
                run_end += 1;
            }
            xs.extend(gaussian_smooth(&raw_x[run_start..run_end], &kernel));
            ys.extend(gaussian_smooth(&raw_y[run_start..run_end], &kernel));
            run_start = run_end;
        }
        let mut samples: Vec<(f32, f32, f32)> = times
            .into_iter()
            .zip(xs)
            .zip(ys)
            .map(|((t, x), y)| (t, x, y))
            .collect();
        self.pin_clicks(&mut samples, 3.0 * sigma);
        CursorTrack {
            click_points: self.click_points.clone(),
            ..CursorTrack::new_with_visibility(
                samples,
                self.clicks.clone(),
                self.types.clone(),
                self.visibility.clone(),
            )
        }
    }

    /// Moves a smoothed track back onto each click's raw point at the click's instant. The offset
    /// there is applied in full and faded out over `reach` on both sides (smoothstep), so the
    /// motion keeps its shape; `reach` is the smoothing kernel's, past which the smoothed path
    /// already is the raw one. The instant itself becomes a point of the track, so the drawn
    /// cursor sits on the clicked pixel whatever the grid. Points of another visibility phase are
    /// left alone.
    fn pin_clicks(&self, samples: &mut Vec<(f32, f32, f32)>, reach: f32) {
        let reach = reach.max(SMOOTHING_STEP_S);
        let mut instants = Vec::with_capacity(self.clicks.len());
        for (&tc, &(cx, cy)) in self.clicks.iter().zip(&self.click_points) {
            let Some((sx, sy)) = sample_at(samples, tc) else {
                continue;
            };
            let (dx, dy) = (cx - sx, cy - sy);
            let visible = self.visible_at(tc);
            let lo = samples.partition_point(|s| s.0 < tc - reach);
            let hi = samples.partition_point(|s| s.0 <= tc + reach);
            for s in &mut samples[lo..hi] {
                if self.visible_at(s.0) != visible {
                    continue;
                }
                let w = 1.0 - smoothstep01((s.0 - tc).abs() / reach);
                s.1 += dx * w;
                s.2 += dy * w;
            }
            instants.push((tc, cx, cy));
        }
        // Merged once: an insert per click would move the whole track each time. The sort is
        // stable, so a click on a grid instant comes after it, and `sample_at` reads the click.
        samples.extend(instants);
        samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    }

    /// Opacité du curseur (0.0..1.0) selon l'inactivité (auto-hide).
    /// Si `auto_hide` est faux, retourne toujours 1.0.
    /// Si `auto_hide` est vrai :
    /// - Le curseur reste à 1.0 tant qu'il bouge ou clique, et pendant 1.5s après le dernier mouvement/clic.
    /// - Entre 1.5s et 1.8s d'inactivité, il s'estompe linéairement de 1.0 à 0.0 (fade-out 300ms).
    /// - Au-delà de 1.8s, opacité 0.0.
    pub fn opacity_at(&self, t: f32, auto_hide: bool) -> f32 {
        if !auto_hide || self.samples.is_empty() {
            return 1.0;
        }

        const IDLE_TIMEOUT_S: f32 = 1.5;
        const FADE_DURATION_S: f32 = 0.3;
        const MOVE_THRESH_SQ: f32 = 0.015 * 0.015;

        let last_click = match self.clicks.partition_point(|&tc| tc <= t) {
            0 => None,
            i => Some(self.clicks[i - 1]),
        };

        let (cx, cy) = match self.at(t) {
            Some(p) => p,
            None => return 1.0,
        };

        let idx = self.samples.partition_point(|s| s.0 <= t);
        let start_t = self.samples[0].0;

        let mut arrival_t = if idx > 0 {
            self.samples[idx - 1].0
        } else {
            start_t
        };

        if idx > 0 {
            let mut i = idx - 1;
            while i > 0 {
                let prev = self.samples[i - 1];
                let dx = cx - prev.1;
                let dy = cy - prev.2;
                if dx * dx + dy * dy > MOVE_THRESH_SQ {
                    arrival_t = self.samples[i].0;
                    break;
                }
                if t - prev.0 > IDLE_TIMEOUT_S + FADE_DURATION_S {
                    arrival_t = prev.0;
                    break;
                }
                i -= 1;
                if i == 0 {
                    arrival_t = start_t;
                }
            }
        }

        if idx > 1 {
            let s1 = self.samples[idx - 1];
            let s0 = self.samples[idx - 2];
            let d_step = (s1.1 - s0.1) * (s1.1 - s0.1) + (s1.2 - s0.2) * (s1.2 - s0.2);
            if d_step > 0.005 * 0.005 && (t - s1.0).abs() < 0.1 {
                arrival_t = t;
            }
        }

        let mut last_activity = arrival_t;
        if let Some(tc) = last_click {
            if tc > last_activity {
                last_activity = tc;
            }
        }

        let idle_time = (t - last_activity).max(0.0);
        if idle_time <= IDLE_TIMEOUT_S {
            1.0
        } else if idle_time >= IDLE_TIMEOUT_S + FADE_DURATION_S {
            0.0
        } else {
            1.0 - (idle_time - IDLE_TIMEOUT_S) / FADE_DURATION_S
        }
    }
}

/// An unnormalised Gaussian of spread `sigma`, sampled every `step` out to 3 sigma on each side.
fn gaussian_kernel(sigma: f32, step: f32) -> Vec<f32> {
    let radius = ((3.0 * sigma / step).ceil() as usize).max(1);
    (0..=2 * radius)
        .map(|i| {
            let d = (i as f32 - radius as f32) * step / sigma;
            (-0.5 * d * d).exp()
        })
        .collect()
}

/// Centred convolution of an evenly spaced series with `kernel` (odd length), each end held:
/// zero phase, so a ramp comes out where it went in.
fn gaussian_smooth(values: &[f32], kernel: &[f32]) -> Vec<f32> {
    let radius = kernel.len() / 2;
    let last = values.len().saturating_sub(1);
    let total: f32 = kernel.iter().sum();
    (0..values.len())
        .map(|i| {
            let mut sum = 0.0f32;
            for (j, w) in kernel.iter().enumerate() {
                let k = (i + j).saturating_sub(radius).min(last);
                sum += values[k] * w;
            }
            sum / total
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Zone morte du suivi auto : un pointeur qui tremble au centre de la vue ne la bouge pas ;
    /// un pointeur qui part loin est rattrapé, jusqu'au bord de la zone et pas au-delà.
    /// Les vues d'une région sont rejouées une fois puis relues : même réponse dans n'importe quel
    /// ordre, et la même qu'une piste neuve qui les rejoue.
    #[test]
    fn the_cached_follow_view_answers_like_a_fresh_replay() {
        let make = || {
            CursorTrack::new(
                (0..=150)
                    .map(|i| {
                        let t = i as f32 / 30.0;
                        (t, 0.5 + 0.3 * (t * 1.3).sin(), 0.5 + 0.2 * (t * 0.7).cos())
                    })
                    .collect(),
                vec![],
                vec![],
            )
        };
        let (cached, times) = (make(), [4.9f32, 0.2, 3.3, 0.0, 2.71, 4.0]);
        for t in times {
            let _ = cached.follow_in_view(0.4, t, 5.0, 2.0);
        }
        for t in times {
            assert_eq!(
                cached.follow_in_view(0.4, t, 5.0, 2.0),
                make().follow_in_view(0.4, t, 5.0, 2.0),
                "t {t}"
            );
        }
        // Une autre région (autre départ, autre échelle) a ses propres vues.
        assert_ne!(
            cached.follow_in_view(1.0, 3.0, 5.0, 3.0),
            cached.follow_in_view(0.4, 3.0, 5.0, 2.0)
        );
    }

    #[test]
    fn the_follow_view_cache_stops_at_its_region_end() {
        let track = CursorTrack::new(
            (0..=300)
                .map(|i| {
                    let t = i as f32 / 30.0;
                    (t, 0.5 + 0.2 * (t * 0.7).sin(), 0.5)
                })
                .collect(),
            vec![],
            vec![],
        );

        let at_end = track.follow_in_view(0.0, 2.0, 2.0, 2.0).unwrap();
        assert_eq!(track.follow_in_view(0.0, 8.0, 2.0, 2.0), Some(at_end));

        let cache = track.view_cache.lock().unwrap();
        let states = &cache[0].1;
        assert!(states.iter().all(|(t, _, _)| *t <= 2.0));
        assert_eq!(states.last().unwrap().0, 2.0);
    }

    /// Après le dernier échantillon, la vue continue de rattraper un pointeur immobile hors de la
    /// zone morte, jusqu'à son bord, au lieu de se figer.
    #[test]
    fn the_follow_view_keeps_settling_after_the_last_sample() {
        // Le pointeur saute à 0,8 au dernier échantillon (2 s) ; bord de la zone à ×2 : 0,675.
        let track = CursorTrack::new(
            (0..=60)
                .map(|i| (i as f32 / 30.0, if i == 60 { 0.8 } else { 0.5 }, 0.5))
                .collect(),
            vec![],
            vec![],
        );
        let at = |t: f32| track.follow_in_view(0.0, t, 9.0, 2.0).unwrap().0;
        assert!(
            at(2.0) < at(2.5) && at(2.5) < at(4.0),
            "{} {} {}",
            at(2.0),
            at(2.5),
            at(4.0)
        );
        assert!((at(8.0) - 0.675).abs() < 1e-3, "{}", at(8.0));
    }

    #[test]
    fn the_auto_follow_holds_still_inside_its_dead_zone() {
        // ×2 : vue de 0,5, zone morte de ±0,125 autour de son centre.
        let track = |f: fn(f32) -> f32| {
            CursorTrack::new(
                (0..=300)
                    .map(|i| {
                        let t = i as f32 / 30.0;
                        (t, f(t), 0.5)
                    })
                    .collect(),
                vec![],
                vec![],
            )
        };
        let jitter = track(|t| 0.5 + 0.08 * (t * 7.0).sin());
        for i in 0..=90 {
            let (x, y) = jitter
                .follow_in_view(0.0, i as f32 / 10.0, 9.0, 2.0)
                .unwrap();
            assert!(
                (x - 0.5).abs() < 1e-6 && (y - 0.5).abs() < 1e-6,
                "t {} : {x}",
                i as f32 / 10.0
            );
        }
        // Sans zone morte, le suivi lissé, lui, tremble.
        let swing = (0..=90)
            .map(|i| jitter.follow_at(i as f32 / 10.0).unwrap().0)
            .fold(0.0f32, |m, x| m.max((x - 0.5).abs()));
        assert!(swing > 0.02, "{swing}");

        // Un saut à 0,8 à 2 s : la vue rattrape jusqu'à laisser le pointeur au bord de la zone.
        let jump = track(|t| if t < 2.0 { 0.5 } else { 0.8 });
        let settled = jump.follow_in_view(0.0, 9.0, 9.0, 2.0).unwrap().0;
        assert!((settled - (0.8 - 0.125)).abs() < 1e-3, "{settled}");
        let early = jump.follow_in_view(0.0, 2.1, 9.0, 2.0).unwrap().0;
        assert!(
            early > 0.5 && early < settled,
            "rattrapage progressif : {early}"
        );
        // Une pure fonction de (t0, t, t_end) : l'ordre des appels ne change rien.
        assert_eq!(jump.follow_in_view(0.0, 2.1, 9.0, 2.0).unwrap().0, early);
    }

    /// L'état du curseur est une fonction en escalier : il tient jusqu'à la transition
    /// suivante, il n'est pas interpolé, et avant la première il n'y en a pas.
    #[test]
    fn cursor_type_holds_until_the_next_transition() {
        let track = CursorTrack::new(
            vec![(0.0, 0.0, 0.0), (2.0, 1.0, 1.0)],
            vec![],
            vec![
                (0.5, "arrow".into()),
                (1.0, "text".into()),
                (1.5, "pointer".into()),
            ],
        );

        assert_eq!(track.type_at(0.0), None, "avant la première transition");
        assert_eq!(
            track.type_at(0.5),
            Some("arrow"),
            "à l'instant même de la transition"
        );
        assert_eq!(
            track.type_at(0.9),
            Some("arrow"),
            "tient jusqu'à la suivante"
        );
        assert_eq!(track.type_at(1.2), Some("text"));
        assert_eq!(
            track.type_at(99.0),
            Some("pointer"),
            "la dernière tient jusqu'à la fin"
        );
    }

    /// Le lissage déplace la trajectoire, pas la chronologie : les états doivent survivre
    /// intacts à `smoothed()`, comme les clics.
    #[test]
    fn smoothing_preserves_cursor_types() {
        let track = CursorTrack::new(
            vec![(0.0, 0.0, 0.0), (0.5, 0.4, 0.4), (1.0, 1.0, 1.0)],
            vec![0.25],
            vec![(0.0, "arrow".into()), (0.6, "text".into())],
        );

        let smoothed = track.smoothed(0.4);
        assert_eq!(smoothed.type_at(0.1), Some("arrow"));
        assert_eq!(smoothed.type_at(0.7), Some("text"));
    }

    #[test]
    fn load_preserves_hidden_intervals_and_ignores_hidden_clicks() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "openscreen-cursor-visibility-{}-{}.json",
            std::process::id(),
            unique
        ));
        std::fs::write(
            &path,
            r#"{"samples":[
                {"timeMs":0,"cx":0.1,"cy":0.1,"visible":true},
                {"timeMs":100,"cx":0.2,"cy":0.2,"visible":false,"interactionType":"click"},
                {"timeMs":600,"cx":0.9,"cy":0.9,"visible":true,"interactionType":"click"}
            ]}"#,
        )
        .expect("write temp sidecar");
        let path_str = path.to_str().expect("utf-8 temp path");
        let track = CursorTrack::load(path_str, 0.0, 1.0).expect("load sidecar");
        let clipped = CursorTrack::load(path_str, 200.0, 0.5).expect("load clipped sidecar");
        let _ = std::fs::remove_file(&path);

        assert!(track.visible_at(0.0));
        assert!(!track.visible_at(0.1));
        assert!(!track.visible_at(0.59));
        assert!(track.visible_at(0.6));
        assert_eq!(
            track.clicks,
            vec![0.6],
            "le clic masqué ne doit pas animer le curseur"
        );
        assert!(
            !clipped.visible_at(0.0),
            "la fenêtre commence dans la phase masquée"
        );
        assert!(
            !clipped.visible_at(0.39),
            "l'état masqué tient jusqu'à la transition"
        );
        assert!(
            clipped.visible_at(0.4),
            "la transition visible garde son temps relatif"
        );

        let smoothed = track.smoothed(0.5);
        assert!(
            !smoothed.visible_at(0.3),
            "le lissage garde la phase masquée"
        );
        assert!(smoothed.visible_at(0.6));
        let reappeared = smoothed.at(0.6).expect("position at reappearance");
        assert!(
            (reappeared.0 - 0.9).abs() < 0.02 && (reappeared.1 - 0.9).abs() < 0.02,
            "the smoothing restarts on the visible point, with no trail: {reappeared:?}"
        );
    }

    #[test]
    fn legacy_tracks_without_visibility_stay_visible() {
        let track = CursorTrack::new(vec![(0.0, 0.1, 0.1), (1.0, 0.9, 0.9)], vec![], vec![]);
        assert!(track.visible_at(0.0));
        assert!(track.visible_at(0.5));
        assert!(track.visible_at(10.0));
    }

    /// JSON null et une clé `cursorType` absente resetent vers la flèche,
    /// au lieu de garder le dernier `pointer`/`text`.
    #[test]
    fn null_cursor_type_resets_to_arrow() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "openscreen-cursor-null-reset-{}-{}.json",
            std::process::id(),
            unique
        ));
        std::fs::write(
            &path,
            r#"{"samples":[
                {"timeMs":0,"cx":0.1,"cy":0.1,"cursorType":"pointer"},
                {"timeMs":100,"cx":0.2,"cy":0.2,"cursorType":null},
                {"timeMs":200,"cx":0.3,"cy":0.3,"cursorType":"pointer"},
                {"timeMs":300,"cx":0.4,"cy":0.4}
            ]}"#,
        )
        .expect("write temp sidecar");
        let path_str = path.to_str().expect("utf-8 temp path");
        let track = CursorTrack::load(path_str, 0.0, 1.0).expect("load sidecar");
        let _ = std::fs::remove_file(&path);

        assert_eq!(track.type_at(0.00), Some("pointer"));
        assert_eq!(
            track.type_at(0.10),
            Some("arrow"),
            "JSON null must reset to arrow"
        );
        assert_eq!(
            track.type_at(0.20),
            Some("pointer"),
            "pointer after null must hold until the omitted-key sample"
        );
        assert_eq!(
            track.type_at(0.30),
            Some("arrow"),
            "omitted cursorType after pointer must reset to arrow independently"
        );
    }

    /// `pinned_at` pose le curseur sur le point BRUT du clic pendant le contact, même quand la
    /// piste lissée traîne loin derrière, reste continue, et rend `at()` loin des clics.
    #[test]
    fn the_pinned_position_holds_the_raw_click_point() {
        // Un geste rapide de 0,1 à 0,7 qui s'arrête pile sur le clic, puis repart vers le bas.
        let samples: Vec<(f32, f32, f32)> = (0..=60)
            .map(|k| {
                let t = k as f32 / 30.0;
                let x = 0.1 + 0.6 * (t / 1.0).min(1.0);
                let y = 0.5 + 0.3 * ((t - 1.0) / 0.3).clamp(0.0, 1.0);
                (t, x, y)
            })
            .collect();
        let raw = CursorTrack::new(samples, vec![1.0], vec![]);
        let clicked = raw.at(1.0).unwrap();
        for track in [raw.smoothed(0.0), raw.smoothed(0.5), raw.smoothed(1.0)] {
            let lag = track.at(1.0).unwrap();
            for ms in 0..=100 {
                let t = 1.0 + ms as f32 / 1000.0;
                assert_eq!(track.pinned_at(t), Some(clicked), "{ms} ms après le clic");
            }
            // Loin des clics : la piste telle quelle.
            for t in [0.5, 0.74, 1.36, 1.8] {
                assert_eq!(track.pinned_at(t), track.at(t), "t = {t}");
            }
            // Continue : pas de saut d'une milliseconde à l'autre.
            for k in 0..2000 {
                let (a, b) = (
                    track.pinned_at(k as f32 * 0.001).unwrap(),
                    track.pinned_at((k + 1) as f32 * 0.001).unwrap(),
                );
                assert!(
                    (a.0 - b.0).abs() < 4e-3 && (a.1 - b.1).abs() < 4e-3,
                    "saut en {k} ms : {a:?} -> {b:?}"
                );
            }
            println!("au clic, piste en {lag:?}, point cliqué {clicked:?}");
        }
        // The smoothed track already passes through the clicked point at the click.
        for factor in [0.5, 1.0] {
            assert_eq!(raw.smoothed(factor).at(1.0), Some(clicked), "smoothing {factor}");
        }
    }

    /// When a track first reaches `x` (interpolated between its points), at or after `from`.
    fn first_reach(track: &CursorTrack, x: f32, from: f32) -> f32 {
        let mut t = from;
        while track.at(t).unwrap().0 < x {
            t += 1e-4;
            assert!(t < from + 10.0, "never reaches {x}");
        }
        t
    }

    /// The smoothing has no phase lag: a pointer crossing the screen at a steady speed is drawn
    /// where it is, when it is there, at every strength. The spring it replaced was 189 ms late
    /// at the default strength.
    #[test]
    fn a_steady_ramp_is_drawn_without_lag() {
        // 0.1 -> 0.9 in 2 s (768 px/s at 1080p width), sampled at 30 Hz like the sidecar.
        let raw = CursorTrack::new(
            (0..=90)
                .map(|k| {
                    let t = k as f32 / 30.0;
                    (t, (0.1 + 0.4 * t).min(0.9), 0.5)
                })
                .collect(),
            vec![],
            vec![],
        );
        for factor in [0.1, 0.3, 0.67, 1.0] {
            let drawn = raw.smoothed(factor);
            for x in [0.3, 0.5, 0.7] {
                let lag_ms = (first_reach(&drawn, x, 0.0) - first_reach(&raw, x, 0.0)) * 1000.0;
                assert!(lag_ms.abs() < 0.5, "smoothing {factor}, x {x}: {lag_ms} ms");
            }
            for k in 20..=170 {
                let t = k as f32 / 100.0;
                let (a, b) = (drawn.at(t).unwrap(), raw.at(t).unwrap());
                assert!((a.0 - b.0).abs() < 1e-4, "smoothing {factor} at {t}: {a:?} vs {b:?}");
            }
        }
    }

    /// The smoothing rounds a corner symmetrically: the drawn cursor turns as much before the
    /// real turn as after it, it never trails the turn, and it stops where the pointer stopped.
    #[test]
    fn a_stop_is_reached_where_and_when_it_happens() {
        // Moves right until 1 s, then holds still.
        let raw = CursorTrack::new(
            (0..=60)
                .map(|k| {
                    let t = k as f32 / 30.0;
                    (t, 0.1 + 0.5 * t.min(1.0), 0.5)
                })
                .collect(),
            vec![],
            vec![],
        );
        let drawn = raw.smoothed(1.0);
        // Symmetric about the stop: as far behind before it as it is short after it.
        let before = 0.6 - drawn.at(0.97).unwrap().0 - (0.6 - raw.at(0.97).unwrap().0);
        let after = 0.6 - drawn.at(1.03).unwrap().0;
        assert!((before - after).abs() < 1e-3, "before {before}, after {after}");
        // 3 sigma after the stop, exactly on it.
        assert!((drawn.at(1.0 + 3.0 * SMOOTHING_SIGMA_MAX_S + 0.005).unwrap().0 - 0.6).abs() < 1e-4);
    }

    /// A click in the middle of a fast stroke: the smoothed path passes through the raw clicked
    /// point at the click's instant, at every strength, and stays continuous around it.
    #[test]
    fn the_smoothed_path_passes_through_every_click() {
        // A zigzag, so the smoothing has corners to round at the clicks, sampled at 30 Hz.
        let samples: Vec<(f32, f32, f32)> = (0..=60)
            .map(|k| {
                let t = k as f32 / 30.0;
                let tri = 1.0 - (2.0 * (t * 2.5).fract() - 1.0).abs();
                (t, 0.2 + 0.6 * tri, 0.3 + 0.2 * t)
            })
            .collect();
        // Clicks on a corner, mid-stroke and between two samples.
        let clicks = vec![0.4, 0.55, 1.2345];
        let raw = CursorTrack::new(samples, clicks.clone(), vec![]);
        for factor in [0.3, 0.67, 1.0] {
            let drawn = raw.smoothed(factor);
            for &tc in &clicks {
                assert_eq!(drawn.at(tc), raw.at(tc), "smoothing {factor}, click at {tc}");
            }
            for k in 0..1999 {
                let (a, b) = (
                    drawn.at(k as f32 * 0.001).unwrap(),
                    drawn.at((k + 1) as f32 * 0.001).unwrap(),
                );
                assert!(
                    (a.0 - b.0).abs() < 4e-3 && (a.1 - b.1).abs() < 4e-3,
                    "jump at {k} ms: {a:?} -> {b:?}"
                );
            }
        }
    }

    fn write_temp_sidecar(tag: &str, json: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "openscreen-cursor-{tag}-{}-{}.json",
            std::process::id(),
            unique
        ));
        std::fs::write(&path, json).expect("write temp sidecar");
        path
    }

    /// A sidecar from before the fine path loads exactly as it did: positions from `samples`.
    /// One with a `path` fills in between the samples, while visibility, clicks and their points
    /// still come from the samples.
    #[test]
    fn the_fine_path_fills_in_between_samples_and_old_sidecars_are_unchanged() {
        let samples = r#"
            {"timeMs":0,"cx":0.1,"cy":0.1,"visible":true},
            {"timeMs":40,"cx":0.3,"cy":0.1,"visible":true,"interactionType":"click"},
            {"timeMs":80,"cx":0.5,"cy":0.1,"visible":false},
            {"timeMs":120,"cx":0.5,"cy":0.5,"visible":true}"#;
        let old = write_temp_sidecar("old", &format!(r#"{{"samples":[{samples}]}}"#));
        let fine = write_temp_sidecar(
            "fine",
            &format!(
                r#"{{"samples":[{samples}],"path":[[10,0.2,0.15],[20,0.24,0.2],[40,0.31,0.1],[60,0.4,0.12],"bad",[70]]}}"#
            ),
        );
        let old_track = CursorTrack::load(old.to_str().unwrap(), 0.0, 1.0).expect("old sidecar");
        let fine_track = CursorTrack::load(fine.to_str().unwrap(), 0.0, 1.0).expect("fine sidecar");
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::remove_file(&fine);

        // Old: linear between the samples, as before.
        assert_eq!(old_track.sample_count(), 4);
        let mid = old_track.at(0.02).unwrap();
        assert!((mid.0 - 0.2).abs() < 1e-6 && (mid.1 - 0.1).abs() < 1e-6, "{mid:?}");
        // Fine: the path points are drawn, malformed entries skipped.
        assert_eq!(fine_track.sample_count(), 8);
        assert_eq!(fine_track.at(0.02), Some((0.24, 0.2)));
        assert_eq!(fine_track.at(0.06), Some((0.4, 0.12)));
        // The click keeps its own recorded point, not the path point at the same instant.
        assert_eq!(fine_track.clicks, vec![0.04]);
        assert_eq!(fine_track.click_points, vec![(0.3, 0.1)]);
        assert_eq!(old_track.click_points, vec![(0.3, 0.1)]);
        // Visibility is the samples'.
        assert!(fine_track.visible_at(0.06));
        assert!(!fine_track.visible_at(0.1));
        assert!(fine_track.visible_at(0.12));
    }

    /// Enveloppe du click bounce : neutre hors fenêtre, continue aux jonctions, creux à 0.76 et
    /// pic à 1.16 aux bons instants, et un nouveau clic redémarre la courbe.
    #[test]
    fn click_bounce_envelope() {
        let near = |a: f32, b: f32, tol: f32| (a - b).abs() < tol;
        let track = CursorTrack::new(vec![], vec![1.0], vec![]);
        let b = |t: f32| track.bounce(t);

        // Exactement neutre avant le premier clic et après la fenêtre de 260 ms.
        assert_eq!(b(0.0), 1.0);
        assert_eq!(b(0.999), 1.0);
        assert_eq!(b(1.2601), 1.0);
        assert_eq!(b(5.0), 1.0);

        // Continuité aux jonctions (fraction 0, 0.38 et 1) : ±0.1 ms autour reste à ~1.
        const DT: f32 = 1e-4;
        assert_eq!(b(1.0), 1.0, "fraction 0");
        assert!(near(b(1.0 + DT), 1.0, 2e-3));
        let press_end = 1.0 + 0.38 * 0.26;
        assert!(
            near(b(press_end - DT), 1.0, 2e-3),
            "fraction 0.38⁻ : {}",
            b(press_end - DT)
        );
        assert!(
            near(b(press_end + DT), 1.0, 2e-3),
            "fraction 0.38⁺ : {}",
            b(press_end + DT)
        );
        assert!(
            near(b(1.26 - DT), 1.0, 2e-3),
            "fraction 1⁻ : {}",
            b(1.26 - DT)
        );

        // Creux de la pression (fraction 0.19 → +49.4 ms), pic du rebond (0.69 → +179.4 ms).
        assert!(near(b(1.0494), 0.76, 1e-4), "creux : {}", b(1.0494));
        assert!(near(b(1.1794), 1.16, 1e-4), "pic : {}", b(1.1794));
        assert!(b(1.03) > 0.76 && b(1.07) > 0.76, "le creux est un minimum");
        assert!(b(1.15) < 1.16 && b(1.21) < 1.16, "le pic est un maximum");

        // Seul le clic le plus récent compte : le second redémarre la courbe. À 1.1 s le premier
        // serait encore dans son rebond (≈1.0037), le second l'écrase à 1.0 pile.
        let double = CursorTrack::new(vec![], vec![1.0, 1.1], vec![]);
        assert_eq!(double.bounce(1.1), 1.0, "redémarrage à la fraction 0");
        assert!(
            near(double.bounce(1.1494), 0.76, 1e-4),
            "nouveau creux : {}",
            double.bounce(1.1494)
        );
        assert!(
            near(double.bounce(1.2794), 1.16, 1e-4),
            "nouveau pic : {}",
            double.bounce(1.2794)
        );
        assert_eq!(
            double.bounce(1.3601),
            1.0,
            "neutre après la fenêtre du second clic"
        );
    }

    #[test]
    fn auto_hide_disabled_always_full_opacity() {
        let track = CursorTrack::new(vec![(0.0, 0.5, 0.5), (10.0, 0.5, 0.5)], vec![], vec![]);
        assert_eq!(track.opacity_at(0.0, false), 1.0);
        assert_eq!(track.opacity_at(5.0, false), 1.0);
        assert_eq!(track.opacity_at(10.0, false), 1.0);
    }

    #[test]
    fn auto_hide_fades_out_after_idle_timeout() {
        // Le curseur est stationnaire à (0.5, 0.5) de 0 à 5s.
        let track = CursorTrack::new(
            vec![
                (0.0, 0.5, 0.5),
                (1.0, 0.5, 0.5),
                (2.0, 0.5, 0.5),
                (3.0, 0.5, 0.5),
                (4.0, 0.5, 0.5),
            ],
            vec![],
            vec![],
        );
        // Pendant 1.5s, opacité 1.0
        assert_eq!(track.opacity_at(0.0, true), 1.0);
        assert_eq!(track.opacity_at(1.0, true), 1.0);
        assert_eq!(track.opacity_at(1.5, true), 1.0);

        // Entre 1.5s et 1.8s, estompage linéaire
        let op_mid = track.opacity_at(1.65, true);
        assert!(
            (op_mid - 0.5).abs() < 0.05,
            "mi-parcours d'estompage: {op_mid}"
        );

        // À 1.8s et au-delà, opacité 0.0
        assert_eq!(track.opacity_at(1.8, true), 0.0);
        assert_eq!(track.opacity_at(3.0, true), 0.0);
    }

    #[test]
    fn auto_hide_wakes_on_movement_or_click() {
        // Reste immobile jusqu'à 2s, bouge à 2.5s, s'arrête, clic à 4.0s
        let track = CursorTrack::new(
            vec![
                (0.0, 0.1, 0.1),
                (1.0, 0.1, 0.1),
                (2.0, 0.1, 0.1),
                (2.5, 0.8, 0.8), // mouvement net
                (2.6, 0.8, 0.8),
                (4.0, 0.8, 0.8),
                (5.0, 0.8, 0.8),
            ],
            vec![4.0], // clic à 4.0s
            vec![],
        );

        // À 1.9s, inactif depuis 0s -> 0.0
        assert_eq!(track.opacity_at(1.9, true), 0.0);

        // À 2.5s, vient de bouger -> réveil à 1.0
        assert_eq!(track.opacity_at(2.5, true), 1.0);
        // À 3.5s, 1s après le mouvement -> toujours 1.0
        assert_eq!(track.opacity_at(3.5, true), 1.0);

        // Sans le clic à 4.0, à 4.5s (2s après 2.5) il serait éteint.
        // Mais le clic à 4.0s le réveille -> 1.0
        assert_eq!(track.opacity_at(4.2, true), 1.0);
        // Et s'éteint 1.8s après le clic (4.0 + 1.8 = 5.8s)
        assert_eq!(track.opacity_at(5.9, true), 0.0);
    }
}
