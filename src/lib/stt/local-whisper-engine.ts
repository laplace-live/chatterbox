import { startPcmCapture, PCM_SAMPLE_RATE } from './pcm-capture'
import type { SttEngine, SttEngineEvent, SttSessionParams } from './types'

function encodeWAV(samples: Int16Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, samples[i], true);
    offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

export function createLocalWhisperEngine(params: SttSessionParams, onEvent: (event: SttEngineEvent) => void): SttEngine {
  let capture: { stop: () => void } | null = null;
  let pcmData: Int16Array[] = [];
  let isProcessing = false;
  let frameCount = 0;
  let stopRequested = false;

  const sendToLocalWhisper = async (blob: Blob) => {
    return new Promise<string>((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", blob, "audio.wav");
      formData.append("response_format", "json");
      formData.append("temperature", "0.0");
      formData.append("language", "zh");
      formData.append("suppress_nst", "true");

      // @ts-ignore
      GM_xmlhttpRequest({
        method: "POST",
        url: "http://127.0.0.1:8080/inference",
        data: formData,
        responseType: "json",
        onload: (res: any) => {
          if (res.status === 200 && res.response) {
            resolve(res.response.text);
          } else {
            reject(new Error("Local Whisper Error: " + res.status));
          }
        },
        onerror: (err: any) => reject(err)
      });
    });
  };

  const processAudio = async () => {
    if (pcmData.length === 0 || isProcessing) return;
    isProcessing = true;
    
    // Merge buffers
    const totalLength = pcmData.reduce((acc, val) => acc + val.length, 0);
    const merged = new Int16Array(totalLength);
    let offset = 0;
    for (const arr of pcmData) {
      merged.set(arr, offset);
      offset += arr.length;
    }
    pcmData = [];
    
    const wavBlob = encodeWAV(merged, PCM_SAMPLE_RATE);
    
    try {
      const text = await sendToLocalWhisper(wavBlob);
      if (text && text.trim().length > 0 && !stopRequested) {
        const noise = ["字幕", "翻译", "观看", "请不吝赐教", "未经许可", "版权所有", "Amara"];
        if (!noise.some(n => text.includes(n))) {
          onEvent({
            type: 'transcript',
            chunks: [{ text, isFinal: true, kind: 'original' }]
          });
          onEvent({ type: 'endpoint' });
        }
      }
    } catch (err) {
      console.error("Local Whisper API Error:", err);
    } finally {
      isProcessing = false;
    }
  };

  return {
    start: () => {
      onEvent({ type: 'state', state: 'connecting' });
      startPcmCapture({
        deviceId: params.audioDeviceId,
        onFrame: (frame) => {
          if (stopRequested) return;
          // clone the frame since it might be overwritten by worklet
          pcmData.push(new Int16Array(frame));
          frameCount++;
          // approx 4.5 seconds (18 * 4096 / 16000 = 4.608s)
          if (frameCount >= 18 && !isProcessing) {
            frameCount = 0;
            processAudio();
          }
        }
      }).then(c => {
        capture = c;
        onEvent({ type: 'connected' });
        onEvent({ type: 'state', state: 'recording' });
      }).catch(err => {
        onEvent({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      });
    },
    stop: async () => {
      stopRequested = true;
      if (capture) capture.stop();
      onEvent({ type: 'state', state: 'stopped' });
      onEvent({ type: 'finished' });
    },
    cancel: () => {
      stopRequested = true;
      if (capture) capture.stop();
      onEvent({ type: 'state', state: 'canceled' });
      onEvent({ type: 'finished' });
    },
    pause: () => {},
    resume: () => {},
    finalize: () => {
      if (!isProcessing) processAudio();
    }
  };
}
