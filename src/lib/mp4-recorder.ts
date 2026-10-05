/**
 * MP4 录制器（WebCodecs 方案）
 */

import { logger } from '@lark-apaas/client-toolkit-lite';

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
    videoAvc1: false, audioAac: false, mediaRecorderMp4: false, mediaRecorderWebm: false,
  };
  if (info.webCodecsVideo) {
    try {
      const VideoEncoder = (window as any).VideoEncoder;
      const result = await VideoEncoder.isConfigSupported({ codec: 'avc1.4D401E', width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 });
      info.videoAvc1 = !!result?.supported;
    } catch { info.videoAvc1 = false; }
  }
  if (info.webCodecsAudio) {
    try {
      const AudioEncoder = (window as any).AudioEncoder;
      const result = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 128_000 });
      info.audioAac = !!result?.supported;
    } catch { info.audioAac = false; }
  }
  const MR = (window as any).MediaRecorder;
  if (MR && typeof MR.isTypeSupported === 'function') {
    info.mediaRecorderMp4 = MR.isTypeSupported('video/mp4;codecs=avc1.4D401E,mp4a.40.2') || MR.isTypeSupported('video/mp4');
    info.mediaRecorderWebm = MR.isTypeSupported('video/webm;codecs=vp9,opus') || MR.isTypeSupported('video/webm');
  }
  cachedSupport = info;
  return info;
}

function writeUint32(view: DataView, offset: number, value: number) { view.setUint32(offset, value, false); }
function writeString(view: DataView, offset: number, str: string) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }

function makeBox(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  writeUint32(view, 0, size);
  writeString(view, 4, type);
  buf.set(payload, 8);
  return buf;
}

function makeFtyp(): Uint8Array {
  const payload = new Uint8Array(28);
  const view = new DataView(payload.buffer);
  writeString(view, 0, 'iso5');
  writeUint32(view, 4, 512);
  writeString(view, 8, 'iso5');
  writeString(view, 12, 'mp41');
  writeString(view, 16, 'avc1');
  writeString(view, 20, 'iso2');
  return makeBox('ftyp', payload);
}

function makeMvhd(duration: number, timescale: number, width: number, height: number): Uint8Array {
  const data = new Uint8Array(108);
  const v = new DataView(data.buffer);
  v.setUint32(12, timescale);
  v.setUint32(16, Math.floor(duration * timescale));
  v.setUint32(20, 0x00010000);
  v.setUint16(24, 0x0100);
  v.setUint32(32, 0x00010000);
  v.setUint32(48, 0x00010000);
  v.setUint32(64, 0x40000000);
  v.setUint32(76, 2);
  return makeBox('mvhd', data);
}

function makeTkhd(trackId: number, duration: number, timescale: number, width: number, height: number, isVideo: boolean): Uint8Array {
  const data = new Uint8Array(84);
  const v = new DataView(data.buffer);
  v.setUint8(3, 0x03);
  v.setUint32(12, trackId);
  v.setUint32(20, Math.floor(duration * timescale));
  v.setUint16(36, 0x0100);
  v.setUint32(40, 0x00010000);
  v.setUint32(56, 0x00010000);
  v.setUint32(72, 0x40000000);
  v.setUint32(76, Math.floor(width * 0x10000));
  v.setUint32(80, Math.floor(height * 0x10000));
  return makeBox('tkhd', data);
}

function makeMdhd(duration: number, timescale: number): Uint8Array {
  const data = new Uint8Array(32);
  const v = new DataView(data.buffer);
  v.setUint32(12, timescale);
  v.setUint32(16, Math.floor(duration * timescale));
  v.setUint16(20, 0x55C4);
  return makeBox('mdhd', data);
}

function makeHdlr(handlerType: string, name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const payload = new Uint8Array(24 + nameBytes.length + 1);
  const v = new DataView(payload.buffer);
  writeString(v, 8, handlerType);
  payload.set(nameBytes, 24);
  payload[24 + nameBytes.length] = 0;
  return makeBox('hdlr', payload);
}

function makeAvcc(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const payload = new Uint8Array(7 + sps.length + 2 + pps.length);
  const v = new DataView(payload.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, sps[1]);
  v.setUint8(2, sps[2]);
  v.setUint8(3, sps[3]);
  v.setUint8(4, 0xff);
  v.setUint8(5, 0xe1);
  v.setUint16(6, sps.length);
  payload.set(sps, 8);
  let off = 8 + sps.length;
  v.setUint8(off, 1);
  v.setUint16(off + 1, pps.length);
  payload.set(pps, off + 3);
  return makeBox('avcC', payload);
}

