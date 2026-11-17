# Meeting Assistant

브라우저에서 동작하는 로컬 우선(local-first) 실시간 회의 전사 · 번역 · AI 회의록 도구.

- 회의가 열려 있는 **브라우저 탭(또는 창/화면)** 의 오디오를 선택해 캡처
- **기기 내(CPU/WebGPU) Whisper** 로 실시간 전사 (영어·한국어, 발화 단위 자동 언어 감지, 임시/확정 자막 구분)
- **기기 내 번역** (Chrome/Edge 내장 Translator API) — 확정 자막과 임시 자막 모두 번역
- 사용자의 **Gemini API 키**로 근거 발화 번호가 달린 구조화 회의록 생성
- 회의별 저장(IndexedDB), 검색·수정·삭제, TXT / Markdown / SRT / JSON / PDF(인쇄) 내보내기
- 설치·서버 없음. 정적 사이트로 배포 (GitHub Pages)

## 빠른 시작

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 단위 테스트 (세그먼터, 내보내기, 청크 분할 등)
npm run build      # dist/ 정적 산출물
```

요구 사항: Node 22+, 데스크톱 Chrome 또는 Edge(권장 138+).

### 사용 흐름

1. 음성 언어 / 번역 언어 / 모델을 고른다 (최초 1회 모델 다운로드: tiny ≈ 60MB, base ≈ 110MB, small ≈ 350MB, 이후 브라우저 캐시).
2. **회의 탭/창 선택 후 시작** → 브라우저 선택 창에서 회의 탭을 고르고 **"탭 오디오도 공유"** 를 켠다.
3. 실시간 자막(원문 | 번역)을 확인한다. 일시정지 / 소스 변경 / 종료 가능.
4. 종료 후 **회의록** 탭에서 AI 회의록 생성 (설정에서 Gemini API 키 입력).
5. 내보내기 또는 삭제.

캡처가 불가능한 환경에서는 **마이크만으로 시작** 또는 **녹음 파일 전사** 를 쓸 수 있다.

### 실제 Chrome E2E 테스트

```bash
# 샘플 음성 생성 (macOS 예시; 16kHz mono wav 아무 파일이나 tests/samples/mixed.wav 로 두면 됨)
mkdir -p tests/samples && say -o /tmp/s.aiff "Good morning everyone. We decided to ship next Friday." \
  && ffmpeg -y -i /tmp/s.aiff -ar 16000 -ac 1 tests/samples/mixed.wav
