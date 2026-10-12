//! The tutorial annotations (`kind: "shape"`, mode 21) rendered by the D3D11 compositor: a
//! highlight dims the frame around its box and fades in, a step's disc pops, and the preview
//! (rendered small) shows the same picture as the export (rendered at full size).
//!
//! Same harness and variables as `click_impact_render.rs`: a 1920×1080 source of 6 s.
//!
//! ```powershell
//! ffmpeg -f lavfi -i "color=c=0x707070:s=1920x1080:r=30:d=6,drawgrid=w=96:h=96:t=3:c=white" -c:v h264_mf -b:v 6M -pix_fmt nv12 grid.mp4
//! $env:OPENSCREEN_TILT_SOURCE = "...\grid.mp4"
//! cargo test -p openscreen-compositor --test tutorial_marks_render -- --nocapture
//! ```

#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::live::Player;
use openscreen_compositor::scene::Scene;

fn scene_json(source: &str, annotations: &str, w: u32, h: u32) -> String {
    let s = source.replace('\\', "/");
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                    "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0.0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#2060d0"}},
        "zoomRegions": [],
        "annotations": [{annotations}],
        "speedRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":{w},"height":{h},"fps":null}}
    }}"##
    )
}

/// A highlight over the middle of the frame (1 s → 5 s) and a step badge at (0.2, 0.2).
const MARKS: &str = r##"
    {"id":"hl","startSec":1,"endSec":5,"kind":"shape","space":"frame","x":0.35,"y":0.35,"w":0.3,"h":0.3,"zIndex":1,
     "shape":{"fill":"rgba(0, 0, 0, 0.6)","radiusRel":0.015,"featherRel":0.011,"borderColor":"#34B27B","borderRel":0.003,"invert":true,"animation":"fade"}},
    {"id":"st","startSec":1,"endSec":5,"kind":"shape","space":"frame","x":0.2,"y":0.2,"w":0.05625,"h":0.1,"zIndex":2,
     "shape":{"fill":"#2563EB","radiusRel":0.1,"featherRel":0,"borderColor":"#ffffff","borderRel":0.006,"invert":false,"animation":"pop"}},
    {"id":"st:number","startSec":1,"endSec":5,"kind":"text","space":"frame","x":0.2,"y":0.2,"w":0.05625,"h":0.1,"zIndex":2,
     "text":{"content":"3","color":"#ffffff","backgroundColor":"transparent","fontSizeRel":0.05,"fontFamily":"Inter","fontWeight":"bold","fontStyle":"normal","textDecoration":"none","textAlign":"center","animation":"pop"}}
"##;

fn luma(rgba: &[u8], w: u32, x: u32, y: u32) -> f64 {
    let p = &rgba[((y * w + x) * 4) as usize..];
    0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64
}

/// Mean luma over a rect given in fractions of the frame.
fn mean_luma(rgba: &[u8], w: u32, h: u32, r: [f64; 4]) -> f64 {
    let (x0, y0) = ((r[0] * w as f64) as u32, (r[1] * h as f64) as u32);
    let (x1, y1) = (((r[0] + r[2]) * w as f64) as u32, ((r[1] + r[3]) * h as f64) as u32);
    let mut sum = 0.0;
    let mut n = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            sum += luma(rgba, w, x, y);
            n += 1.0;
        }
    }
    sum / n
}

/// The full-size render boxed down by two, to compare with the half-size render.
fn half(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let (hw, hh) = (w / 2, h / 2);
    let mut out = vec![0u8; (hw * hh * 4) as usize];
    for y in 0..hh {
        for x in 0..hw {
            for c in 0..4 {
                let at = |dx: u32, dy: u32| rgba[(((2 * y + dy) * w + 2 * x + dx) * 4 + c) as usize] as u32;
                out[((y * hw + x) * 4 + c) as usize] = ((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1) + 2) / 4) as u8;
            }
        }
    }
    out
}

#[test]
fn highlight_and_step_render_the_same_in_preview_and_export() {
    let Ok(source) = std::env::var("OPENSCREEN_TILT_SOURCE") else {
        println!("SKIP: definir OPENSCREEN_TILT_SOURCE (voir l'en-tete du fichier).");
        return;
    };
    let gpu = Gpu::create(false).expect("device d3d11");
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let render = |w: u32, h: u32, annotations: &str, t: f64| -> Vec<u8> {
        let comp = Compositor::new_sized(&gpu, w, h).expect("compositor");
        let scene = Scene::from_json(&scene_json(&source, annotations, w, h)).expect("scene valide");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_scene(Some(scene));
        unsafe {
            let mut player = Player::open(&source, "", &gpu).expect("ouvrir la source");
            player.present_frame(&comp, &cfg, t).expect("composer la frame");
            comp.readback_resized(w, h).expect("readback")
        }
    };
    let (w, h) = (1920, 1080);
    let plain = render(w, h, "", 3.0);
    let lit = render(w, h, MARKS, 3.0);
    let outside = [0.02, 0.6, 0.15, 0.3];
    let inside = [0.4, 0.4, 0.2, 0.2];
    let ratio_out = mean_luma(&lit, w, h, outside) / mean_luma(&plain, w, h, outside);
    let ratio_in = mean_luma(&lit, w, h, inside) / mean_luma(&plain, w, h, inside);
    println!("highlight: outside x{ratio_out:.3}, inside x{ratio_in:.3}");
    // Premultiplied black at 0.6 over the picture leaves 40 % of it, the lit box untouched.
    assert!((ratio_out - 0.4).abs() < 0.02, "outside x{ratio_out}");
    assert!((ratio_in - 1.0).abs() < 0.01, "inside x{ratio_in}");
    // The badge: its blue disc at the centre of its box.
    let c = &lit[(((0.25 * h as f64) as u32 * w + (0.212 * w as f64) as u32) * 4) as usize..];
    println!("badge pixel {:?}", &c[..3]);
    assert!(c[2] > 150 && c[0] < 120, "badge colour {:?}", &c[..3]);

    // Fading: dimmer outside mid-span than 150 ms into it.
    let early = render(w, h, MARKS, 1.15);
    let ratio_early = mean_luma(&early, w, h, outside) / mean_luma(&plain, w, h, outside);
    println!("highlight at +150 ms: outside x{ratio_early:.3}");
    assert!(ratio_early > ratio_out + 0.1, "no fade-in: x{ratio_early} vs x{ratio_out}");

    // Preview = export: the half-size render against the full one boxed down.
    let small = render(w / 2, h / 2, MARKS, 3.0);
    let big = half(&lit, w, h);
    let mut max_diff = 0u8;
    let mut sum = 0u64;
    for (a, b) in small.iter().zip(&big) {
        let d = a.abs_diff(*b);
        max_diff = max_diff.max(d);
        sum += d as u64;
    }
    let mean = sum as f64 / small.len() as f64;
    println!("preview vs export: mean |d| {mean:.3}, max {max_diff}");
    assert!(mean < 2.0, "mean |d| {mean}");
    if let Ok(dir) = std::env::var("OPENSCREEN_TILT_OUT") {
        let write = |name: &str, rgba: &[u8], w: u32, h: u32| {
            let mut out = format!("P6\n{w} {h}\n255\n").into_bytes();
            for px in rgba.chunks_exact(4) {
                out.extend_from_slice(&px[..3]);
            }
            std::fs::write(std::path::Path::new(&dir).join(name), out).expect("ppm");
        };
        write("tutorial-export.ppm", &lit, w, h);
        write("tutorial-preview.ppm", &small, w / 2, h / 2);
    }
}
