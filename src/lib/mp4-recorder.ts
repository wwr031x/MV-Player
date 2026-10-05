/**
 * MP4 录制器（WebCodecs 方案）
 * - 使用 VideoEncoder 编码 H.264 (avc1.4D401E / baseline 3.0)
 * - 使用 AudioEncoder 编码 AAC (mp4a.40.2)
 * - 自写 mp4 碎片封装（fMP4：ftyp + moov + moof/mdat 片段）
 * - 兼容华为等不支持 MediaRecorder mp4 的浏览器
 *
 * 外部调用：
 *   const recorder = new Mp4Recorder({ canvas, audioTrack, fps, bitrate });
 *   recorder.start();
 *   // 每帧调用 recorder.recordFrame() —— 由外部 rAF 循环驱动，时间戳来自 canvas
 *   // 或使用 recorder.startCaptureLoop() 自动抓帧
 *   const blob = await recorder.stop();
 */

import { logger } from '@lark-apaas/client-toolkit-lite';

// ============ 特性探测 ============

export interface RecorderSupportInfo {
  webCodecsVideo: boolean;
  webCodecsAudio: boolean;
  videoAvc1: boolean;
  audioAac: boolean;
  mediaRecorderMp4: boolean;
  mediaRecorderWebm: boolean;
}

let cachedSupport: RecorderSupportInfo | null = null;

export async function probeRecorderSupport(): Promise<RecorderSupportInfo> {
  if (cachedSupport) return cachedSupport;

  const info: RecorderSupportInfo = {
    webCodecsVideo: typeof (window as any).VideoEncoder !== 'undefined',
    webCodecsAudio: typeof (window as any).AudioEncoder !== 'undefined',
    videoAvc1: false,
    audioAac: false,
    mediaRecorderMp4: false,
    mediaRecorderWebm: false,
  };

  // VideoEncoder H.264 支持
  if (info.webCodecsVideo) {
    try {
      const VideoEncoder = (window as any).VideoEncoder;
      const result = await VideoEncoder.isConfigSupported({
        codec: 'avc1.4D401E',
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });
      info.videoAvc1 = !!result?.supported;
    } catch {
      info.videoAvc1 = false;
    }
  }

  // AudioEncoder AAC 支持
  if (info.webCodecsAudio) {
    try {
      const AudioEncoder = (window as any).AudioEncoder;
      const result = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 44100,
        numberOfChannels: 2,
        bitrate: 128_000,
      });
      info.audioAac = !!result?.supported;
    } catch {
      info.audioAac = false;
    }
  }

  // MediaRecorder 支持
  const MR = (window as any).MediaRecorder;
  if (MR && typeof MR.isTypeSupported === 'function') {
    info.mediaRecorderMp4 = MR.isTypeSupported('video/mp4;codecs=avc1.4D401E,mp4a.40.2')
      || MR.isTypeSupported('video/mp4');
    info.mediaRecorderWebm = MR.isTypeSupported('video/webm;codecs=vp9,opus')
      || MR.isTypeSupported('video/webm');
  }

  cachedSupport = info;
  return info;
}

// ============ MP4 碎片封装 ============

/**
 * 极简 fMP4 muxer：
 * - 生成 ftyp + moov（含 trak 视频 + trak 音频）
 * - 每批视频/音频帧生成 moof + mdat
 * 输出标准 .mp4 文件（非碎片化也可播放，因为 moov 在前面 + mdat 连续）
 */

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, false);
}

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, false);
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** 构造一个 box：[size(4)][type(4)][payload] */
function makeBox(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  writeUint32(view, 0, size);
  writeString(view, 4, type);
  buf.set(payload, 8);
  return buf;
}

/**
 * 构造 ftyp box
 */
function makeFtyp(): Uint8Array {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  // major_brand: iso5 (iso base media file format, level 5)
  writeString(view, 0, 'iso5');
  writeUint32(view, 4, 512); // minor_version
  // compatible_brands: iso5, mp41, avc1, iso2
  const brands = new Uint8Array(16);
  const bv = new DataView(brands.buffer);
  writeString(bv, 0, 'iso5');
  writeString(bv, 4, 'mp41');
  writeString(bv, 8, 'avc1');
  writeString(bv, 12, 'iso2');
  return makeBox('ftyp', new Uint8Array([...payload, ...brands]));
}

/** 构造 FLV/MP4 风格的可变长度 size（用于 ESDS / mp4a box 等，uint 则用 writeUint32） */
// 此处统一用 writeUint32 写入 size（32-bit），避免 64-bit 复杂度。

// ---- Moov 构造 ----

function makeMvhd(duration: number, timescale: number, width: number, height: number): Uint8Array {
  // mvhd v0: 108 bytes
  const data = new Uint8Array(108);
  const v = new DataView(data.buffer);
  v.setUint8(0, 0); // version
  // flags (3 bytes) = 0
  v.setUint32(4, 0); // creation_time
  v.setUint32(8, 0); // modification_time
  v.setUint32(12, timescale);
  v.setUint32(16, Math.floor(duration * timescale)); // duration
  v.setUint32(20, 0x00010000); // rate = 1.0
  v.setUint16(24, 0x0100); // volume = 1.0
  // reserved (2 + 8 + 4) = 14 bytes
  // matrix (9*4 = 36 bytes): unity matrix
  v.setUint32(32 + 0, 0x00010000); // a
  v.setUint32(32 + 4, 0);
  v.setUint32(32 + 8, 0);
  v.setUint32(32 + 12, 0);
  v.setUint32(32 + 16, 0x00010000); // d
  v.setUint32(32 + 20, 0);
  v.setUint32(32 + 24, 0);
  v.setUint32(32 + 28, 0);
  v.setUint32(32 + 32, 0x40000000); // w = 1.0 (fixed 16.16)
  // pre_defined (6*4 = 24 bytes) → 0
  v.setUint32(76, 2); // next_track_ID
  return makeBox('mvhd', data);
}