function makeEsds(audioConfig: Uint8Array, sampleRate: number, channels: number, bitrate: number): Uint8Array {
  const asc = audioConfig.length > 0 ? audioConfig : buildAsc(sampleRate, channels);
  const dsi = makeDescriptor(0x05, asc);
  const decConfig = makeDecoderConfigDesc(bitrate, dsi);
  const esBody = new Uint8Array(3 + decConfig.length + 3);
  const v1 = new DataView(esBody.buffer);
  v1.setUint16(0, 2);
  v1.setUint8(2, 0);
  esBody.set(decConfig, 3);
  const sl = new Uint8Array([0x06, 1, 0x02]);
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
  if (size < 0x80) return new Uint8Array([size]);
  if (size < 0x4000) return new Uint8Array([(size >> 7) | 0x80, size & 0x7f]);
  if (size < 0x200000) return new Uint8Array([(size >> 14) | 0x80, ((size >> 7) & 0x7f) | 0x80, size & 0x7f]);
  return new Uint8Array([(size >> 21) | 0x80, ((size >> 14) & 0x7f) | 0x80, ((size >> 7) & 0x7f) | 0x80, size & 0x7f]);
}

function makeDecoderConfigDesc(bitrate: number, dsi: Uint8Array): Uint8Array {
  const body = new Uint8Array(13 + dsi.length);
  const v = new DataView(body.buffer);
  v.setUint8(0, 0x40);
  v.setUint8(1, 0x15);
  v.setUint16(3, 6144);
  v.setUint32(5, bitrate);
  v.setUint32(9, bitrate);
  body.set(dsi, 13);
  return makeDescriptor(0x04, body);
}

function buildAsc(sampleRate: number, channels: number): Uint8Array {
  const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  let freqIdx = sampleRates.indexOf(sampleRate);
  if (freqIdx === -1) freqIdx = 4;
  const bits = (2 << 11) | (freqIdx << 7) | (channels << 3);
  return new Uint8Array([(bits >> 8) & 0xff, bits & 0xff]);
}

function makeVideoStsd(width: number, height: number, avccBox: Uint8Array): Uint8Array {
  const avc1Payload = new Uint8Array(78 + avccBox.length);
  const v = new DataView(avc1Payload.buffer);
  v.setUint16(6, 1);
  v.setUint16(24, width);
  v.setUint16(26, height);
  v.setUint32(28, 0x00480000);
  v.setUint32(32, 0x00480000);
  v.setUint16(40, 1);
  v.setUint16(74, 0x0018);
  v.setInt16(76, -1);
  avc1Payload.set(avccBox, 78);
  const avc1Box = makeBox('avc1', avc1Payload);
  const stsdPayload = new Uint8Array(8 + avc1Box.length);
  const sv = new DataView(stsdPayload.buffer);
  sv.setUint32(4, 1);
  stsdPayload.set(avc1Box, 8);
  return makeBox('stsd', stsdPayload);
}

function makeAudioStsd(sampleRate: number, channels: number, esdsBox: Uint8Array): Uint8Array {
  const mp4aPayload = new Uint8Array(28 + esdsBox.length);
  const v = new DataView(mp4aPayload.buffer);
  v.setUint16(6, 1);
  v.setUint16(16, channels);
  v.setUint16(18, 16);
  v.setUint32(24, sampleRate * 0x10000);
  mp4aPayload.set(esdsBox, 28);
  const mp4aBox = makeBox('mp4a', mp4aPayload);
  const stsdPayload = new Uint8Array(8 + mp4aBox.length);
  const sv = new DataView(stsdPayload.buffer);
  sv.setUint32(4, 1);
  stsdPayload.set(mp4aBox, 8);
  return makeBox('stsd', stsdPayload);
}

function makeStts(): Uint8Array { const p = new Uint8Array(8); new DataView(p.buffer).setUint32(4, 0); return makeBox('stts', p); }
function makeStsc(): Uint8Array { const p = new Uint8Array(8); new DataView(p.buffer).setUint32(4, 0); return makeBox('stsc', p); }
function makeStsz(): Uint8Array { const p = new Uint8Array(12); return makeBox('stsz', p); }
function makeStco(): Uint8Array { const p = new Uint8Array(8); new DataView(p.buffer).setUint32(4, 0); return makeBox('stco', p); }

function makeStbl(stsd: Uint8Array): Uint8Array {
  const parts = [stsd, makeStts(), makeStsc(), makeStsz(), makeStco()];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return makeBox('stbl', out);
}

function makeVmhd(): Uint8Array { return makeBox('vmhd', new Uint8Array(12)); }
function makeSmhd(): Uint8Array { return makeBox('smhd', new Uint8Array(8)); }