npm run dev &
npm run e2e -- wasm onnx-community/whisper-base ko   # [wasm|webgpu] [model] [번역 대상]
```

Chrome을 띄워 다른 탭(`tests/sim.html`)의 오디오를 `getDisplayMedia`로 공유받아 전사·번역 결과와 성능 수치를 출력하고, 캡처 대상 탭을 닫았을 때의 처리까지 확인한다. (`APP_URL=`로 배포본 대상 실행 가능)

## 배포 (GitHub Pages)

`main` 브랜치에 push 하면 `.github/workflows/deploy.yml` 이 테스트 → 빌드 → Pages 배포를 수행한다.
최초 1회 저장소 **Settings → Pages → Source: GitHub Actions** 로 설정해야 한다.

GitHub Pages는 응답 헤더를 설정할 수 없어 `public/coi-sw.js` 서비스 워커가 COOP/COEP 헤더를 붙인다(첫 방문 시 1회 자동 새로고침). 이 헤더가 있어야 `SharedArrayBuffer` → 멀티스레드 WASM 추론이 가능하다. 헤더를 직접 설정할 수 있는 호스트(Cloudflare Pages, Netlify 등)에서는 `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless` 를 설정하면 된다.

## 구조

| 경계 | 파일 | 역할 |
|---|---|---|
| Audio Capture | `src/audio/capture.ts` | `getDisplayMedia` / `getUserMedia`, 오디오 트랙 유무 검증, 사용자용 오류 메시지 |
| Audio Preprocessing | `src/audio/pipeline.ts`, `public/pcm-worklet.js`, `src/audio/segmenter.ts` | 16kHz mono 변환(AudioWorklet), 무음 기준 발화 분할 |
| Speech Recognition | `src/asr/worker.ts`, `src/asr/client.ts` | Web Worker 안의 Whisper, 작업 큐/임시 자막 정책 |
| Translation | `src/translate/index.ts` | `Translator` 인터페이스 + 내장 Translator API 구현 |
| Summarization | `src/minutes/gemini.ts` | Gemini REST 호출, JSON 스키마, 긴 회의 분할-병합 |
| Storage | `src/storage/db.ts` | IndexedDB (meetings, segments) |
| UI | `index.html`, `src/main.ts`, `src/ui.css` | 화면, 상태, 성능 측정 패널 |

실시간 경로: 오디오 스레드(AudioWorklet) → 메인 스레드는 프레임 전달·분할만 → 추론은 Worker. 번역과 회의록은 전사와 독립적으로 비동기 실행된다. 확정 발화는 버리지 않고 FIFO로 처리하며, 인식기가 바쁠 때는 **임시 자막을 먼저 포기**해 지연이 누적되지 않게 한다. 발화는 최대 15초에서 강제 분할되어 작업 크기가 유한하다. 앱 탭이 백그라운드여도 핵심 경로는 타이머가 아닌 메시지 이벤트 기반이라 스로틀링 영향을 받지 않는다(임시 자막·지표 갱신만 느려짐).

## 기술 선택 근거

**오디오 캡처 — `getDisplayMedia`.** 웹 페이지가 다른 탭/앱의 소리를 얻는 유일한 표준 경로다. *선택할 수 있는 것*과 *소리를 얻을 수 있는 것*은 다르다:

| 선택 대상 | Chrome/Edge Windows | Chrome/Edge macOS | Chrome Linux | Firefox | Safari |
|---|---|---|---|---|---|
| 브라우저 탭 오디오 | 가능 | **가능 (실측)** | 가능(문서 기준) | 불가 | 불가 |
| 화면 전체 + 시스템 오디오 | 가능(문서 기준) | Chrome 141+ / macOS 14.2+ 에서 가능하다는 보고, 미검증 | 불가 | 불가 | 불가 |
| 개별 앱 창의 오디오만 | 불가 (창 선택 시 오디오 없음 또는 시스템 전체) | Chrome 141+ `windowAudio` 힌트 존재, 미검증 | 불가 | 불가 | 불가 |

- Firefox/Safari는 `getDisplayMedia`에서 오디오 트랙을 주지 않는다 ([Mozilla bug 1541425](https://bugzilla.mozilla.org/show_bug.cgi?id=1541425), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)).
- 따라서 **Discord/Zoom 데스크톱 앱 창의 소리만 골라서** 캡처하는 것은 브라우저 보안 모델상 일반적으로 불가능하다. 대안(사용성 순): ① 회의를 **웹 버전**(Zoom/Meet/Teams/Discord 웹)으로 열고 그 탭을 공유 — 다른 프로그램 소리가 섞이지 않는 유일한 방법 ② 화면 전체 + 시스템 오디오(지원 OS) — 다른 앱 소리도 섞임 ③ 마이크로 스피커 소리 수음 ④ 녹음 파일 전사.
- 앱은 캡처 후 실제 오디오 트랙 유무를 검사하고, 15초간 소리가 없으면 경고한다.

**ASR — Whisper (ONNX) + transformers.js 4.x.** 브라우저에서 한국어·영어를 모두 지원하고 WASM(CPU)·WebGPU 양쪽에서 돌며 모델 크기 선택지가 있는 사실상 유일한 조합이다. 검토한 대안: whisper.cpp WASM(유사 성능, 생태계·WebGPU 부재), Moonshine(영어 중심, 언어별 모델 분리), Web Speech API(마이크 전용·서버 전송). transformers.js에는 Whisper 언어 감지가 없어(영어로 기본 설정됨) 디코더 첫 토큰을 후보 언어로 제한하는 방식으로 **단일 패스 언어 감지**를 구현했다(`src/asr/worker.ts`).

**번역 — Chrome 내장 [Translator API](https://developer.chrome.com/docs/ai/translator-api).** 기기 내 처리, 추가 다운로드는 언어팩뿐, 문장당 수십 ms. 브라우저 내 범용 번역 모델(NLLB-200 600M 등)은 수백 MB 다운로드가 필요하고 en→ko 경량 ONNX 모델이 없어 채택하지 않았다. 탭 오디오 캡처가 되는 브라우저(Chromium)와 지원 범위가 거의 겹친다. `Translator` 인터페이스로 엔진을 교체할 수 있다.

**회의록 — Gemini REST 직접 호출.** 종료 후 일괄 요약을 기본으로 했다: 전체 맥락을 한 번에 보므로 결정/액션 누락과 중복이 적고 호출 수가 1회다. 전사가 요청당 12만 자를 넘으면 구간별 요약 후 병합(map-reduce)하여 컨텍스트와 비용을 제한한다. 회의 중 누적 요약은 호출 수(무료 등급 분당 한도)와 초반 오인식 고착 위험 때문에 채택하지 않았다. 프롬프트와 JSON 스키마로 "언급되지 않은 결정/담당자 금지, 불확실 표기, 근거 발화 번호 필수"를 강제하고, 존재하지 않는 발화 번호 인용은 제거한다. 모델 이름은 하드코딩 대신 기본값 `gemini-flash-latest` + 키로 조회한 목록에서 선택한다.

**API 키.** 코드에 없고, 기본은 `sessionStorage`(탭 종료 시 삭제), 선택 시 `localStorage`. 키는 URL이 아닌 `x-goog-api-key` 헤더로 Google에만 전송된다. 브라우저 저장 키는 같은 출처의 스크립트(XSS)·확장 프로그램·기기 사용자에게 노출될 수 있으므로 이 방식은 **개인/연구용**에 적합하다. 공개 서비스라면 서버 프록시(사용자 인증, 서버 보관 키, 쿼터)로 바꿔야 한다. 이 앱은 서드파티 스크립트를 로드하지 않는다(ONNX 런타임 WASM도 자체 호스팅).

## 데이터 흐름과 개인정보

| 데이터 | 처리 위치 |
|---|---|
| 오디오 | 기기 내에서만 처리. 저장·전송하지 않음 |
| 전사·번역·회의록 | 이 브라우저의 IndexedDB |
| 모델 파일 | 최초 1회 huggingface.co 에서 다운로드(회의 데이터 전송 없음) |
| 회의록 생성 | **전사 텍스트**가 사용자 키로 Google Gemini API에 전송됨 (사용자가 버튼을 눌렀을 때만) |

캡처는 항상 브라우저 권한 창을 거치며, 캡처 중에는 상단 표시등·미리보기와 브라우저 자체 공유 표시가 보인다. 종료 시 모든 트랙을 해제한다. 참가자에게 전사 사실을 알리고 동의를 받는 것은 사용자 책임이며 앱이 시작 화면에서 안내한다.

## 검증 결과

환경: Apple M1 Max (10코어, 32GB), macOS, Chrome 157. 음성은 macOS TTS로 만든 영어+한국어 45초 샘플(실제 회의 음성 아님).

| 항목 | 방법 | 결과 |
|---|---|---|
| 탭 오디오 캡처 → 전사 | `npm run e2e` (실제 Chrome, 다른 탭 공유) | 통과 |
| 영어/한국어 자동 감지 | 혼합 샘플 | 통과 (발화 단위) |
| 기기 내 번역 en→ko | e2e | 통과, 문장당 평균 29ms (언어팩 최초 로드 시 ~0.9s) |
| 캡처 대상 탭 종료 | e2e에서 탭 닫기 | 오류 안내 + "소스 없음" 상태, 이후 정상 종료·저장 |
| 무음 구간 | 단위 테스트 + 샘플의 무음 | 인식기 호출 없음, 15초 무음 경고 표시 |
| 프로덕션 빌드 + 서비스 워커 | 헤더 없는 정적 서버에 `dist/` | 통과 |
| 저장/재열람, 검색·수정 UI | 수동(내장 브라우저) | 저장된 회의 재열람 확인 |
| Gemini 키 오류 | 잘못된 키로 실제 API 호출 | CORS 정상, 오류 메시지 표시 |
| 단위 테스트 | `npm test` | 10개 통과 |

성능 (같은 환경, 값이 낮을수록 빠름. RTF = 처리시간/오디오길이):

| 모델 | 장치 | RTF | 비고 |
|---|---|---|---|
| whisper-tiny | CPU (WASM, 멀티스레드) | 0.12 | 한국어 오류 많음 |
| whisper-base | CPU | 0.17–0.21 | 기본값. 영어 양호, 한국어 간혹 오류 |
| whisper-base | WebGPU | 0.10 | |
| whisper-small | CPU | 0.67 | 한국어 정확도 가장 좋음. 느린 CPU에서는 실시간 불가 가능 |
| whisper-small | WebGPU | 0.15 | |

발화 종료 → 확정 자막 지연은 base/CPU 기준 약 1–1.8초(무음 판정 0.6초 포함).

**검증하지 못한 것**: Windows·Linux 전체, Edge, 저사양 CPU, 화면 전체/창 선택 시 시스템 오디오, 마이크 혼합, 1시간 이상 장시간 회의, 실제 사람 음성·다화자·잡음 환경, 유효한 키로의 Gemini 회의록 생성 품질과 사용량 한도(429) 응답, 모델 다운로드 중 네트워크 단절.

## 지원 환경

- **지원(검증됨)**: macOS + Chrome 157 — 탭 오디오 캡처, CPU/WebGPU 전사, 번역.
- **지원 예상(미검증)**: Windows/Linux/ChromeOS의 데스크톱 Chrome·Edge 138+.
- **부분 지원**: Firefox, Safari — 탭/창 오디오 캡처 불가. 마이크·파일 전사만 가능할 수 있으며 번역 불가(미검증).
- **미지원**: 모바일 브라우저.

## 알려진 제약

- 데스크톱 앱(Discord/Zoom 앱) 창의 오디오만 분리 캡처할 수 없다 → 웹 버전 탭 사용 권장.
- 한 발화는 하나의 언어로만 인식된다. 한 발화 안에서 언어가 바뀌면 한쪽이 누락·오인식될 수 있다.
- 화자 분리(누가 말했는지) 없음. 회의록의 담당자는 발화에 이름이 언급된 경우에만 채워진다.
- 음성 구간 검출은 에너지 기반이라 잡음이 큰 마이크 입력에서는 민감도 조정(설정)이 필요하다.
- 고유명사 오인식은 용어집의 `오인식 => 교정` 치환과 회의록 프롬프트 용어 목록으로만 보정한다(인식기 자체 바이어싱 없음).
- 캡처를 일시정지해도 브라우저의 공유 표시는 유지된다(종료 시 해제).
- 번역은 Chrome/Edge 내장 API에 의존한다.

## 향후 개선

1. Silero VAD로 음성 구간 검출 교체, 언어 전환 지점 분할
2. 화자 분리
3. Translator API가 없는 브라우저용 대체 번역 엔진
4. Whisper 프롬프트 기반 용어 바이어싱
5. Windows/Linux/저사양 기기 벤치마크와 장시간 회의 소크 테스트
6. 회의 중 주기적 요약(선택 기능), 회의록 수정 UI
7. 공개 서비스용 서버 프록시 옵션