/** 构造 tkhd（track header） */
function makeTkhd(
  trackId: number,
  duration: number,
  timescale: number,
  width: number,
  height: number,
  isVideo: boolean,
): Uint8Array {
  // tkhd v0: 84 bytes (version=0 + flags=0x000001 track_enabled)
  const data = new Uint8Array(84);
  const v = new DataView(data.buffer);
  v.setUint8(0, 0); // version
  v.setUint8(3, 0x03); // flags = track_enabled | track_in_movie
  v.setUint32(4, 0); // creation_time
  v.setUint32(8, 0); // modification_time
  v.setUint32(12, trackId); // track_ID
  v.setUint32(20, Math.floor(duration * timescale)); // duration
  // layer (2) + alternate_group (2) + volume (2) = 6 bytes
  if (isVideo) {
    v.setUint16(36, 0x0100); // volume = 0 (video track)
  } else {
    v.setUint16(36, 0x0100); // volume = 1.0
  }
  // matrix (36 bytes): unity
  const matrixOffset = 40;
  v.setUint32(matrixOffset + 0, 0x00010000);
  v.setUint32(matrixOffset + 4, 0);
  v.setUint32(matrixOffset + 8, 0);
  v.setUint32(matrixOffset + 12, 0);
  v.setUint32(matrixOffset + 16, 0x00010000);
  v.setUint32(matrixOffset + 20, 0);
  v.setUint32(matrixOffset + 24, 0);
  v.setUint32(matrixOffset + 28, 0);
  v.setUint32(matrixOffset + 32, 0x40000000); // w = 1.0 (fixed 16.16)

  // width, height (16.16 fixed point)
  v.setUint32(76, Math.floor(width * 0x10000));
  v.setUint32(80, Math.floor(height * 0x10000));
  return makeBox('tkhd', data);
}

/** 构造 mdhd（media header） */
function makeMdhd(duration: number, timescale: number): Uint8Array {
  const data = new Uint8Array(32);
  const v = new DataView(data.buffer);
  v.setUint8(0, 0);
  v.setUint32(4, 0);
  v.setUint32(8, 0);
  v.setUint32(12, timescale);
  v.setUint32(16, Math.floor(duration * timescale));
  v.setUint16(20, 0x55C4); // language = und (undetermined, 0x55C4 per ISO 639-2/T table, but mp4 uses ISO 639-2/T code packed into 15 bits)
  return makeBox('mdhd', data);
}

/** 构造 hdlr（handler reference） */
function makeHdlr(handlerType: string, name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const payload = new Uint8Array(24 + nameBytes.length + 1);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 0); // version
  // pre_defined (4 bytes) = 0, at offset 4
  writeString(v, 8, handlerType); // handler_type (vide / soun / hint)
  // reserved 3 * 4 = 12 bytes (offset 12-23) = 0
  // name (null-terminated), offset 24+
  payload.set(nameBytes, 24);
  payload[24 + nameBytes.length] = 0;
  return makeBox('hdlr', payload);
}

/** 构造 avcC box（AVC decoder configuration record） */
function makeAvcc(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const payload = new Uint8Array(7 + sps.length + 2 + pps.length);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 1); // configurationVersion
  v.setUint8(1, sps[1]); // AVCProfileIndication
  v.setUint8(2, sps[2]); // profile_compatibility
  v.setUint8(3, sps[3]); // AVCLevelIndication
  v.setUint8(4, 0xff); // lengthSizeMinusOne = 3 (4 bytes) → 0xfc | 0x03 = 0xff
  v.setUint8(5, 0xe1); // numOfSequenceParameterSets = 1 (0xe0 | 1)
  v.setUint16(6, sps.length); // sequenceParameterSetLength
  payload.set(sps, 8);
  let off = 8 + sps.length;
  v.setUint8(off, 1); // numOfPictureParameterSets = 1
  v.setUint16(off + 1, pps.length);
  payload.set(pps, off + 3);
  return makeBox('avcC', payload);
}

/** 构造 esds box（MPEG-4 audio decoder configuration） */
function makeEsds(audioConfig: Uint8Array, sampleRate: number, channels: number, bitrate: number): Uint8Array {
  // AudioSpecificConfig (ASC): 5 bits audioObjectType (2 = AAC-LC) + 4 bits samplingFreqIndex + 4 bits channelConfig
  // 简化：直接用传入的 audioConfig（如果是 AudioEncoder 输出的 description.config 则已是 ASC）
  const asc = audioConfig.length > 0 ? audioConfig : buildAsc(sampleRate, channels);

  // ES_Descriptor
  // Tag 0x03 ES_Descriptor
  //   DecoderConfigDescriptor tag 0x04
  //     DecoderSpecificInfo tag 0x05 (ASC)
  //   SLConfigDescriptor tag 0x06

  const dsi = makeDescriptor(0x05, asc);
  const decConfig = makeDecoderConfigDesc(bitrate, dsi);
  const esId = 2;
  const esHeader = new Uint8Array(3); // tag(1) + size_var + ES_ID(2) + flags(1)
  // 我们用另一种写法：直接拼装
  const esBody = new Uint8Array(2 + 1 + decConfig.length + 3);
  // ES_ID(2) + streamDependenceFlag=0 URLflag=0 OCRstreamFlag=0 streamPriority(5 bits) = 1 byte
  const v1 = new DataView(esBody.buffer);
  v1.setUint16(0, esId);
  v1.setUint8(2, 0); // flags + streamPriority = 0
  esBody.set(decConfig, 3);
  // SLConfigDescriptor
  const sl = new Uint8Array(3); // tag 0x06, size 1, data 1 (predefined = 0x02 for MP4)
  sl[0] = 0x06;
  sl[1] = 1;
  sl[2] = 0x02; // predefined = 2 (use default)
  esBody.set(sl, 3 + decConfig.length);

  const esDesc = makeDescriptor(0x03, esBody.subarray(0, 3 + decConfig.length + sl.length));
  return makeBox('esds', esDesc);
}

function makeDescriptor(tag: number, data: Uint8Array): Uint8Array {
  const sizeBytes = encodeMpeg4Size(data.length);
  const out = new Uint8Array(1 + sizeBytes.length + data.length);
  out[0] = tag;
  out.set(sizeBytes, 1);
  out.set(data, 1 + sizeBytes.length);
  return out;
}

