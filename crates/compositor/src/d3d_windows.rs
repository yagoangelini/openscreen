//! Le device D3D11 unique du POC (§2).
//! Un seul `ID3D11Device`, feature level 11_1, flag VIDEO_SUPPORT (décodeur),
//! et `ID3D10Multithread::SetMultithreadProtected(TRUE)` — parce que le décodeur
//! ffmpeg et notre boucle de rendu toucheront le device depuis des threads distincts.

use anyhow::{bail, Result};
use std::sync::OnceLock;
use windows::core::Interface;
use windows::Win32::Foundation::{HMODULE, LUID};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_DRIVER_TYPE_WARP,
    D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_DEBUG, D3D11_CREATE_DEVICE_FLAG,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIDevice, IDXGIFactory4, IDXGIFactory6,
    DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_GPU_PREFERENCE, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
    DXGI_GPU_PREFERENCE_MINIMUM_POWER,
};

/// PCI vendor IDs of the adapters whose hardware encoders the export knows how to drive.
pub const VENDOR_NVIDIA: u32 = 0x10DE;
pub const VENDOR_AMD: u32 = 0x1002;
pub const VENDOR_INTEL: u32 = 0x8086;

/// Which adapter the hardware device is created on. `OPENSCREEN_COMPOSITOR_ADAPTER` picks it;
/// unset means `HighPerformance`.
///
/// On a hybrid laptop the default adapter (`D3D11CreateDevice(None, HARDWARE)`) is whichever GPU
/// drives the primary panel: the integrated one. The compositor never presents to a screen (the
/// preview is read back to the CPU and painted on a `<canvas>`), so nothing ties it to that GPU,
/// and running it there left the dedicated one, and its NVENC, idle during an export.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdapterChoice {
    /// `DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE`: the dedicated GPU on a hybrid laptop.
    HighPerformance,
    /// `DXGI_GPU_PREFERENCE_MINIMUM_POWER`: the integrated GPU.
    MinimumPower,
    /// The pre-selection behaviour: no adapter, `D3D_DRIVER_TYPE_HARDWARE`.
    SystemDefault,
    /// One adapter, by the LUID `adapter_info` logs (`HighPart << 32 | LowPart`, in hex).
    Luid(u64),
}

impl AdapterChoice {
    pub fn label(self) -> String {
        match self {
            AdapterChoice::HighPerformance => "high-performance".into(),
            AdapterChoice::MinimumPower => "minimum-power".into(),
            AdapterChoice::SystemDefault => "default".into(),
            AdapterChoice::Luid(luid) => format!("luid {luid:016x}"),
        }
    }
}

/// Reads an `OPENSCREEN_COMPOSITOR_ADAPTER` value. Anything unreadable falls back to the
/// default with a warning rather than failing: a typo in an environment variable must not cost
/// the user their preview.
pub fn parse_adapter_choice(raw: Option<&str>) -> AdapterChoice {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return AdapterChoice::HighPerformance;
    };
    match raw.to_ascii_lowercase().as_str() {
        "high-performance" | "high_performance" | "performance" => AdapterChoice::HighPerformance,
        "minimum-power" | "minimum_power" | "power-saving" | "integrated" => {
            AdapterChoice::MinimumPower
        }
        "default" | "system" => AdapterChoice::SystemDefault,
        other => {
            let hex = other.strip_prefix("0x").unwrap_or(other);
            match u64::from_str_radix(hex, 16) {
                Ok(luid) if !hex.is_empty() && hex.len() <= 16 => AdapterChoice::Luid(luid),
                _ => {
                    eprintln!(
                        "[d3d] OPENSCREEN_COMPOSITOR_ADAPTER={raw} is not high-performance, \
                         minimum-power, default or a hex LUID; using high-performance"
                    );
                    AdapterChoice::HighPerformance
                }
            }
        }
    }
}

