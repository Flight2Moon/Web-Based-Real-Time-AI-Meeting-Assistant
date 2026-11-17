// Audio sources. Each returns a MediaStream; nothing is captured without a browser permission prompt.
export class CaptureError extends Error {}

export const canCaptureDisplayAudio = () =>
  !!navigator.mediaDevices?.getDisplayMedia && !/Firefox|Mobile|Android/.test(navigator.userAgent) &&
  /Chrome|Chromium|Edg\//.test(navigator.userAgent); // Firefox/Safari return no audio track from getDisplayMedia

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/** Opens the browser's tab/window/screen picker. Throws CaptureError with a user-facing (Korean) message. */
export async function captureDisplay(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia)
    throw new CaptureError('이 브라우저는 화면/탭 캡처를 지원하지 않습니다. 데스크톱 Chrome 또는 Edge를 사용하세요.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // required by the API; only shown as a preview, never recorded
      audio: { ...RAW, suppressLocalAudioPlayback: false },
      systemAudio: 'include', // hint: offer system audio when a screen is picked (Windows/ChromeOS, macOS 14.2+ w/ Chrome 141+)
      windowAudio: 'window', // hint (Chrome 141+): offer per-window audio where the OS supports it
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    } as DisplayMediaStreamOptions);
  } catch (e) {
    const name = (e as DOMException).name;
    throw new CaptureError(name === 'NotAllowedError'
      ? '캡처가 취소되었거나 권한이 거부되었습니다. (macOS: 시스템 설정 → 개인정보 보호 → 화면 및 시스템 오디오 녹음에서 브라우저를 허용해야 할 수 있습니다)'
      : `캡처를 시작할 수 없습니다: ${(e as Error).message}`);
  }
  if (!stream.getAudioTracks().length) {
    const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
    stream.getTracks().forEach((t) => t.stop());
    throw new CaptureError(
      (surface === 'browser'
        ? '선택한 탭의 오디오가 공유되지 않았습니다. 선택 창에서 "탭 오디오도 공유"를 켜고 다시 시도하세요.'
        : surface === 'window'
          ? '이 환경에서는 선택한 창의 오디오를 캡처할 수 없습니다. 브라우저는 대부분의 OS에서 개별 앱 창의 소리를 제공하지 않습니다.'
          : '화면 공유에 시스템 오디오가 포함되지 않았습니다. 선택 창에서 "시스템 오디오도 공유"를 켜야 하며, 일부 OS(Linux, 구형 macOS)에서는 지원되지 않습니다.') +
      '\n대안: ① 회의를 브라우저 탭(Zoom/Meet/Teams/Discord 웹)에서 열고 그 탭을 선택 ② "마이크"로 스피커 소리를 수음 ③ 녹음 파일 전사.');
  }
  return stream;
}

export async function captureMic(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw new CaptureError(`마이크를 사용할 수 없습니다: ${(e as Error).message}`);
  }
}