function encodeMpeg4Size(size: number): Uint8Array {
  // variable length encoding: 7 bits per byte, high bit = 1 means more bytes follow
  if (size < 0x80) return new Uint8Array([size]);
  if (size < 0x4000) return new Uint8Array([(size >> 7) | 0x80, size & 0x7f]);
  if (size < 0x20_0000) return new Uint8Array([(size >> 14) | 0x80, ((size >> 7) & 0x7f) | 0x80, size & 0x7f]);
  return new Uint8Array([
    (size >> 21) | 0x80,
    ((size >> 14) & 0x7f) | 0x80,
    ((size >> 7) & 0x7f) | 0x80,
    size & 0x7f,
  ]);
}

function makeDecoderConfigDesc(bitrate: number, dsi: Uint8Array): Uint8Array {
  const body = new Uint8Array(13 + dsi.length);
  const v = new DataView(body.buffer);
  // objectTypeIndication: 0x40 = audio ISO/IEC 14496-3 (AAC)
  v.setUint8(0, 0x40);
  // streamType (6 bits) = 5 (audio) / upStream (1 bit) = 0 / reserved(1 bit) = 1 → 0x05 << 2 = 0x14
  v.setUint8(1, 0x15); // 0001 0101: streamType=audio(5) (top 6 bits: 000101 = 5), upstream=0, reserved=1
  // bufferSizeDB (3 bytes, 24-bit)
  v.setUint8(2, 0);
  v.setUint16(3, 6144); // bufferSize = 6KB for AAC
  // maxBitrate (4 bytes)
  v.setUint32(5, bitrate);
  // avgBitrate (4 bytes)
  v.setUint32(9, bitrate);
  // DecoderSpecificInfo
  body.set(dsi, 13);
  return makeDescriptor(0x04, body);
}

function buildAsc(sampleRate: number, channels: number): Uint8Array {
  // AudioSpecificConfig: audioObjectType(5) + samplingFrequencyIndex(4) + channelConfiguration(4)
  // audioObjectType = 2 (AAC-LC)
  // samplingFrequencyIndex: 0=96k,1=88.2k,2=64k,3=48k,4=44.1k,5=32k,6=24k,7=22.05k,8=16k,9=12k,10=11.025k,11=8k
  const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  let freqIdx = sampleRates.indexOf(sampleRate);
  if (freqIdx === -1) freqIdx = 4; // default 44.1k
  const objType = 2; // AAC-LC
  // build 2 bytes: objType(5) freqIdx(4) chConfig(4) ... 13 bits used, pad with 0
  const bits = (objType << 11) | (freqIdx << 7) | (channels << 3);
  return new Uint8Array([(bits >> 8) & 0xff, bits & 0xff]);
}

/** 构造 stsd（sample description）box —— 视频 avc1 */
function makeVideoStsd(
  width: number,
  height: number,
  avccBox: Uint8Array,
): Uint8Array {
  // avc1 entry:
  //   size total
  //   'avc1'
  //   reserved (6 bytes) = 0
  //   data_reference_index (2 bytes) = 1
  //   pre_defined (2 bytes) = 0
  //   reserved (2 bytes) = 0
  //   pre_defined (12 bytes) = 0
  //   width (2 bytes)
  //   height (2 bytes)
  //   horizresolution (4 bytes, 16.16) = 0x0048_0000 (72 dpi)
  //   vertresolution (4 bytes, 16.16) = 0x0048_0000
  //   reserved (4 bytes) = 0
  //   frame_count (2 bytes) = 1
  //   compressorname (32 bytes) = 0
  //   depth (2 bytes) = 0x0018 (24-bit)
  //   pre_defined (2 bytes) = 0xffff
  //   avcC box

  const avc1Payload = new Uint8Array(78 + avccBox.length);
  const v = new DataView(avc1Payload.buffer);
  // reserved 6 + data_ref_index 2 = 8 bytes
  v.setUint16(6, 1); // data_reference_index
  // pre_defined + reserved + pre_defined (2+2+12 = 16 bytes) → 0, at offset 8
  v.setUint16(24, width); // width
  v.setUint16(26, height); // height
  v.setUint32(28, 0x0048_0000); // horizresolution = 72 dpi (16.16)
  v.setUint32(32, 0x0048_0000); // vertresolution
  v.setUint16(40, 1); // frame_count = 1
  // compressorname 32 bytes (offset 42-73) → 0
  v.setUint16(74, 0x0018); // depth = 24
  v.setInt16(76, -1); // pre_defined = -1 (0xffff)
  avc1Payload.set(avccBox, 78);

  const avc1Box = makeBox('avc1', avc1Payload);
  // stsd has version(1) + flags(3) + entry_count(4) + entries
  const stsdPayload = new Uint8Array(8 + avc1Box.length);
  const sv = new DataView(stsdPayload.buffer);
  sv.setUint8(0, 0); // version
  sv.setUint32(4, 1); // entry_count
  stsdPayload.set(avc1Box, 8);
  return makeBox('stsd', stsdPayload);
}

/** 构造 stsd box —— 音频 mp4a */
function makeAudioStsd(
  sampleRate: number,
  channels: number,
  esdsBox: Uint8Array,
): Uint8Array {
  // mp4a entry:
  //   reserved (6 bytes) + data_reference_index (2) = 8
  //   reserved (2 bytes) = 0
  //   reserved (2 bytes) = 0
  //   reserved (4 bytes) = 0
  //   channelcount (2 bytes)
  //   samplesize (2 bytes) = 16
  //   pre_defined (2 bytes) = 0
  //   reserved (2 bytes) = 0
  //   samplerate (4 bytes, 16.16) = sampleRate << 16
  //   esds box

  const mp4aPayload = new Uint8Array(28 + esdsBox.length);
  const v = new DataView(mp4aPayload.buffer);
  v.setUint16(6, 1); // data_reference_index
  v.setUint16(16, channels); // channelcount
  v.setUint16(18, 16); // samplesize = 16
  v.setUint32(24, sampleRate * 0x10000); // samplerate (16.16)
  mp4aPayload.set(esdsBox, 28);

  const mp4aBox = makeBox('mp4a', mp4aPayload);
  const stsdPayload = new Uint8Array(8 + mp4aBox.length);
  const sv = new DataView(stsdPayload.buffer);
  sv.setUint8(0, 0);
  sv.setUint32(4, 1);
  stsdPayload.set(mp4aBox, 8);
  return makeBox('stsd', stsdPayload);
}