fn adapter_choice_from_env() -> AdapterChoice {
    parse_adapter_choice(std::env::var("OPENSCREEN_COMPOSITOR_ADAPTER").ok().as_deref())
}

/// What a device runs on, as support needs to read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterInfo {
    pub description: String,
    pub vendor_id: u32,
    pub device_id: u32,
    /// `HighPart << 32 | LowPart` — the value `OPENSCREEN_COMPOSITOR_ADAPTER` accepts back.
    pub luid: u64,
    pub dedicated_video_memory: u64,
    /// How the adapter was chosen (`AdapterChoice::label`), or `default` after a fallback.
    pub selection: String,
}

impl AdapterInfo {
    pub fn vendor_name(&self) -> &'static str {
        match self.vendor_id {
            VENDOR_NVIDIA => "NVIDIA",
            VENDOR_AMD => "AMD",
            VENDOR_INTEL => "Intel",
            0x1414 => "Microsoft",
            _ => "unknown",
        }
    }
}

impl std::fmt::Display for AdapterInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} ({} 0x{:04x}, device 0x{:04x}, LUID {:016x}, {} MB dedicated, selection {})",
            self.description,
            self.vendor_name(),
            self.vendor_id,
            self.device_id,
            self.luid,
            self.dedicated_video_memory / (1024 * 1024),
            self.selection,
        )
    }
}

fn luid_to_u64(luid: LUID) -> u64 {
    ((luid.HighPart as u32 as u64) << 32) | luid.LowPart as u64
}

/// The adapter a D3D11 device was created on. `None` only if DXGI refuses to say.
pub fn adapter_info(device: &ID3D11Device) -> Option<AdapterInfo> {
    adapter_info_with(device, "default")
}

fn adapter_info_with(device: &ID3D11Device, selection: &str) -> Option<AdapterInfo> {
    unsafe {
        let dxgi: IDXGIDevice = device.cast().ok()?;
        let adapter = dxgi.GetAdapter().ok()?;
        let desc = adapter.GetDesc().ok()?;
        let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
        Some(AdapterInfo {
            description: String::from_utf16_lossy(&desc.Description[..len]).trim().to_string(),
            vendor_id: desc.VendorId,
            device_id: desc.DeviceId,
            luid: luid_to_u64(desc.AdapterLuid),
            dedicated_video_memory: desc.DedicatedVideoMemory as u64,
            selection: selection.to_string(),
        })
    }
}

/// The adapter `choice` names, or `None` for `SystemDefault`. A software adapter (Basic Render
/// Driver) is refused here: it is what a GPU-less host enumerates first, and the default path
/// plus the CPU backend already handle that host with better diagnostics.
fn pick_adapter(choice: AdapterChoice) -> windows::core::Result<Option<IDXGIAdapter>> {
    let preference = |pref: DXGI_GPU_PREFERENCE| -> windows::core::Result<IDXGIAdapter1> {
        let factory: IDXGIFactory6 = unsafe { CreateDXGIFactory1()? };
        unsafe { factory.EnumAdapterByGpuPreference(0, pref) }
    };
    let adapter: IDXGIAdapter1 = match choice {
        AdapterChoice::SystemDefault => return Ok(None),
        AdapterChoice::HighPerformance => preference(DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)?,
        AdapterChoice::MinimumPower => preference(DXGI_GPU_PREFERENCE_MINIMUM_POWER)?,
        AdapterChoice::Luid(luid) => {
            let factory: IDXGIFactory4 = unsafe { CreateDXGIFactory1()? };
            unsafe {
                factory.EnumAdapterByLuid(LUID {
                    LowPart: luid as u32,
                    HighPart: (luid >> 32) as u32 as i32,
                })?
            }
        }
    };
    let desc = unsafe { adapter.GetDesc1()? };
    if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
        return Ok(None);
    }
    Ok(Some(adapter.cast()?))
}

