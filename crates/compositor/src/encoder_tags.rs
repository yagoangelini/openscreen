//! What every export encoder must say about its pictures, on all three platforms.
//!
//! The compositor converts to BT.709 limited range (`yuv709_limited`), but nothing told the
//! encoder so: `h264_nvenc` then fell back to its own defaults, **Main** profile and no colour
//! description in the VUI, and the MP4 carried no `colr` box either (measured on 2.2.0:
//! `profile=Main`, `color_space/primaries/transfer/range=unknown`). Players and YouTube then
//! guess, and the guess for an untagged HD stream is not always 709.
//!
//! Set these on the codec context **before** `avcodec_open2`: the hardware wrappers copy the
//! colour fields into the VUI at open, and `avcodec_parameters_from_context` hands them to the
//! mov muxer, which writes the `colr` box from them.

use crate::ffi::*;
use std::ffi::CString;

/// The H.264 encoders the export pipelines try, on every platform. HEVC keeps its default
/// profile: Main is the right one for 8-bit 4:2:0.
fn is_h264_encoder(name: &str) -> bool {
    name.starts_with("h264_") || name == "libopenh264"
}

/// Tags the context as BT.709 limited range and, for H.264, asks for the High profile.
///
/// The profile goes two ways because the wrappers disagree on where they read it:
/// `h264_mf` and `libopenh264` read `avctx->profile`, while `h264_nvenc`, `h264_amf` and
/// `h264_qsv` read a private `profile` option whose default (Main, for NVENC and AMF)
/// silently wins over the context field. An encoder without that private option just
/// refuses the `av_opt_set`, which is ignored: the context field already covers it.
///
/// # Safety
/// `ctx` must be a valid, not yet opened, codec context.
pub(crate) unsafe fn tag_bt709_and_profile(ctx: *mut AVCodecContext, name: &str) {
    (*ctx).color_primaries = AVColorPrimaries::AVCOL_PRI_BT709;
    (*ctx).color_trc = AVColorTransferCharacteristic::AVCOL_TRC_BT709;
    (*ctx).colorspace = AVColorSpace::AVCOL_SPC_BT709;
    (*ctx).color_range = AVColorRange::AVCOL_RANGE_MPEG;
    if !is_h264_encoder(name) {
        return;
    }
    (*ctx).profile = AV_PROFILE_H264_HIGH as i32;
    if (*ctx).priv_data.is_null() {
        return;
    }
    let (key, value) = (
        CString::new("profile").unwrap(),
        CString::new("high").unwrap(),
    );
    let _ = av_opt_set((*ctx).priv_data, key.as_ptr(), value.as_ptr(), 0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;

    #[test]
    fn only_h264_encoders_get_the_high_profile() {
        for name in [
            "h264_nvenc",
            "h264_amf",
            "h264_qsv",
            "h264_mf",
            "h264_videotoolbox",
        ] {
            assert!(is_h264_encoder(name), "{name}");
        }
        assert!(is_h264_encoder("libopenh264"));
        for name in [
            "hevc_nvenc",
            "hevc_amf",
            "libkvazaar",
            "hevc_videotoolbox",
            "gif",
        ] {
            assert!(!is_h264_encoder(name), "{name}");
        }
    }

    /// The software fallback is in every vendored ffmpeg build, so it is the one encoder a
    /// test can open anywhere: open it tagged, and the SPS it writes must say High
    /// (`profile_idc` 100) and the context must still carry the BT.709 description.
    #[test]
    fn libopenh264_opens_tagged_high_and_bt709() {
        unsafe {
            let cname = CString::new("libopenh264").unwrap();
            let enc = avcodec_find_encoder_by_name(cname.as_ptr());
            if enc.is_null() {
                eprintln!("libopenh264 absent from this ffmpeg build, skipped");
                return;
            }
            let mut ctx = avcodec_alloc_context3(enc);
            assert!(!ctx.is_null());
            (*ctx).width = 64;
            (*ctx).height = 64;
            (*ctx).pix_fmt = AVPixelFormat::AV_PIX_FMT_YUV420P;
            (*ctx).time_base = AVRational { num: 1, den: 30 };
            (*ctx).framerate = AVRational { num: 30, den: 1 };
            (*ctx).bit_rate = 500_000;
            (*ctx).flags |= AV_CODEC_FLAG_GLOBAL_HEADER as i32;
            tag_bt709_and_profile(ctx, "libopenh264");
            averr(avcodec_open2(ctx, enc, ptr::null_mut()), "avcodec_open2").unwrap();

            assert_eq!((*ctx).color_primaries, AVColorPrimaries::AVCOL_PRI_BT709);
            assert_eq!(
                (*ctx).color_trc,
                AVColorTransferCharacteristic::AVCOL_TRC_BT709
            );
            assert_eq!((*ctx).colorspace, AVColorSpace::AVCOL_SPC_BT709);
            assert_eq!((*ctx).color_range, AVColorRange::AVCOL_RANGE_MPEG);

            let extradata =
                std::slice::from_raw_parts((*ctx).extradata, (*ctx).extradata_size as usize);
            // avcC carries profile_idc in its second byte; Annex B puts it right after the
            // SPS NAL header (type 7) that follows a start code.
            let profile_idc = if extradata.first() == Some(&1) {
                extradata[1]
            } else {
                extradata
                    .windows(5)
                    .find(|w| w[..3] == [0, 0, 1] && w[3] & 0x1f == 7)
                    .expect("an SPS in the extradata")[4]
            };
            assert_eq!(profile_idc, 100, "profile_idc of {extradata:02x?}");
            avcodec_free_context(&mut ctx);
        }
    }
}