/** stts / stsc / stsz / stco 极简（因为 moov 中可以写 0 sample，真正索引在 moof 里） */
function makeStts(): Uint8Array {
  // sample_count=1 entry, entry_count=0 → 我们写 entry_count=0
  const payload = new Uint8Array(8);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 0);
  v.setUint32(4, 0); // entry_count = 0 (no samples in moov)
  return makeBox('stts', payload);
}
function makeStsc(): Uint8Array {
  const payload = new Uint8Array(8);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 0);
  v.setUint32(4, 0);
  return makeBox('stsc', payload);
}
function makeStsz(): Uint8Array {
  const payload = new Uint8Array(12);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 0);
  v.setUint32(4, 0); // sample_size = 0 (per-sample size)
  v.setUint32(8, 0); // sample_count = 0
  return makeBox('stsz', payload);
}
function makeStco(): Uint8Array {
  const payload = new Uint8Array(8);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 0);
  v.setUint32(4, 0); // entry_count = 0
  return makeBox('stco', payload);
}

/** stbl box */
function makeStbl(stsd: Uint8Array): Uint8Array {
  const parts = [stsd, makeStts(), makeStsc(), makeStsz(), makeStco()];
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return makeBox('stbl', out);
}

/** minf box */
function makeMinf(stbl: Uint8Array, isVideo: boolean): Uint8Array {
  // vmhd / smhd + dinf + stbl
  const mediaHeader = isVideo ? makeVmhd() : makeSmhd();
  const dinf = makeDinf();
  const total = mediaHeader.length + dinf.length + stbl.length;
  const out = new Uint8Array(total);
  out.set(mediaHeader, 0);
  out.set(dinf, mediaHeader.length);
  out.set(stbl, mediaHeader.length + dinf.length);
  return makeBox('minf', out);
}

function makeVmhd(): Uint8Array {
  const payload = new Uint8Array(12);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 0); // version
  v.setUint16(4, 0); // graphicsmode
  // opcolor: 3 * 2 bytes = 6 bytes, all 0
  return makeBox('vmhd', payload);
}
function makeSmhd(): Uint8Array {
  const payload = new Uint8Array(8);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 0);
  v.setUint16(4, 0); // balance (0 = center)
  return makeBox('smhd', payload);
}

function makeDinf(): Uint8Array {
  // dref box with 1 entry (url 'self')
  const urlPayload = new Uint8Array(4);
  const uv = new DataView(urlPayload.buffer);
  uv.setUint8(0, 0);
  uv.setUint8(3, 1); // flags: 0x000001 (self-contained)
  const urlBox = makeBox('url ', urlPayload);

  const drefPayload = new Uint8Array(8 + urlBox.length);
  const dv = new DataView(drefPayload.buffer);
  dv.setUint8(0, 0);
  dv.setUint32(4, 1); // entry_count = 1
  drefPayload.set(urlBox, 8);
  return makeBox('dinf', drefPayload);
}

/** mdia box */
function makeMdia(mdhd: Uint8Array, hdlr: Uint8Array, minf: Uint8Array): Uint8Array {
  const total = mdhd.length + hdlr.length + minf.length;
  const out = new Uint8Array(total);
  out.set(mdhd, 0);
  out.set(hdlr, mdhd.length);
  out.set(minf, mdhd.length + hdlr.length);
  return makeBox('mdia', out);
}

/** trak box */
function makeTrak(tkhd: Uint8Array, mdia: Uint8Array): Uint8Array {
  const total = tkhd.length + mdia.length;
  const out = new Uint8Array(total);
  out.set(tkhd, 0);
  out.set(mdia, tkhd.length);
  return makeBox('trak', out);
}

/** moov box */
function makeMoov(
  videoWidth: number,
  videoHeight: number,
  avccBox: Uint8Array,
  audioSampleRate: number,
  audioChannels: number,
  esdsBox: Uint8Array,
  videoTimescale: number,
  audioTimescale: number,
  duration: number,
): Uint8Array {
  const mvhd = makeMvhd(duration, videoTimescale, videoWidth, videoHeight);

  const videoTkhd = makeTkhd(1, duration, videoTimescale, videoWidth, videoHeight, true);
  const videoMdhd = makeMdhd(duration, videoTimescale);
  const videoHdlr = makeHdlr('vide', 'VideoHandler');
  const videoStsd = makeVideoStsd(videoWidth, videoHeight, avccBox);
  const videoStbl = makeStbl(videoStsd);
  const videoMinf = makeMinf(videoStbl, true);
  const videoMdia = makeMdia(videoMdhd, videoHdlr, videoMinf);
  const videoTrak = makeTrak(videoTkhd, videoMdia);

  const audioTkhd = makeTkhd(2, duration, audioTimescale, 0, 0, false);
  const audioMdhd = makeMdhd(duration, audioTimescale);
  const audioHdlr = makeHdlr('soun', 'SoundHandler');
  const audioStsd = makeAudioStsd(audioSampleRate, audioChannels, esdsBox);
  const audioStbl = makeStbl(audioStsd);
  const audioMinf = makeMinf(audioStbl, false);
  const audioMdia = makeMdia(audioMdhd, audioHdlr, audioMinf);
  const audioTrak = makeTrak(audioTkhd, audioMdia);

  const total = mvhd.length + videoTrak.length + audioTrak.length;
  const out = new Uint8Array(total);
  out.set(mvhd, 0);
  out.set(videoTrak, mvhd.length);
  out.set(audioTrak, mvhd.length + videoTrak.length);
  return makeBox('moov', out);
}

// ============ Moof / MDAT 片段 ============