/// Qui exécute le pipeline. Le rendu et le décodage sont DEUX axes distincts, et aucune
/// plateforme n'a de rastériseur logiciel qui décode aussi la vidéo (WARP ici, lavapipe
/// sous Linux, rien du tout sous macOS) — un backend fixe donc les deux ensemble.
///
/// Le contrat de scène, les shaders HLSL et tout `compositor.rs` sont identiques d'un
/// backend à l'autre : c'est tout l'intérêt. Un portage Metal/Vulkan remplace ce que fait
/// ce fichier et `Decoder`, pas le moteur.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    /// GPU : rastérisation matérielle + décodage D3D11VA sur le même device (zéro copie).
    /// Le seul backend qui puisse exporter — l'encodeur AMF exige lui aussi le vrai GPU.
    Hardware,
    /// CPU : rastérisation WARP + décodage logiciel libavcodec, uploadé en NV12.
    /// Pour les hôtes sans GPU D3D11 utilisable (VM, RDP, Basic Render Driver).
    Cpu,
}

impl Backend {
    fn driver(self) -> D3D_DRIVER_TYPE {
        match self {
            Backend::Hardware => D3D_DRIVER_TYPE_HARDWARE,
            Backend::Cpu => D3D_DRIVER_TYPE_WARP,
        }
    }

    /// WARP REFUSE `VIDEO_SUPPORT` (`DXGI_ERROR_UNSUPPORTED`, mesuré dans
    /// `tests/warp_device_cannot_decode.rs`) : ce flag n'a de sens que sur le device
    /// matériel, où il conditionne D3D11VA. Le backend CPU ne décode pas sur le GPU,
    /// il n'en a donc pas besoin.
    fn base_flags(self) -> D3D11_CREATE_DEVICE_FLAG {
        match self {
            Backend::Hardware => {
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT
            }
            Backend::Cpu => D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        }
    }
}

pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub feature_level: D3D_FEATURE_LEVEL,
    /// Lu par `Decoder::open` pour choisir D3D11VA ou le décodage logiciel. Porté par le
    /// `Gpu` plutôt que passé partout : tout ce qui tient un device sait déjà qui il est.
    pub backend: Backend,
}

/// Une tentative `D3D11CreateDevice` à FL 11_1. Extraite pour que le chemin d'échec
/// puisse re-sonder avec d'autres flags/driver et dire POURQUOI la vraie tentative
/// a échoué (voir `diagnose`), au lieu de remonter un HRESULT nu.
fn try_create(
    driver: D3D_DRIVER_TYPE,
    flags: D3D11_CREATE_DEVICE_FLAG,
) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext, D3D_FEATURE_LEVEL)> {
    try_create_on(None, driver, flags)
}

/// `try_create` on an explicit adapter. With an adapter, D3D11 requires
/// `D3D_DRIVER_TYPE_UNKNOWN`; the caller passes it.
fn try_create_on(
    adapter: Option<&IDXGIAdapter>,
    driver: D3D_DRIVER_TYPE,
    flags: D3D11_CREATE_DEVICE_FLAG,
) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext, D3D_FEATURE_LEVEL)> {
    let levels = [D3D_FEATURE_LEVEL_11_1];
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    let mut got = D3D_FEATURE_LEVEL::default();
    unsafe {
        D3D11CreateDevice(
            adapter,
            driver,
            HMODULE::default(),
            flags,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut got),
            Some(&mut context),
        )?;
    }
    // Le SDK garantit les deux sorties quand l'appel réussit ; `E_UNEXPECTED` plutôt
    // qu'un `unwrap` pour que l'impossible reste une erreur, pas un panic.
    match (device, context) {
        (Some(device), Some(context)) => Ok((device, context, got)),
        _ => Err(windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED)),
    }
}