function makeDinf(): Uint8Array {
  const urlBox = makeBox('url ', new Uint8Array([0, 0, 0, 1]));
  const drefPayload = new Uint8Array(8 + urlBox.length);
  new DataView(drefPayload.buffer).setUint32(4, 1);
  drefPayload.set(urlBox, 8);
  const dref = makeBox('dref', drefPayload);
  return makeBox('dinf', dref);
}

function makeMinf(stbl: Uint8Array, isVideo: boolean): Uint8Array {
  const mediaHeader = isVideo ? makeVmhd() : makeSmhd();
  const dinf = makeDinf();
  const total = mediaHeader.length + dinf.length + stbl.length;
  const out = new Uint8Array(total);
  out.set(mediaHeader, 0);
  out.set(dinf, mediaHeader.length);
  out.set(stbl, mediaHeader.length + dinf.length);
  return makeBox('minf', out);
}

function makeMdia(mdhd: Uint8Array, hdlr: Uint8Array, minf: Uint8Array): Uint8Array {
  const total = mdhd.length + hdlr.length + minf.length;
  const out = new Uint8Array(total);
  out.set(mdhd, 0);
  out.set(hdlr, mdhd.length);
  out.set(minf, mdhd.length + hdlr.length);
  return makeBox('mdia', out);
}

function makeTrak(tkhd: Uint8Array, mdia: Uint8Array): Uint8Array {
  const total = tkhd.length + mdia.length;
  const out = new Uint8Array(total);
  out.set(tkhd, 0);
  out.set(mdia, tkhd.length);
  return makeBox('trak', out);
}