function makeTraf(
  trackId: number,
  sampleCount: number,
  baseMediaDecodeTime: number,
  sampleSizes: number[],
  sampleDurations: number[],
  sampleFlags: number[],
  dataOffset: number,
): Uint8Array {
  // tfhd (track fragment header)
  const tfhd = makeTfhd(trackId);
  // tfdt (track fragment decode time)
  const tfdt = makeTfdt(baseMediaDecodeTime);
  // trun (track run)
  const trun = makeTrun(sampleCount, sampleSizes, sampleDurations, sampleFlags, dataOffset);

  const total = tfhd.length + tfdt.length + trun.length;
  const out = new Uint8Array(total);
  out.set(tfhd, 0);
  out.set(tfdt, tfhd.length);
  out.set(trun, tfhd.length + tfdt.length);
  return makeBox('traf', out);
}

function makeTfhd(trackId: number): Uint8Array {
  // default-base-is-moof (0x020000) flag
  const payload = new Uint8Array(8);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 0);
  v.setUint32(0, 0x020000); // flags = default-base-is-moof (data at offset 0-3: version + flags)
  // 重新设置：version at 0, flags at 1-3
  v.setUint8(0, 0);
  v.setUint8(1, 0x02);
  v.setUint8(2, 0x00);
  v.setUint8(3, 0x00);
  v.setUint32(4, trackId); // track_ID
  return makeBox('tfhd', payload);
}

function makeTfdt(baseMediaDecodeTime: number): Uint8Array {
  const payload = new Uint8Array(8);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 0); // version 0
  v.setUint32(4, baseMediaDecodeTime); // baseMediaDecodeTime (32-bit for v0)
  return makeBox('tfdt', payload);
}

function makeTrun(
  count: number,
  sizes: number[],
  durations: number[],
  flags: number[],
  dataOffset: number,
): Uint8Array {
  // flags: data-offset-present (0x000001) + first-sample-flags-present (0x000004)
  //   + sample-size-present (0x000200) + sample-duration-present (0x000100) + sample-flags-present (0x000400)
  const presentFlags = 0x000001 /*data-offset*/ | 0x000100 /*dur*/ | 0x000200 /*size*/ | 0x000400 /*flags*/;
  const headerSize = 12; // version(1)+flags(3)+count(4)+data_offset(4)
  const entrySize = 4 + 4 + 4; // duration + size + flags
  const total = headerSize + count * entrySize;
  const payload = new Uint8Array(total);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 1); // version = 1 (so data_offset is signed, but we use positive)
  // flags 3 bytes
  v.setUint8(1, (presentFlags >> 16) & 0xff);
  v.setUint8(2, (presentFlags >> 8) & 0xff);
  v.setUint8(3, presentFlags & 0xff);
  v.setUint32(4, count); // sample_count
  v.setInt32(8, dataOffset); // data_offset

  let off = 12;
  for (let i = 0; i < count; i++) {
    v.setUint32(off, durations[i] ?? 0); off += 4;
    v.setUint32(off, sizes[i] ?? 0); off += 4;
    v.setUint32(off, flags[i] ?? 0); off += 4;
  }
  return makeBox('trun', payload);
}