/// Message d'échec ACTIONNABLE : re-sonde pour distinguer les deux causes réelles.
///
/// Ce message reste utile MÊME maintenant que `create_auto` replie sur le backend CPU :
/// il part dans les logs à chaque repli, et c'est lui qui dit si l'utilisateur subit un
/// pilote à mettre à jour (réparable en cinq minutes) ou une VM sans GPU (structurel).
/// Sans lui, un utilisateur au rendu logiciel ne saurait jamais qu'il lui manque un
/// pilote. Et si WARP échoue aussi, c'est ce message-ci que `create_auto` remonte.
///
/// PR #162 proposait de retomber sur `D3D_DRIVER_TYPE_WARP` en gardant tout le reste.
/// Mesuré (`tests/warp_device_cannot_decode.rs`) : WARP + `VIDEO_SUPPORT` ne se crée même
/// pas (`DXGI_ERROR_UNSUPPORTED`), et sans ce flag il n'expose aucun `ID3D11VideoDevice`
/// (`E_NOINTERFACE`, 0 profil décodeur). Comme `pipeline.rs` passe CE device à ffmpeg
/// comme `AVD3D11VADeviceContext`, un simple changement de driver type aurait produit zéro
/// frame. C'est ce qui a donné à `Backend::Cpu` sa forme : WARP pour le rendu PLUS un
/// décodage logiciel (`cpu_frames.rs`) — le rendu et le décodage sont deux axes.
fn diagnose(err: &windows::core::Error) -> String {
    // Le décodeur est le point de rupture le plus probable (RDP, VM sans passthrough,
    // Microsoft Basic Render Driver) : si l'appel passe SANS VIDEO_SUPPORT, l'adaptateur
    // est là, c'est son décodeur qui manque. La sonde ne garde que BGRA — surtout pas
    // `flags` moins VIDEO_SUPPORT, qui traînerait `DEBUG` avec lui : sans les Graphics
    // Tools de Windows la couche debug fait échouer la sonde aussi, et on accuserait
    // l'adaptateur à tort. Ce cas-là se lit déjà dans `{err}`
    // (`DXGI_ERROR_SDK_COMPONENT_MISSING`), il n'a pas besoin de sa propre branche.
    if try_create(D3D_DRIVER_TYPE_HARDWARE, D3D11_CREATE_DEVICE_BGRA_SUPPORT).is_ok() {
        return format!(
            "this display adapter has no D3D11 video decoder ({err}). OpenScreen decodes \
             every preview and export frame with D3D11VA on the same device it composites \
             with, so the decoder is not optional and there is no CPU path behind it. \
             Remote Desktop sessions and VMs without GPU passthrough land here: run on the \
             physical machine, or update the display driver."
        );
    }
    format!(
        "no Direct3D 11 feature level 11_1 display adapter ({err}). OpenScreen's compositor \
         requires one for both preview and export. Update the display driver, or run on a \
         machine with a GPU that reaches feature level 11_1."
    )
}

impl Gpu {
    /// Crée le device conforme au §2. `debug=false` impératif dans tout run mesuré
    /// (§10 : la couche debug valide et sérialise chaque appel — facteur, pas %).
    ///
    /// MATÉRIEL STRICT, sans repli : échoue plutôt que de rendre un device WARP. C'est ce
    /// que veulent les tests et les goldens (mesurer ou comparer le chemin GPU n'a aucun
    /// sens sur un rastériseur logiciel). Le chemin de production, lui, prend `create_auto`.
    pub fn create(debug: bool) -> Result<Gpu> {
        Gpu::create_backend(Backend::Hardware, debug)
    }