function makeMoov(videoWidth: number, videoHeight: number, avccBox: Uint8Array, audioSampleRate: number, audioChannels: number, esdsBox: Uint8Array, videoTimescale: number, audioTimescale: number, duration: number): Uint8Array {
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

export function buildFragment(videoTrackId: number, audioTrackId: number, videoSamples: { size: number; duration: number; isKey: boolean }[], audioSamples: { size: number; duration: number }[], videoBaseDts: number, audioBaseDts: number, mdatData: Uint8Array): Uint8Array {
  const videoSizes = videoSamples.map((s) => s.size);
  const videoDurations = videoSamples.map((s) => s.duration);
  const videoFlagsFinal = videoSamples.map((s) => s.isKey ? 0x02000000 : 0x01010000);
  const audioSizes = audioSamples.map((s) => s.size);
  const audioDurations = audioSamples.map((s) => s.duration);
  const audioFlagsFinal = audioSamples.map(() => 0x02000000);
  const trunSizeV = 8 + 12 + videoSamples.length * 12;
  const trunSizeA = 8 + 12 + audioSamples.length * 12;
  const trafSizeV = 8 + 24 + 20 + trunSizeV;
  const trafSizeA = 8 + 24 + 20 + trunSizeA;
  const mfhdSize = 16;
  const moofSize = 8 + mfhdSize + trafSizeV + trafSizeA;
  const mdatTotal = 8 + mdatData.length;
  const frag = new Uint8Array(moofSize + mdatTotal);
  const fv = new DataView(frag.buffer);
  let off = 0;
  writeUint32(fv, off, moofSize); writeString(fv, off + 4, 'moof'); off += 8;
  writeUint32(fv, off, mfhdSize); writeString(fv, off + 4, 'mfhd');
  fv.setUint8(off + 8, 0); writeUint32(fv, off + 12, 1); off += mfhdSize;
  const videoTrafStart = off;
  writeUint32(fv, off, trafSizeV); writeString(fv, off + 4, 'traf'); off += 8;
  writeUint32(fv, off, 16); writeString(fv, off + 4, 'tfhd');
  fv.setUint8(off + 8, 0); fv.setUint8(off + 9, 0x02); fv.setUint8(off + 10, 0); fv.setUint8(off + 11, 0);
  writeUint32(fv, off + 12, videoTrackId); off += 16;
  writeUint32(fv, off, 16); writeString(fv, off + 4, 'tfdt');
  fv.setUint8(off + 8, 0); writeUint32(fv, off + 12, videoBaseDts); off += 16;
  const trunVStart = off;
  writeUint32(fv, off, trunSizeV); writeString(fv, off + 4, 'trun');
  fv.setUint8(off + 8, 1);
  const pFlagsV = 0x000701;
  fv.setUint8(off + 9, (pFlagsV >> 16) & 0xff); fv.setUint8(off + 10, (pFlagsV >> 8) & 0xff); fv.setUint8(off + 11, pFlagsV & 0xff);
  writeUint32(fv, off + 12, videoSamples.length);
  fv.setInt32(off + 16, moofSize + 8); off += 20;
  for (let i = 0; i < videoSamples.length; i++) {
    writeUint32(fv, off, videoDurations[i]); off += 4;
    writeUint32(fv, off, videoSizes[i]); off += 4;
    writeUint32(fv, off, videoFlagsFinal[i]); off += 4;
  }
  off = videoTrafStart + trafSizeV;
  writeUint32(fv, off, trafSizeA); writeString(fv, off + 4, 'traf'); off += 8;
  writeUint32(fv, off, 16); writeString(fv, off + 4, 'tfhd');
  fv.setUint8(off + 8, 0); fv.setUint8(off + 9, 0x02); fv.setUint8(off + 10, 0); fv.setUint8(off + 11, 0);
  writeUint32(fv, off + 12, audioTrackId); off += 16;
  writeUint32(fv, off, 16); writeString(fv, off + 4, 'tfdt');
  fv.setUint8(off + 8, 0); writeUint32(fv, off + 12, audioBaseDts); off += 16;
  writeUint32(fv, off, trunSizeA); writeString(fv, off + 4, 'trun');
  fv.setUint8(off + 8, 1);
  fv.setUint8(off + 9, (pFlagsV >> 16) & 0xff); fv.setUint8(off + 10, (pFlagsV >> 8) & 0xff); fv.setUint8(off + 11, pFlagsV & 0xff);
  writeUint32(fv, off + 12, audioSamples.length);
  const audioDataOffset = moofSize + 8 + videoSizes.reduce((s, v) => s + v, 0);
  fv.setInt32(off + 16, audioDataOffset); off += 20;
  for (let i = 0; i < audioSamples.length; i++) {
    writeUint32(fv, off, audioDurations[i]); off += 4;
    writeUint32(fv, off, audioSizes[i]); off += 4;
    writeUint32(fv, off, audioFlagsFinal[i]); off += 4;
  }
  const mdatStart = moofSize;
  writeUint32(fv, mdatStart, mdatTotal);
  writeString(fv, mdatStart + 4, 'mdat');
  frag.set(mdatData, mdatStart + 8);
  return frag;
}

export interface Mp4RecorderOptions {
  canvas: HTMLCanvasElement;
  audioTrack?: MediaStreamTrack | null;
  fps?: number;
  videoBitrate?: number;
  audioBitrate?: number;
  width?: number;
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
  private avccBox: Uint8Array | null = null;
  private audioAsc: Uint8Array | null = null;
  private startTime = 0;
  private recording = false;
  private audioTrack: MediaStreamTrack | null = null;
  private audioCtx: AudioContext | null = null;
  private audioSourceNode: MediaStreamAudioSourceNode | null = null;
  private stats: Mp4RecorderStats = { videoFrames: 0, audioFrames: 0, duration: 0, totalBytes: 0 };

  constructor(options: Mp4RecorderOptions) {
    this.canvas = options.canvas;
    this.fps = options.fps ?? 30;
    this.videoBitrate = options.videoBitrate ?? 2_500_000;
    this.audioBitrate = options.audioBitrate ?? 128_000;
    this.width = options.width ?? options.canvas.width;
    this.height = options.height ?? options.canvas.height;
    this.audioTrack = (options.audioTrack as any) ?? null;
  }

  async start(): Promise<void> {
    const VideoEncoder = (window as any).VideoEncoder;
    const AudioEncoder = (window as any).AudioEncoder;
    if (!VideoEncoder) throw new Error('VideoEncoder 不可用');
    const videoConfig: VideoEncoderConfig = {
      codec: 'avc1.4D401E', width: this.width, height: this.height,
      bitrate: this.videoBitrate, framerate: this.fps,
      hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' },
    } as any;
    this.videoEncoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk, metadata: any) => {
        this.videoFrames.push(chunk);
        if (metadata?.decoderConfig?.description) this.avccBox = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
      },
      error: (e: Error) => { logger.error('Mp4Recorder video encoder error:', String(e)); },
    });
    const videoSupported = await (window as any).VideoEncoder.isConfigSupported(videoConfig);
    if (!videoSupported?.supported) throw new Error('视频编码器配置不支持');
    this.videoEncoder.configure(videoConfig);
    if (this.audioTrack && AudioEncoder) {
      try {
        const audioConfig: AudioEncoderConfig = {
          codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: this.audioBitrate,
        } as any;
        const audioSupported = await AudioEncoder.isConfigSupported(audioConfig);
        if (audioSupported?.supported) {
          this.audioEncoder = new AudioEncoder({
            output: (chunk: EncodedAudioChunk, metadata: any) => {
              this.audioFrames.push(chunk);
              if (metadata?.decoderConfig?.description) this.audioAsc = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
            },
            error: (e: Error) => { logger.error('Mp4Recorder audio encoder error:', String(e)); },
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
    this.startTime = performance.now();
    this.recording = true;
  }

  private async setupAudioCapture(): Promise<void> {
    if (!this.audioTrack) return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new Ctx({ sampleRate: 44100 });
      const stream = new MediaStream([this.audioTrack as any]);
      this.audioSourceNode = this.audioCtx.createMediaStreamSource(stream);
      const bufferSize = 4096;
      const scriptNode = this.audioCtx.createScriptProcessor(bufferSize, 2, 2);
      let sampleCount = 0;
      let pcmBuffer: Float32Array | null = null;
      const samplesPerFrame = 1024;
      scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!this.recording || !this.audioEncoder) return;
        const inputL = e.inputBuffer.getChannelData(0);
        const inputR = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : inputL;
        for (let i = 0; i < inputL.length; i++) {
          if (!pcmBuffer) pcmBuffer = new Float32Array(samplesPerFrame * 2);
          pcmBuffer[sampleCount * 2] = inputL[i];
          pcmBuffer[sampleCount * 2 + 1] = inputR[i];
          sampleCount++;
          if (sampleCount >= samplesPerFrame) {
            const data = new Float32Array(pcmBuffer);
            const frame = new (window as any).AudioData({
              format: 'f32-planar', sampleRate: 44100, numberOfFrames: samplesPerFrame,
              numberOfChannels: 2, timestamp: (this.startTime + (this.audioFrames.length * samplesPerFrame / 44100) * 1_000_000), data,
            });
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

  recordFrame(timestampUs?: number): void {
    if (!this.recording || !this.videoEncoder) return;
    const now = timestampUs ?? (performance.now() - this.startTime) * 1000;
    try {
      const VideoFrame = (window as any).VideoFrame;
      const frame = new VideoFrame(this.canvas, { timestamp: Math.floor(now) });
      const keyFrame = this.stats.videoFrames % (this.fps * 2) === 0;
      this.videoEncoder.encode(frame, { keyFrame });
      frame.close?.();
      this.stats.videoFrames++;
    } catch (e) {
      logger.error('Mp4Recorder recordFrame failed:', String(e));
    }
  }

  async stop(): Promise<{ blob: Blob; stats: Mp4RecorderStats }> {
    this.recording = false;
    if (this.videoEncoder) { await this.videoEncoder.flush(); this.videoEncoder.close?.(); this.videoEncoder = null; }
    if (this.audioEncoder) { await this.audioEncoder.flush(); this.audioEncoder.close?.(); this.audioEncoder = null; }
    if (this.audioCtx) { try { this.audioCtx.close(); } catch {} this.audioCtx = null; this.audioSourceNode = null; }
    const duration = this.videoFrames.length / this.fps;
    const vDur = Math.floor(90_000 / this.fps);
    const videoDurations = this.videoFrames.map(() => vDur);
    const videoTimescale = 90_000;
    const audioTimescale = 44100;
    const audioDurations = this.audioFrames.map(() => 1024);
    const ftyp = makeFtyp();
    const avccBox = this.avccBox ?? makeDummyAvcc();
    const esdsBox = makeEsds(this.audioAsc ?? new Uint8Array(), 44100, 2, this.audioBitrate);
    const moov = makeMoov(this.width, this.height, avccBox, 44100, 2, esdsBox, videoTimescale, audioTimescale, duration);
    let totalVideoBytes = 0, totalAudioBytes = 0;
    const videoSampleSizes: number[] = [];
    const audioSampleSizes: number[] = [];
    const videoIsKey: boolean[] = [];
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
    const frag = buildFragment(1, 2,
      this.videoFrames.map((_, i) => ({ size: videoSampleSizes[i], duration: videoDurations[i], isKey: videoIsKey[i] })),
      this.audioFrames.map((_, i) => ({ size: audioSampleSizes[i], duration: audioDurations[i] })),
      0, 0, mdatData);
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

function makeDummyAvcc(): Uint8Array {
  const dummySpS = new Uint8Array([0x67, 0x42, 0x00, 0x0c, 0xe4, 0x40, 0xa0, 0xfd, 0x00, 0xf0, 0x88, 0x45, 0x38]);
  const dummyPps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
  return makeAvcc(dummySpS, dummyPps);
}

export async function startMp4Recording(opts: Mp4RecorderOptions): Promise<{ stop: () => Promise<{ blob: Blob; stats: Mp4RecorderStats }> }> {
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