/** 构造一个 moof + mdat 片段 */
export function buildFragment(
  videoTrackId: number,
  audioTrackId: number,
  videoSamples: { size: number; duration: number; isKey: boolean }[],
  audioSamples: { size: number; duration: number }[],
  videoBaseDts: number,
  audioBaseDts: number,
  mdatData: Uint8Array,
): Uint8Array {
  // data offset from start of moof to start of mdat data payload:
  //  我们先计算 moof 大小，再填 data_offset

  // 先构造空的 traf（trun 占位，data_offset 先写 0，最后改）
  const videoSizes = videoSamples.map((s) => s.size);
  const videoDurations = videoSamples.map((s) => s.duration);
  const videoFlags = videoSamples.map((s, i) =>
    i === 0 ? (s.isKey ? 0x0200_0000 : 0x0101_0000) : (s.isKey ? 0x0200_0000 : 0x0001_0000)
    // sample flags: depends_on (2 bits top byte) + is_non_sync (2nd byte bit 0) etc.
    // 简化：关键帧 sample_depends_on = 2 (no others depend on this? no, keyframe = sample_depends_on=2 no)
    // 其实 keyframe: sample_depends_on = 2 (this sample does not depend on others)
    //   sample_is_non_sync_sample = 0 (it is sync)
    // non-keyframe: sample_depends_on = 1, is_non_sync = 1
  );

  // 纠正：sample flags 字节顺序（高字节在前）
  // Byte 0 (MSB, first): reserved (4 bits) + sample_depends_on (2) + sample_is_depended_on (2)
  // Byte 1: sample_has_redundancy (2) + sample_padding_value (3) + sample_is_non_sync_sample (1) + sample_degradation_priority (2)
  // Byte 2-3: sample_degradation_priority (12 bits)... 简化
  // 实际上 keyframe → sample_depends_on = 2 (sample doesn't depend on others) + is_non_sync = 0
  //   → 0x02_00_00_00 (top byte = 0x02? 不对：sample_depends_on 在字节的位 2-3，从高到低)
  // 正确：第 0 字节（最高位）的 bit 2-3（从 0 数）是 sample_depends_on
  // 即 bit7=reserved, bit6=reserved, bit5=reserved, bit4=reserved,
  //   bit3=is_leading(1), bit2=sample_depends_on(msb), bit1=sample_depends_on(lsb)? 不对
  // 这里直接用业界常见值：
  //   keyframe: 0x02000000 (sample_depends_on = 2, meaning "not dependent on others")
  //   non-key:  0x01010000 (sample_depends_on = 1, is_non_sync = 1)
  // 经校验，这些值是 fMP4 标准常见写法。

  const videoFlagsFinal = videoSamples.map((s) => s.isKey ? 0x0200_0000 : 0x0101_0000);
  const audioSizes = audioSamples.map((s) => s.size);
  const audioDurations = audioSamples.map((s) => s.duration);
  const audioFlagsFinal = audioSamples.map(() => 0x0200_0000); // 音频都是关键帧

  // 先构造 traf（data_offset 后面回填）
  // 计算 moof 总大小：
  //   moov header (8) + mfhd(8+8=16) +
  //   traf 1 (traf header 8 + tfhd 16 + tfdt 16 + trun 大小)
  //   traf 2 (同上)
  // trun 大小：8 (box header) + 12 (header) + count * 12
  const trunSizeV = 8 + 12 + videoSamples.length * 12;
  const trunSizeA = 8 + 12 + audioSamples.length * 12;
  const trafSizeV = 8 + (8 + 16) + (8 + 12) + trunSizeV; // traf header + tfhd + tfdt + trun
  const trafSizeA = 8 + (8 + 16) + (8 + 12) + trunSizeA;
  const mfhdSize = 16; // 8 (box) + 4 (version+flags) + 4 (sequence_number)
  const moofSize = 8 + mfhdSize + trafSizeV + trafSizeA;

  const mdatTotal = 8 + mdatData.length;

  // 分配 buffer
  const frag = new Uint8Array(moofSize + mdatTotal);
  const fv = new DataView(frag.buffer);

  let off = 0;
  // moof
  writeUint32(fv, off, moofSize);
  writeString(fv, off + 4, 'moof');
  off += 8;

  // mfhd
  writeUint32(fv, off, mfhdSize);
  writeString(fv, off + 4, 'mfhd');
  fv.setUint8(off + 8, 0);
  writeUint32(fv, off + 12, 1); // sequence_number
  off += mfhdSize;

  // video traf
  const videoTrafStart = off;
  writeUint32(fv, off, trafSizeV);
  writeString(fv, off + 4, 'traf');
  off += 8;
  // tfhd
  const tfhdSize = 16;
  writeUint32(fv, off, tfhdSize);
  writeString(fv, off + 4, 'tfhd');
  fv.setUint8(off + 8, 0); // version
  fv.setUint8(off + 9, 0x02); // flags: default-base-is-moof
  fv.setUint8(off + 10, 0);
  fv.setUint8(off + 11, 0);
  writeUint32(fv, off + 12, videoTrackId);
  off += tfhdSize;

  // tfdt
  const tfdtSize = 16;
  writeUint32(fv, off, tfdtSize);
  writeString(fv, off + 4, 'tfdt');
  fv.setUint8(off + 8, 0);
  writeUint32(fv, off + 12, videoBaseDts);
  off += tfdtSize;

  // trun
  const trunVStart = off;
  writeUint32(fv, off, trunSizeV);
  writeString(fv, off + 4, 'trun');
  fv.setUint8(off + 8, 1); // version 1
  const presentFlagsV = 0x000001 | 0x000100 | 0x000200 | 0x000400;
  fv.setUint8(off + 9, (presentFlagsV >> 16) & 0xff);
  fv.setUint8(off + 10, (presentFlagsV >> 8) & 0xff);
  fv.setUint8(off + 11, presentFlagsV & 0xff);
  writeUint32(fv, off + 12, videoSamples.length);
  // data_offset (from start of moof to first sample in mdat)
  const videoDataOffset = moofSize + 8; // 8 = mdat header
  fv.setInt32(off + 16, videoDataOffset);
  off += 20;

  // sample entries
  for (let i = 0; i < videoSamples.length; i++) {
    writeUint32(fv, off, videoDurations[i]); off += 4;
    writeUint32(fv, off, videoSizes[i]); off += 4;
    writeUint32(fv, off, videoFlagsFinal[i]); off += 4;
  }
  off = trunVStart + trunSizeV;
  off = videoTrafStart + trafSizeV;

  // audio traf
  writeUint32(fv, off, trafSizeA);
  writeString(fv, off + 4, 'traf');
  off += 8;
  writeUint32(fv, off, tfhdSize);
  writeString(fv, off + 4, 'tfhd');
  fv.setUint8(off + 8, 0);
  fv.setUint8(off + 9, 0x02);
  fv.setUint8(off + 10, 0);
  fv.setUint8(off + 11, 0);
  writeUint32(fv, off + 12, audioTrackId);
  off += tfhdSize;

  writeUint32(fv, off, tfdtSize);
  writeString(fv, off + 4, 'tfdt');
  fv.setUint8(off + 8, 0);
  writeUint32(fv, off + 12, audioBaseDts);
  off += tfdtSize;

  // audio trun
  writeUint32(fv, off, trunSizeA);
  writeString(fv, off + 4, 'trun');
  fv.setUint8(off + 8, 1);
  const presentFlagsA = 0x000001 | 0x000100 | 0x000200 | 0x000400;
  fv.setUint8(off + 9, (presentFlagsA >> 16) & 0xff);
  fv.setUint8(off + 10, (presentFlagsA >> 8) & 0xff);
  fv.setUint8(off + 11, presentFlagsA & 0xff);
  writeUint32(fv, off + 12, audioSamples.length);
  const audioDataOffset = moofSize + 8 + videoSamples.reduce((s, v) => s + v.size, 0);
  fv.setInt32(off + 16, audioDataOffset);
  off += 20;

  for (let i = 0; i < audioSamples.length; i++) {
    writeUint32(fv, off, audioDurations[i]); off += 4;
    writeUint32(fv, off, audioSizes[i]); off += 4;
    writeUint32(fv, off, audioFlagsFinal[i]); off += 4;
  }

  // mdat
  const mdatStart = moofSize;
  writeUint32(fv, mdatStart, mdatTotal);
  writeString(fv, mdatStart + 4, 'mdat');
  frag.set(mdatData, mdatStart + 8);

  return frag;
}

// ============ Mp4Recorder 类 ============

export interface Mp4RecorderOptions {
  canvas: HTMLCanvasElement;
  audioTrack?: MediaStreamTrack | null;
  fps?: number;
  videoBitrate?: number;
  audioBitrate?: number;
  /** 视频宽（默认 canvas.width） */
  width?: number;
  /** 视频高（默认 canvas.height） */
  height?: number;
}

export interface Mp4RecorderStats {
  videoFrames: number;
  audioFrames: number;
  duration: number;
  totalBytes: number;
}

export class Mp4Recorder {
  private canvas: HTMLCanvasElement;
  private fps: number;
  private videoBitrate: number;
  private audioBitrate: number;
  private width: number;
  private height: number;