    /// Le device de PRODUCTION : matériel si possible, backend CPU sinon.
    ///
    /// C'est ici que le repli devient automatique, et il ne l'est qu'accompagné : l'app
    /// demande `probe()` et prévient l'utilisateur. Un basculement muet vers un rendu à
    /// ~8 fps serait exactement le « l'app rame aujourd'hui » que cette branche corrige.
    ///
    /// Si les DEUX échouent, c'est le diagnostic MATÉRIEL qu'on remonte en tête : c'est
    /// lui qui est actionnable (« pas de décodeur vidéo sur cet adaptateur »), pas
    /// « WARP indisponible », qui ne dit rien à personne.
    pub fn create_auto(debug: bool) -> Result<Gpu> {
        let hw_err = match Gpu::create_backend(Backend::Hardware, debug) {
            Ok(gpu) => return Ok(gpu),
            Err(err) => err,
        };
        eprintln!("[d3d] backend matériel indisponible ({hw_err:#}) — repli sur le backend CPU");
        Gpu::create_backend(Backend::Cpu, debug).map_err(|cpu_err| {
            anyhow::anyhow!("{hw_err:#} (le repli logiciel a échoué aussi : {cpu_err:#})")
        })
    }

    /// Le backend que cette machine obtiendra, sans créer de vue ni d'export.
    ///
    /// Mis en cache : créer un device coûte quelques dizaines de ms et la réponse ne
    /// change pas en cours de session (un pilote qui tombe en marche est un redémarrage,
    /// pas un rafraîchissement). `None` = ni matériel ni WARP — la vue échouera, et c'est
    /// son message d'erreur, plus précis, qui doit parler.
    pub fn probe() -> Option<Backend> {
        Self::probed().as_ref().map(|(backend, _)| *backend)
    }

    /// The adapter `probe()`'s device landed on — the one every preview and export of this
    /// session uses, since they all go through the same selection. For support logs and
    /// diagnostics; `None` when no device could be created at all.
    pub fn probe_adapter() -> Option<AdapterInfo> {
        Self::probed().as_ref().and_then(|(_, info)| info.clone())
    }

    fn probed() -> &'static Option<(Backend, Option<AdapterInfo>)> {
        static PROBED: OnceLock<Option<(Backend, Option<AdapterInfo>)>> = OnceLock::new();
        PROBED.get_or_init(|| {
            for backend in [Backend::Hardware, Backend::Cpu] {
                if let Ok(gpu) = Gpu::create_backend(backend, false) {
                    return Some((backend, gpu.adapter_info()));
                }
            }
            None
        })
    }

    /// The adapter this device runs on, with `selection` saying whether it is the one
    /// `OPENSCREEN_COMPOSITOR_ADAPTER` asked for or the default path's fallback.
    pub fn adapter_info(&self) -> Option<AdapterInfo> {
        let mut info = adapter_info(&self.device)?;
        if self.backend == Backend::Hardware {
            let choice = adapter_choice_from_env();
            if let Ok(Some(chosen)) = pick_adapter(choice) {
                if let Ok(desc) = unsafe { chosen.GetDesc() } {
                    if luid_to_u64(desc.AdapterLuid) == info.luid {
                        info.selection = choice.label();
                    }
                }
            }
        }
        Some(info)
    }

    /// Le device du backend demandé. `Backend::Cpu` ne diagnostique pas : si WARP
    /// lui-même échoue, il n'y a plus rien derrière à proposer.
    pub fn create_backend(backend: Backend, debug: bool) -> Result<Gpu> {
        let mut flags = backend.base_flags();
        if debug {
            flags |= D3D11_CREATE_DEVICE_DEBUG;
        }

        // Hardware: the adapter `OPENSCREEN_COMPOSITOR_ADAPTER` names (the high-performance one
        // unless told otherwise) first, then the default path exactly as it was. A dedicated GPU
        // that refuses `VIDEO_SUPPORT` must never cost the user the device the integrated one
        // would have given them.
        let mut selected: Option<(ID3D11Device, ID3D11DeviceContext, D3D_FEATURE_LEVEL, String)> =
            None;
        if backend == Backend::Hardware {
            let choice = adapter_choice_from_env();
            match pick_adapter(choice) {
                Ok(Some(adapter)) => {
                    match try_create_on(Some(&adapter), D3D_DRIVER_TYPE_UNKNOWN, flags) {
                        Ok((device, context, got)) => {
                            selected = Some((device, context, got, choice.label()))
                        }
                        Err(err) => eprintln!(
                            "[d3d] adapter {} refused the device ({err}); using the default adapter",
                            choice.label()
                        ),
                    }
                }
                Ok(None) => {}
                Err(err) => eprintln!(
                    "[d3d] adapter {} unavailable ({err}); using the default adapter",
                    choice.label()
                ),
            }
        }
        let (device, context, got, selection) = match selected {
            Some(selected) => selected,
            None => match try_create(backend.driver(), flags) {
                Ok((device, context, got)) => (device, context, got, "default".to_string()),
                Err(err) if backend == Backend::Cpu => {
                    bail!("WARP (rastériseur logiciel) indisponible sur cet hôte : {err}")
                }
                Err(err) => bail!("{}", diagnose(&err)),
            },
        };
        if let Some(info) = adapter_info_with(&device, &selection) {
            eprintln!("[d3d] {:?} device on {info}", backend);
        }

        if got != D3D_FEATURE_LEVEL_11_1 {
            bail!("feature level obtenu {:?} != 11_1", got);
        }

        // §2 : multithread-protected. Le décodeur ffmpeg soumet depuis son thread,
        // notre compositeur depuis le nôtre — sans ça, corruption silencieuse.
        let mt: ID3D11Multithread = context.cast()?;
        unsafe {
            let _prev = mt.SetMultithreadProtected(true);
            if !mt.GetMultithreadProtected().as_bool() {
                bail!("SetMultithreadProtected(TRUE) n'a pas pris");
            }
        }

        Ok(Gpu { device, context, feature_level: got, backend })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_adapter_defaults_to_high_performance() {
        assert_eq!(parse_adapter_choice(None), AdapterChoice::HighPerformance);
        assert_eq!(parse_adapter_choice(Some("  ")), AdapterChoice::HighPerformance);
        assert_eq!(parse_adapter_choice(Some("High-Performance")), AdapterChoice::HighPerformance);
    }

    #[test]
    fn the_adapter_override_reads_every_documented_form() {
        assert_eq!(parse_adapter_choice(Some("minimum-power")), AdapterChoice::MinimumPower);
        assert_eq!(parse_adapter_choice(Some("default")), AdapterChoice::SystemDefault);
        assert_eq!(parse_adapter_choice(Some("0x00000000000123ab")), AdapterChoice::Luid(0x123ab));
        assert_eq!(parse_adapter_choice(Some("1f2e")), AdapterChoice::Luid(0x1f2e));
        // A typo keeps the user's preview: the default choice, never an error.
        assert_eq!(parse_adapter_choice(Some("nvidia please")), AdapterChoice::HighPerformance);
        assert_eq!(
            parse_adapter_choice(Some("0x11112222333344445")),
            AdapterChoice::HighPerformance
        );
    }

    #[test]
    fn a_luid_round_trips_through_the_logged_hex() {
        let luid = LUID { LowPart: 0xdead_beef, HighPart: 0x12 };
        let packed = luid_to_u64(luid);
        assert_eq!(format!("{packed:016x}"), "00000012deadbeef");
        assert_eq!(parse_adapter_choice(Some(&format!("{packed:016x}"))), AdapterChoice::Luid(packed));
    }

    /// The device names the adapter it runs on. On a machine with a GPU this is the
    /// high-performance one unless the environment says otherwise.
    #[test]
    fn a_hardware_device_reports_its_adapter() {
        let Ok(gpu) = Gpu::create(false) else {
            eprintln!("skip: no hardware D3D11 device on this host");
            return;
        };
        let info = gpu.adapter_info().expect("adapter info");
        assert!(!info.description.is_empty());
        assert_ne!(info.luid, 0);
        eprintln!("adapter: {info}");
    }
}