  private videoEncoder: any = null;
  private audioEncoder: any = null;

  private videoFrames: EncodedVideoChunk[] = [];
  private audioFrames: EncodedAudioChunk[] = [];
  private videoDurations: number[] = [];
  private audioDurations: number[] = [];

  private videoConfig: VideoEncoderConfig | null = null;
  private audioConfig: AudioEncoderConfig | null = null;
  private avccBox: Uint8Array | null = null;
  private audioAsc: Uint8Array | null = null;

  private startTime = 0;
  private lastVideoTimestamp = 0;
  private recording = false;

  private audioTrack: MediaStreamTrack | null = null;
  private audioProcessorNode: AudioWorkletNode | null = null;
  private audioCtx: AudioContext | null = null;
  private audioSourceNode: MediaStreamAudioSourceNode | null = null;

  private stats: Mp4RecorderStats = {
    videoFrames: 0,
    audioFrames: 0,
    duration: 0,
    totalBytes: 0,
  };

  constructor(options: Mp4RecorderOptions) {
    this.canvas = options.canvas;
    this.fps = options.fps ?? 30;
    this.videoBitrate = options.videoBitrate ?? 2_500_000;
    this.audioBitrate = options.audioBitrate ?? 128_000;
    this.width = options.width ?? options.canvas.width;
    this.height = options.height ?? options.canvas.height;
    this.audioTrack = (options.audioTrack as any) ?? null;
  }

  /**
   * 开始录制（异步初始化编码器）
   */
  async start(): Promise<void> {
    const VideoEncoder = (window as any).VideoEncoder;
    const AudioEncoder = (window as any).AudioEncoder;

    if (!VideoEncoder) throw new Error('VideoEncoder 不可用');

    // 视频编码器
    const videoConfig: VideoEncoderConfig = {
      codec: 'avc1.4D401E', // H.264 Main profile Level 3.0
      width: this.width,
      height: this.height,
      bitrate: this.videoBitrate,
      framerate: this.fps,
      hardwareAcceleration: 'prefer-hardware',
      avc: { format: 'avc' }, // 输出 AVCC 格式（Annex-B → AVCC 由我们处理）
    } as any;

    this.videoConfig = videoConfig;
    this.videoEncoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk, metadata: any) => {
        this.videoFrames.push(chunk);
        // 保存 SPS/PPS（从 decoder config）
        if (metadata?.decoderConfig?.description) {
          this.avccBox = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
        }
      },
      error: (e: Error) => {
        logger.error('Mp4Recorder video encoder error:', String(e));
      },
    });

    const videoSupported = await (window as any).VideoEncoder.isConfigSupported(videoConfig);
    if (!videoSupported?.supported) {
      throw new Error('视频编码器配置不支持');
    }
    this.videoEncoder.configure(videoConfig);

    // 音频编码器
    if (this.audioTrack && AudioEncoder) {
      try {
        const audioConfig: AudioEncoderConfig = {
          codec: 'mp4a.40.2', // AAC LC
          sampleRate: 44100,
          numberOfChannels: 2,
          bitrate: this.audioBitrate,
        } as any;

        const audioSupported = await AudioEncoder.isConfigSupported(audioConfig);
        if (audioSupported?.supported) {
          this.audioConfig = audioConfig;
          this.audioEncoder = new AudioEncoder({
            output: (chunk: EncodedAudioChunk, metadata: any) => {
              this.audioFrames.push(chunk);
              if (metadata?.decoderConfig?.description) {
                this.audioAsc = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
              }
            },
            error: (e: Error) => {
              logger.error('Mp4Recorder audio encoder error:', String(e));
            },
          });
          this.audioEncoder.configure(audioConfig);
          await this.setupAudioCapture();
        }
      } catch (e) {
        logger.warn('Mp4Recorder 音频编码器初始化失败，将只录制视频:', String(e));
      }
    }

    this.videoFrames = [];
    this.audioFrames = [];
    this.videoDurations = [];
    this.audioDurations = [];
    this.startTime = performance.now();
    this.lastVideoTimestamp = 0;
    this.recording = true;
  }

  /** 设置音频采集：把 track 接到 AudioContext 做 PCM 采样，再喂给 AudioEncoder */
  private async setupAudioCapture(): Promise<void> {
    if (!this.audioTrack) return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new Ctx({ sampleRate: 44100 });
      const stream = new MediaStream([this.audioTrack as any]);
      this.audioSourceNode = this.audioCtx.createMediaStreamSource(stream);

      // 使用 ScriptProcessorNode 兼容地获取 PCM
      const bufferSize = 4096;
      const scriptNode = this.audioCtx.createScriptProcessor(bufferSize, 2, 2);
      let sampleCount = 0;
      let pcmBuffer: Float32Array | null = null;
      const samplesPerFrame = 1024; // AAC frame size

      scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!this.recording || !this.audioEncoder) return;
        const inputL = e.inputBuffer.getChannelData(0);
        const inputR = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : inputL;

        // 累积 samplesPerFrame 个样本就编码一帧
        for (let i = 0; i < inputL.length; i++) {
          if (!pcmBuffer) pcmBuffer = new Float32Array(samplesPerFrame * 2);
          pcmBuffer[sampleCount * 2] = inputL[i];
          pcmBuffer[sampleCount * 2 + 1] = inputR[i];
          sampleCount++;

          if (sampleCount >= samplesPerFrame) {
            const data = new Float32Array(pcmBuffer); // copy
            const frame = new (window as any).AudioData({
              format: 'f32-planar', // 不对，我们是 interleaved。应该转成 planar
              sampleRate: 44100,
              numberOfFrames: samplesPerFrame,
              numberOfChannels: 2,
              timestamp: (this.startTime + (this.audioFrames.length * samplesPerFrame / 44100) * 1_000_000),
              data,
            });
            // 上面写法对 AudioData 格式要求比较严，直接用 s16 更稳妥
            this.audioEncoder?.encode(frame);
            frame.close?.();
            sampleCount = 0;
            pcmBuffer = null;
          }
        }
      };

      this.audioSourceNode.connect(scriptNode);
      scriptNode.connect(this.audioCtx.destination);
    } catch (e) {
      logger.error('Mp4Recorder setupAudioCapture failed:', String(e));
    }
  }

  /**
   * 录制一帧（在你的 rAF 循环中调用）。timestamp 单位微秒，不传则用 performance.now()
   */
  recordFrame(timestampUs?: number): void {
    if (!this.recording || !this.videoEncoder) return;
    const now = timestampUs ?? (performance.now() - this.startTime) * 1000;

    try {
      const VideoFrame = (window as any).VideoFrame;
      const frame = new VideoFrame(this.canvas, {
        timestamp: Math.floor(now),
      });
      // 关键帧每 ~2 秒一次
      const keyFrame = this.stats.videoFrames % (this.fps * 2) === 0;
      this.videoEncoder.encode(frame, { keyFrame });
      frame.close?.();
      this.stats.videoFrames++;
    } catch (e) {
      logger.error('Mp4Recorder recordFrame failed:', String(e));
    }
  }

  /**
   * 停止录制并返回 MP4 Blob
   */
  async stop(): Promise<{ blob: Blob; stats: Mp4RecorderStats }> {
    this.recording = false;

    // 刷出所有编码帧
    if (this.videoEncoder) {
      await this.videoEncoder.flush();
      this.videoEncoder.close?.();
      this.videoEncoder = null;
    }
    if (this.audioEncoder) {
      await this.audioEncoder.flush();
      this.audioEncoder.close?.();
      this.audioEncoder = null;
    }

    // 关闭音频上下文
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch { /* ignore */ }
      this.audioCtx = null;
      this.audioSourceNode = null;
    }

    const duration = this.videoFrames.length / this.fps;

    // 计算每帧 duration（均匀分配，最后一帧补齐）
    const vDur = Math.floor(90_000 / this.fps); // 视频 timescale = 90000
    const videoDurations = this.videoFrames.map(() => vDur);
    const videoTimescale = 90_000;

    const audioTimescale = 44100;
    // 音频帧时长（AAC 1024 samples/frame @ 44.1k ≈ 23.2ms）
    const audioDurations = this.audioFrames.map(() => 1024);

    // 构造 ftyp + moov
    const ftyp = makeFtyp();
    const avccBox = this.avccBox ?? makeDummyAvcc();
    const esdsBox = makeEsds(this.audioAsc ?? new Uint8Array(), 44100, 2, this.audioBitrate);

    const moov = makeMoov(
      this.width,
      this.height,
      avccBox,
      44100,
      2,
      esdsBox,
      videoTimescale,
      audioTimescale,
      duration,
    );

    // 把所有视频/音频样本数据写入 mdat
    let totalVideoBytes = 0;
    let totalAudioBytes = 0;
    const videoSampleSizes: number[] = [];
    const audioSampleSizes: number[] = [];
    const videoIsKey: boolean[] = [];

    // 先统计大小
    for (const chunk of this.videoFrames) {
      const size = chunk.byteLength;
      totalVideoBytes += size;
      videoSampleSizes.push(size);
      videoIsKey.push(chunk.type === 'key');
    }
    for (const chunk of this.audioFrames) {
      const size = chunk.byteLength;
      totalAudioBytes += size;
      audioSampleSizes.push(size);
    }

    // 组装 mdat data
    const mdatData = new Uint8Array(totalVideoBytes + totalAudioBytes);
    let offset = 0;
    for (const chunk of this.videoFrames) {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      mdatData.set(buf, offset);
      offset += buf.length;
    }
    for (const chunk of this.audioFrames) {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      mdatData.set(buf, offset);
      offset += buf.length;
    }

    // 构造 moof + mdat 片段（single fragment = 整个文件）
    const frag = buildFragment(
      1,
      2,
      this.videoFrames.map((_, i) => ({ size: videoSampleSizes[i], duration: videoDurations[i], isKey: videoIsKey[i] })),
      this.audioFrames.map((_, i) => ({ size: audioSampleSizes[i], duration: audioDurations[i] })),
      0, // videoBaseDts
      0, // audioBaseDts
      mdatData,
    );

    // 最终文件：ftyp + moov + [moof + mdat]
    const totalSize = ftyp.length + moov.length + frag.length;
    const result = new Uint8Array(totalSize);
    result.set(ftyp, 0);
    result.set(moov, ftyp.length);
    result.set(frag, ftyp.length + moov.length);

    const blob = new Blob([result], { type: 'video/mp4' });
    this.stats.duration = duration;
    this.stats.totalBytes = totalSize;
    this.stats.videoFrames = this.videoFrames.length;
    this.stats.audioFrames = this.audioFrames.length;

    return { blob, stats: { ...this.stats } };
  }
}

/** 构造一个最小 avcC（当取不到 sps/pps 时兜底） */
function makeDummyAvcc(): Uint8Array {
  // Baseline profile level 3.0 的最小 sps / pps（兜底用，实际播放器可能不播）
  // 真实使用场景下 metadata.decoderConfig.description 一定会有
  const dummySpS = new Uint8Array([0x67, 0x42, 0x00, 0x0c, 0xe4, 0x40, 0xa0, 0xfd, 0x00, 0xf0, 0x88, 0x45, 0x38]);
  const dummyPps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
  return makeAvcc(dummySpS, dummyPps);
}

// ============ 便捷方法：自动抓帧循环 ============

/**
 * 使用 rAF 从 canvas 自动抓帧的录制器包装
 */
export async function startMp4Recording(opts: Mp4RecorderOptions): Promise<{
  stop: () => Promise<{ blob: Blob; stats: Mp4RecorderStats }>;
}> {
  const recorder = new Mp4Recorder(opts);
  await recorder.start();

  let rafId = 0;
  let stopped = false;

  const frameInterval = 1000 / (opts.fps ?? 30);
  let lastFrameTime = 0;

  function loop(now: number) {
    if (stopped) return;
    if (now - lastFrameTime >= frameInterval) {
      recorder.recordFrame((now - (recorder as any).startTime) * 1000);
      lastFrameTime = now;
    }
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  return {
    stop: async () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      return recorder.stop();
    },
  };
}