# mtbench — 순수 MT 모델 자체 서빙 실험 (핸드오프)

**작성**: 2026-08-14 · **대상 장비**: 로컬 서버 RTX 3060 Ti 8GB
**레포**: https://github.com/parkbrother86/hamoni (이 폴더는 bench/ 와 달리 **git 추적됨** — 서버에서 clone 하면 그대로 있음)
**배경/의사결정 맥락**: 개발기의 `bench/PRICING.md` §9 (DeepSeek 8/16 요금 개편 대응 기록 — 로컬 전용 문서)

## 왜 하나

DeepSeek 요금 개편 후에도 API 가 현 트래픽에선 압도적으로 싸지만, ①대화형(캐시
히트 낮음) 트래픽이 커질 경우 ②인게임 전환 시의 latency/거버넌스 축에서
**자체 서빙(GPU) 옵션의 실현 가능성**을 미리 검증해 둔다. LLM(vLLM) 경로보다
**순수 MT 모델을 우선** 실험한다 (사용자 결정 2026-08-14).

## 실험 목표 (게이트)

| # | 질문 | 판정 기준 |
|---|---|---|
| G1 | **품질** — 게임/디스코드 채팅을 쓸 만하게 번역하나 | 대표 케이스에서 치명 오역(슬랭 드랍, 의미 반전) 빈도. DeepSeek 참조와 나란히 육안 판정 |
| G2 | **placeholder** — 마스크가 지시 없이 살아남나 | 마스크 형태별 생존율. **≥ 문장 6/6 형태가 존재해야** 멘션/이모지 왕복 가능 |
| G3 | **처리량** — "초당 몇백 건" 이 되나 | 배치 스윕 msg/s. 목표 수백/s |
| G4 | **latency** — 단일 호출이 SLA(p95<1.5s) 안이냐 | p50/p95. DeepSeek 실측 637/950ms 대비 |

종합 판정: G2~G4 통과 + G1 실패 시 → **파인튜닝 트랙**(봇 corpus log 의
원문→DeepSeek 번역쌍으로 증류) 타당성 검토. G1 이 raw 로도 근접하면 즉시 활용 검토.

## 모델 후보 — 라이선스가 1차 필터

단일 모델 다국어(ko/en/ja/zh 동시) + 8GB VRAM 적합 + 상용 가능 라이선스 순.

### 트랙 A — seq2seq MT (CTranslate2, `bench_mt.py`)

| 우선 | `--model` | 라이선스 | 크기(양자화) | 비고 |
|---|---|---|---|---|
| **1** | `madlad3b` (MADLAD-400-3B-MT, Google) | **Apache 2.0** ✓ | int8 ~3GB | 400+언어 단일 모델 |
| **2** | `m2m100-1.2b` (Meta) | **MIT** ✓ | int8 ~1.3GB | 100언어. 구세대라 품질 낮을 수 있음 — 라이선스 안전 베이스라인 |
| 참고 | `nllb600m` / `nllb1.3b` (Meta) | **CC-BY-NC 4.0 — 상용 불가** | ~0.7/1.4GB | **실험 전용** (품질/속도 상한 참고). 프로덕션 배제 |
| 제외 | SeamlessM4T, Tower | CC-BY-NC | — | 라이선스 |

### 트랙 B — 번역 특화 decoder LLM (OpenAI 호환 서버 + 기존 bench 하네스) ★신규

decoder-only 라 CTranslate2 하네스로는 못 돌린다. **vLLM(Linux) 또는
llama.cpp server(GGUF, 크로스플랫폼)** 로 OpenAI 호환 엔드포인트를 띄우고,
`bench/` 의 기존 하네스(`ramp.js`/`burst.js`/`quality.js`)를 `BENCH_BASE_URL`
로 붙인다. **단건 동시요청 처리량(§단건 동시성) 측정은 이 트랙에서 한다.**

| 우선 | 모델 | 라이선스 | 크기 | 비고 |
|---|---|---|---|---|
| **1** | `trillionlabs/Tri-1.8B-Translation` | **Apache 2.0** ✓ | 1.8B (GGUF Q4 ~1.1GB) | **EN↔KO↔JA↔ZH 전방향 — 우리 4개 언어와 정확히 일치.** 21B 에서 증류. 8GB 에 여유. GGUF: `mradermacher/Tri-1.8B-Translation-GGUF` |
| 2 | `google/translategemma-4b-it` | **Gemma Terms** (상용 가능하나 Prohibited Use Policy + 재배포 조건 — 법무 확인 필요) | ~5B (GGUF Q4 ~3GB) | 55언어, 멀티모달(이미지 내 텍스트 번역). 8GB 에 Q4 로 들어감. GGUF: `mradermacher/translategemma-4b-it-GGUF` |

프롬프트 형식(모델 카드 기준):
- Tri-1.8B: `Translate the following Korean text into English:\n{text} <en>`
- TranslateGemma: `source_lang_code`/`target_lang_code` 지정 형식 (카드 참조)

> 트랙 B 는 **V10 시스템 프롬프트를 쓰지 않는다** — 번역 전용 모델이라 지시
> 채널이 제한적이다. 따라서 `quality.js` 는 그대로 못 쓰고 모델별 프롬프트
> 어댑터가 필요하다 (client.js 에 분기 추가). 반면 `ramp.js`/`burst.js` 는
> 프롬프트 내용과 무관하게 부하만 걸면 되므로 그대로 재사용 가능.

| 2안 | Qwen2.5-7B 등 범용 instruct LLM | Apache 2.0 | AWQ ~4.4GB | 트랙 A·B 모두 품질 실패 시 — 개발기 `bench/GPU_TEST.md` 러너북 |

## 서버 설치 (Linux / WSL2 권장, Windows 네이티브도 동작 확인됨)

```bash
git clone https://github.com/parkbrother86/hamoni.git && cd hamoni/mtbench
python -m venv venv
./venv/bin/pip install -r requirements.txt        # Windows: .\venv\Scripts\pip
```

- GPU: CUDA 12 계열 드라이버면 됨. 런타임 라이브러리(cuBLAS/cuDNN)는
  requirements 의 `nvidia-*-cu12` pip 휠로 들어가고, 스크립트가 경로를 자동
  등록한다 (Windows 에서 이 방식으로 검증 완료).
- CUDA 실패 시 자동 CPU 폴백 — **quality/mask 는 CPU 로도 유효**(품질은 장치
  무관), speed 만 GPU 필요.
- 모델은 첫 실행 때 HF 에서 자동 다운로드 (nllb600m ≈ 0.6GB).
  `madlad3b`/`m2m100` 사전 변환본이 404 면 스크립트가 변환 명령을 안내한다.

## 실행

```bash
python bench_mt.py --model nllb600m                 # 전체 (quality→mask→speed)
python bench_mt.py --model madlad3b                 # 1순위 후보
python bench_mt.py --model m2m100-1.2b --stage mask # 스테이지 지정
```

## 초기 실측 — 2026-08-14, 개발기 4080 Laptop 12GB

> 4080 Laptop 메모리 대역폭(432GB/s) ≈ 3060 Ti(448GB/s) — **처리량은 3060 Ti
> 로 거의 1:1 이전**된다. 모델: nllb600m (int8_float16).

**G3/G4 — 속도는 걱정거리가 아님이 증명됨:**

| 배치 | msg/s |
|---:|---:|
| 1 | 10.6 |
| 8 | 58.9 |
| 32 | 228.5 |
| **128** | **798.8** |

단일 스트림 latency p50 **107ms** / p95 140ms (DeepSeek 637/950ms 의 1/6).
CPU(참고): 배치 128 에서 26.5 msg/s — CPU 로도 현 디스코드 트래픽은 감당됨.

**G2 — 마스크 생존율 (kr→en, 6문장, 지시 없음):**

| 마스크 | beam1 | beam4 | 판정 |
|---|---:|---:|---|
| `101` (숫자) | **6/6** | **6/6** | ✅ 유일한 신뢰 형태 |
| `T0` | 5/6 | 6/6 | △ 문장에 따라 드랍 |
| `[1]` | 3/6 | 4/6 | ✗ |
| `{a}` | 0/6 | 0/6 | ✗ **전멸** — 브레이스는 복사 안 됨 |
| `⟪T0⟫` (현 봇 형식) | 0/6 | 0/6 | ✗ 전멸 (LLM 전용 형식임이 실증) |
| `<x>` | 0/6 | 0/6 | ✗ |

→ MT 경로 채택 시 text.js 마스크를 **숫자형으로 교체**하면 왕복 가능.

**G2 심화 — 난수 마스크 실전 조건 (nllb600m, beam4, 18케이스 16/18):**

| 조건 | 결과 |
|---|---|
| 자릿수 1~2 (`9`, `42`) | ❌ **단어로 spell-out** ("nine", "forty-two") — 사용 금지 |
| 자릿수 4~7 (`1047`~`9204817`) | ✅ 전부 생존 |
| 6자리 난수 `472938` 전 조건 | ✅ **12/12** — 문두/문중/문미, 조사 직결합(`472938님`), 실숫자 혼재(`5분`, `레벨 80`), 다중 2~3개 나열, jp→en/cn→en/en→kr/kr→jp |
| 천단위 콤마 변형 (`472,938`) | 미발생 ✅ |

→ **확정 권고: 4자리 이상 난수 마스크** (예: 6자리, 메시지 내 실숫자와 충돌 시
재생성 + 복원 단계에서 미발견 시 폴백). 단 마스크가 살아도 주변 번역 품질은
별개 문제다 — `472938 5분 뒤에 리젠이야` → "472938 **Reginald** is in five
minutes" (마스크 ✅, 리젠→인명 오역 ❌). G1 게이트가 여전히 관문.

**G1 — 품질 (nllb600m raw): 게임 채팅 불가 판정.**
슬랭 전멸: `막공 몇 시 출발?`→"What time is it?"(드랍), `낚여버렸네요 ㅋㅋ`→"I'm
out of fish", `ㄱㄱ`→"A.", `리젠`→"Regen", `먹었어요(획득)`→"ate", `탱`→"タン"/"长者".
존댓말/fragment 규칙도 예상대로 미이행(주어 발명). 일반 문장은 통과권
(`탱커 한 명 더 구해요`→"I need another tank.").
→ **속도·마스크·latency 는 전부 통과, 관문은 품질 하나.** raw 소형 MT 로는
불가하고, ①MADLAD/M2M 의 raw 품질 확인(아래 TODO) ②안 되면 파인튜닝 트랙.

## 설계 원칙 — 500ms 마이크로배칭 (2026-08-14 확정, 구현은 나중)

자체 서빙으로 갈 경우 **요청을 500ms 창으로 모아 한 번에 보낸다.** 원칙만
먼저 박아두고, 실제 구현/튜닝은 모델 선정 후에 한다.

- **왜 되나**: 배치 처리량은 이미 넉넉하다(seq2seq 실측 798 msg/s @batch128).
  병목은 처리량이 아니라 요청당 오버헤드이므로, 모아 보내면 같은 GPU 로 훨씬
  많이 처리한다.
- **왜 500ms 가 공짜인가 (인게임)**: 인게임은 **progressive rendering**
  (원문 즉시 표시 → 번역 도착 시 교체/병기)이라 번역 지연이 이미 숨겨져 있다.
  500ms 축적은 체감 비용이 없다. 디스코드는 릴레이 특성상 체감되므로 창을
  더 짧게(100~200ms) 잡거나 미적용.
- **부수 효과**: fan-out 3(같은 원문 → 3개 타겟)이 자연히 한 배치에 묶인다.
  프리픽스 캐시/KV 재사용에도 유리.
- **주의**: 창 크기는 latency 예산에서 역산할 것 (SLA 1.5s 중 500ms 를 큐에
  쓰면 서빙에 1s 남는다). 창이 비면 즉시 발사(타이머 idle 시 대기 금지).

> 이 원칙이 있어도 **테스트는 단건 flood 로 한다** — 마이크로배칭은 앱 계층
> 최적화이고, 우리가 모르는 건 그 아래 서버가 단건들을 얼마나 소화하느냐다.
> 배치로 재면 앱 계층 이득까지 섞여 서버 실력이 가려진다.

## ★ 단건 동시성 — 실제로 알고 싶은 지표 (2026-08-14 사용자 우선순위)

**클라이언트 배치가 아니라, 짧은 번역 요청을 개별로 동시에 쏟아부었을 때
서버가 얼마나 안정적으로 처리하나.** 실 운영 형태가 이것이다 — 디스코드
메시지는 제각기 도착하고, fan-out 3 은 동시 3발이지 배치 1개가 아니다.

> ⚠️ 위 §초기 실측의 `798 msg/s @batch128` 은 **클라이언트 배치**(한 호출에
> 128문장) 수치라 이 질문의 답이 아니다. 상한선일 뿐이고, 단건 동시요청은
> 요청당 오버헤드(HTTP, 스케줄링, 개별 디코드)가 붙어 반드시 더 낮게 나온다.
> **두 수치를 같은 표에 섞지 말 것.**

측정 도구 = **`flood.py`** (이 폴더, git 추적). 세 모드:

```bash
# 서버에 OpenAI 호환 엔드포인트를 띄운 뒤
python flood.py --url http://localhost:8000/v1 --model trillionlabs/Tri-1.8B-Translation \
  --prompt-style tri --mode ramp                    # ← 핵심: 포화점/최대 처리량

python flood.py ... --mode sustain --concurrency 32 --duration 60   # 지속 안정성
python flood.py ... --mode open --rps 200 --duration 30             # DDoS(백프레셔 없음)
```

| 모드 | 형태 | 답하는 질문 |
|---|---|---|
| `ramp` (기본) | closed-loop, 동시 C건 항상 유지, C 를 1→2→4→… 배증 | **SLA 내 최대 단건 처리량**과 포화점 |
| `sustain` | closed-loop, 고정 C 로 장시간 | 그 부하가 **지속 가능**한가 (전반/후반 p95 비교로 열화 감지) |
| `open` | open-loop, 초당 N발 고정·백프레셔 없음 | **한계 도착률** — 서버가 못 따라가면 큐 폭발 |

**판정 포인트:**
- **포화점** — 동시성을 올려도 처리량이 더 안 오르는 지점. 그 위는 latency 만 증가
- **p95 1.5s 교차** — 실질 상한 (`--break-p95` 로 조정)
- **in-flight 폭증 / 긴 드레인** — open 모드에서 도착률 > 처리율 이라는 직접 증거
- **sustain 전반부 vs 후반부** — 후반 p95 가 크게 높으면 큐 적체 = 지속 불가
- 서버 로그의 배치 크기 — vLLM 은 continuous batching 으로 단건들을 자동으로
  묶는다. 이게 작동해야 단건 처리량이 배치 수치에 근접한다 (안 되면 폭락)

**하네스 자체 검증 완료 (2026-08-14)** — 슬롯 8개·요청당 120ms 목 서버(이론상
한계 66.7/s)에 붙여 세 모드 모두 확인:

```
동시   1   7.9/s  p50 124ms      ← 선형 구간
동시   8  57.0/s  p50 138ms
동시  16  64.3/s  p50 246ms      ← 포화 (처리량 정체, latency 2배)
동시  32  62.9/s  p50 493ms      ← 큐잉만 증가
open 40/s  → 39.3/s 소화 ✅ (in-flight 6)
open 200/s → 53.0/s, p95 15.2s, in-flight 771, 드레인 13.5s ⚠️ 큐 적체 검출
```

이론 한계 66.7/s 를 64.3/s 로 탐지 — 포화점 판정이 정상 작동한다.

**서버 기동 (Tri-1.8B 기준):**

```bash
# vLLM (Linux/WSL2) — continuous batching, OpenAI 호환
pip install vllm
vllm serve trillionlabs/Tri-1.8B-Translation --max-model-len 1024 --gpu-memory-utilization 0.9

# llama.cpp server (Windows 포함 어디서나) — GGUF
./llama-server -hf mradermacher/Tri-1.8B-Translation-GGUF -c 1024 -np 16 --host 0.0.0.0
#   -np 16 = 동시 슬롯 16개. 이 값이 단건 동시성의 상한이 되므로 반드시 올릴 것
```

`--max-model-len 1024` 로 충분하다 (V10 같은 긴 시스템 프롬프트가 없는 번역
전용 모델이라 컨텍스트가 짧다) — KV 캐시가 남아 동시 슬롯을 많이 딸 수 있다.

## 트랙 B 실측 — 2026-08-14, 개발기 4080 Laptop 12GB (llama.cpp Q4_K_M)

### 품질 (18케이스, DeepSeek V10 참조 대비)

| 케이스 | DeepSeek(참조) | **Tri-1.8B** | **TranslateGemma-4B** | NLLB-600M |
|---|---|---|---|---|
| 어제 던전 즐기셨나요 (존댓말) | Did you enjoy the dungeon yesterday? | **동일** ✅ | Did you enjoy playing the dungeon yesterday? ✅ | Did you enjoy the dance last night? ❌ |
| 한국인 아니신가 | You're not Korean? | Aren't you Korean? ✅ | Are you not Korean? ✅ | You're not Korean. (평서) ❌ |
| プレイされてましたか? | Were you playing? | **동일** ✅ | — | Have you played it? △ |
| 待ってます (자기표현) | I'm waiting | **동일** ✅ | I'm waiting. ✅ | I'm waiting for you. △ |
| 낚여버렸네요 ㅋㅋ | I got tricked lol | I got caught. lol ✅ | I was completely fooled! ㅋㅋㅋ ✅ | I'm out of fish. ❌ |
| **ㄱㄱ** | GG | See you. ❌ | **GG** ✅ | A. ❌ |
| anyone up for a raid tonight? | 오늘 밤 레이드 갈 사람 있나요? | 오늘밤 습격할 사람? △ | **오늘 밤 함께 레이드하러 갈 사람 있나요?** ✅ | 오늘 밤 급습을 하고 싶은 사람이 있나요? △ |
| 보스 누가 탱? → jp | ボス、誰がタンクする？ | ボス、誰がタンク？ ✅ | ボスは誰がサポート…❌ | ボス,誰がタン? △ |
| **리젠 언제임?** | When's the respawn? | When is the reunion? ❌ | When is the meeting scheduled? ❌ | When is Regen? ❌ |
| **막공 몇 시 출발?** | (pickup raid) | curtain go up ❌ | final performance ❌ | What time is it? ❌ |
| **반지 먹었어요** | got that ring | ate the ring ❌ | ate that ring ❌ | ate that ring ❌ |
| 今晚打副本吗? | running the dungeon | make a copy ❌ | play a game ❌ | play a copy ❌ |

**판정**: 두 모델 모두 **일반 대화체는 DeepSeek 급**(존댓말→you, 자기표현→I 를
자연히 이행 — NLLB 가 못 하던 것). 그러나 **게임 슬랭/전문용어는 셋 다 전멸**
(리젠·막공·먹다·부본·탱). TranslateGemma 가 `ㄱㄱ`→GG, en→kr 자연스러움에서
앞서고, Tri-1.8B 가 kr→jp 와 간결성에서 앞선다.
→ **G1 게이트: raw 로는 불합격. 게임 슬랭 파인튜닝이 전제 조건.**

### 마스크 생존 (숫자 심화 18케이스)

| | Tri-1.8B | TranslateGemma | NLLB-600M |
|---|---:|---:|---:|
| 숫자 심화 생존 | **15/18** | 14/18 | **16/18** |
| `101` (기본 6문장) | 6/6 | — | 6/6 |
| 6자리 `472938` | 대부분 ✅ | 대부분 ✅ | 12/12 ✅ |

실패 유형이 공통적이다 — **시각(時刻)으로 재해석**: `83051`→"8:30", `9204817`
→"9:20:48:17". 4~6자리는 안전, **7자리 이상은 금지**. 1~2자리는 단어로
spell-out(전 모델 공통).

### 속도 (단일 스트림, 인프로세스)

| 모델 | p50 | 순차 처리량 |
|---|---:|---:|
| Tri-1.8B Q4_K_M | **42ms** | 22.3 msg/s |
| TranslateGemma-4B Q4_K_M | ~106ms | ~9.4 msg/s |
| (참조) DeepSeek API | 637ms | — |

**단일 호출 latency 는 DeepSeek 의 1/15 ~ 1/6.** SLA 여유가 압도적이다.

### ★★ 정정 및 심화 실측 (2026-08-14 2차) — 앞선 1차 수치는 클라이언트 병목이었다

1차 측정을 **Windows 에서 WSL2 로** 쏘았는데, 그게 병목이었다. 서버 지표를
같이 찍어보니 명백했다 — 도착률 110/s 에서 **클라이언트는 in-flight 6,255건 /
p50 68초**인데 **서버는 running 3~8 / queue 0 / KV 0.9% / GPU 여유**. 즉 GPU 는
놀고 있는데 클라이언트·네트워크가 막혀 있었다.

부하 생성기를 **WSL 내부로 옮기자 같은 100/s 가 99.7/s 로 완전히 소화**되었다
(p95 140ms, GPU 80%). 아래는 전부 WSL 내부 측정치다.

> 교훈: 부하 테스트에서 **클라이언트가 병목이 아님을 먼저 증명**해야 한다.
> 서버 지표(`/metrics` 의 running/waiting/KV)와 클라이언트 관측(in-flight)이
> 벌어지면 그건 서버 포화가 아니다. `flood.py` 는 이제 두 관측을 함께 찍는다.

**closed-loop 램프 (WSL 내부, `max_num_batched_tokens` 튜닝 전/후):**

| 동시 | 기본(2048) | **튜닝(8192)** | p50 | p95(튜닝) |
|---:|---:|---:|---:|---:|
| 1 | 11.2/s | 11.1/s | 91ms | 113ms |
| 8 | 75.5/s | 77.7/s | 104ms | 128ms |
| 16 | 141.5/s | 142.9/s | 112ms | 139ms |
| 32 | 244.4/s | 243.9/s | 130ms | 165ms |
| **64** | 142.6/s ❌붕괴 | **257.9/s** ✅ | 172ms | 582ms |
| 128 | — | 77.0/s ❌ | 1018ms | 4731ms |

**동시 64 붕괴의 원인은 KV 캐시가 아니었다.** 전 구간에서
`num_preemptions_total = 0`, `gpu_cache_usage` 최대 5.9% (KV 29,328 토큰 중
거의 안 씀). 실제 원인은 **`max_num_batched_tokens=2048`** — 동시 64 × 프롬프트
60토큰 = 3,840 토큰이 한 iteration 예산을 넘겨 chunked prefill 이 decode 와
경합했다. **8192 로 올리자 붕괴가 사라지고 257.9/s** 로 올라갔다.
→ 서버 기동 시 `--max-num-batched-tokens 8192 --max-num-seqs 128` 권장.

**open-loop sweep (WSL 내부, 60~90초/단계):**

| 도착률 | 처리율 | 달성 | p50 | p95 | 서버 running | KV | preempt |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100/s | 99.7/s | 100% | 112ms | 140ms | 8/10 | 1.3% | 0 |
| **150/s** | **149.8/s** | **100%** | 115ms | 145ms | 13/16 | 1.9% | 0 |
| 200/s | 30.1/s | 15% | 238s | 293s | 18/70 | 5.8% | 0 |

200/s 에서도 서버 running 은 평균 18 에 그치고 GPU 는 오히려 67% 로 **내려간다**
— 이 지점은 여전히 **부하 생성기(단일 파이썬 asyncio)** 한계다. 서버 진짜
한계는 아래 vLLM 공식 벤치로 확인했다.

**vLLM 공식 벤치 (`vllm bench serve`, random 60-in/20-out, `--ignore-eos`):**

| 도착률 | 달성 처리율 | TTFT median | TTFT P99 |
|---|---:|---:|---:|
| 150/s | 135.2/s | 50ms | 107ms |
| **200/s** | **165.3/s** | 107ms | 608ms |
| **∞ (일시 투입)** | **133.5/s** ↓ | **13,049ms** | 21,533ms |

**`inf` 가 200/s 보다 처리량이 낮다(165 → 133/s)** — 무제한 투입은 latency 만
망치는 게 아니라 **처리량 자체를 깎는다.** admission control 이 성능 최적화이기도
하다는 직접 증거.

출력 토큰 기준으로 보면 일관된다: 공식 벤치 165/s × 20 tok ≈ 3,300 tok/s,
우리 워크로드 244/s × ~11 tok ≈ 2,700 tok/s → **이 GPU 의 천장은 출력
~3,000 tok/s 부근**이고, req/s 는 출력 길이에 반비례한다.

### 운영 결론 (사용자 제안 구조 실측 확인)

```
Game ──► Translation Service ──► [cache] ──miss──► Queue ──► vLLM
                                                   │
                                          max in-flight 32~64
```

| 지표 | 값 | 근거 |
|---|---:|---|
| Peak saturation throughput | ~258 msg/s | 동시 64, 튜닝 후 |
| **권장 운영점(동시)** | **32** | p95 165ms — latency/처리량 균형 최적 |
| 안전 도착률 (검증) | **150/s** | 달성률 100%, p95 145ms |
| 서버 실측 상한 | ~165 req/s | vLLM 공식 벤치(20 tok 출력 기준) |

**admission control 로 GPU in-flight 를 32~64 로 제한**하면 도착률이 300/s 로
튀어도 GPU 는 sweet spot 에서 동작한다. 제한 없이 밀어 넣으면 위 `inf` 결과처럼
처리량까지 잃는다. 번역 서버가 캐시일 뿐 아니라 **load regulator** 여야 하는
이유가 실측으로 확인됐다.

fan-out 3 기준 **입력 채팅 ~50/s (동시 32 운영점)**. 수신자가 몇 명이든 타겟
언어 수만큼만 번역하므로, 언어 3개면 350명 채널이든 3회다.

### (1차) Windows→WSL 측정 — 클라이언트 병목으로 폐기

`vllm serve trillionlabs/Tri-1.8B-Translation --max-model-len 1024 --gpu-memory-utilization 0.85`
(vLLM 0.9.2, WSL2). `flood.py --mode ramp --prompt-style tri`:

| 동시 | 처리량 | p50 | p95 | 판정 |
|---:|---:|---:|---:|---|
| 1 | 10.8/s | 93ms | 116ms | |
| 2 | 20.4/s | 98ms | 121ms | 선형 |
| 4 | 38.8/s | 102ms | 128ms | 선형 |
| 8 | 74.0/s | 106ms | 136ms | 선형 |
| 16 | 135.5/s | 118ms | 147ms | 선형 (latency 거의 불변!) |
| **32** | **205.5/s** | **141ms** | **262ms** | ★ SLA 내 최대 |
| 64 | 90.8/s | 175ms | 2836ms | 붕괴 — KV 캐시 포화 |

**★ SLA(p95<1.5s) 내 최대 단건 처리량 = 205 msg/s (동시 32, p95 262ms).**

continuous batching 이 확실히 작동한다 — 동시 1→32 에서 처리량이 **19배**
오르는 동안 p50 은 93→141ms 로 거의 안 움직인다. llama-cpp-python(20/s 고정)
대비 **10배**. 동시 64 에서 급락하는 것은 `max-model-len 1024` × 동시 64 가
KV 캐시를 넘겨 preemption 이 발생하기 때문 — 서버에서 8GB 면 이 한계가 더
낮으므로 동시성 상한을 보수적으로 잡을 것.

**지속 가능성** (`--mode sustain --concurrency 32 --duration 45`):
전반부 168.3/s p95 326ms · 후반부 168.3/s p95 549ms — **처리량은 완전 유지**,
p95 만 소폭 상승. 45초 지속 부하에서 큐 적체 없음(에러 0).

**한계 도착률** (`--mode open`, 백프레셔 없음):

| 도착률 | 처리율 | p95 | in-flight | 판정 |
|---:|---:|---:|---:|---|
| 60/s | 59.7/s | 274ms | 29 | ✅ 소화 |
| 90/s | 89.6/s | 138ms | 15 | ✅ 소화 |
| 150/s | 99.5/s | 11.2s | 752 | ⚠️ 큐 폭발 |

→ **안전 운영선 ~90 msg/s (도착률 기준), 버스트 상한 ~205 msg/s (동시 32).**

### 참고 — llama-cpp-python 서버는 직렬 처리 (같은 모델, 같은 GPU)

`flood.py --mode ramp` (Tri-1.8B, llama-cpp-python 서버):

```
동시  1   19.4/s  p50   51ms
동시  2   20.6/s  p50   96ms
동시  4   20.1/s  p50  197ms
동시  8   20.7/s  p50  383ms
동시 16   20.4/s  p50  782ms
동시 32   20.0/s  p50 1585ms
```

**처리량이 완전히 평평하고 latency 만 동시성에 정비례** = 교과서적 직렬화
패턴. 인프로세스 순차(22.3/s)와 사실상 같은 값이므로 **동시성 이득 0**.
GPU 한계가 아니라 **llama-cpp-python 서버가 모델 락으로 요청을 직렬 처리**
하기 때문 — 같은 모델·같은 GPU 에서 vLLM 은 205/s 를 냈다(위). **10배 차이.**

→ 교훈: **서빙 스택 선택이 모델 선택만큼 중요하다.** GGUF/llama-cpp-python 은
품질·단일 latency 확인용으로만 쓰고, 처리량 판단은 반드시 vLLM 으로 할 것.

## 서버에서 할 일 (TODO)

**트랙 B — 개발기(4080)에서 품질/마스크/latency/동시성 전부 측정 완료. 남은 것:**
- [ ] **3060 Ti(8GB)에서 재측정** — 4080 12GB 대비 VRAM 이 작아 **KV 캐시가
      먼저 한계**다. 동시 64 붕괴 지점이 더 낮게 올 것이므로 `--mode ramp` 로
      그 지점을 다시 찾을 것. 절차는 아래 §서버 재현 그대로
- [ ] `translategemma-4b-it` 동시성 (4B 라 8GB 에서 KV 여유가 더 빠듯). 채택
      검토 시 **Gemma Terms 상용 조건 법무 확인 선행** (원본 HF repo 는 게이트)
- [ ] 게임 슬랭 대응 설계 — glossary 강제 치환 + 캐시 승격으로 흡수(사용자
      방향, 2026-08-14). 봇의 `glossary.js`/`corpus_log.js` 가 이미 그 골격

### 서버 재현 절차 (개발기에서 검증된 순서)

```bash
# 1) uv (sudo 불필요, python3-venv 없어도 됨)
curl -LsSf https://astral.sh/uv/install.sh | sh && export PATH=$HOME/.local/bin:$PATH
# 2) 헤더 포함 Python (시스템 python3-dev 없으면 triton 컴파일 실패)
uv python install 3.12
uv venv ~/vllmenv --python ~/.local/share/uv/python/cpython-3.12-*/bin/python3.12
# 3) 드라이버에 맞는 vLLM — cu130 은 드라이버 580+ 필요. 구드라이버면 0.9.2(cu126)
uv pip install --python ~/vllmenv/bin/python 'vllm==0.9.2' 'transformers==4.53.2'
# 4) 기동 → 별 터미널에서 flood
~/vllmenv/bin/vllm serve trillionlabs/Tri-1.8B-Translation --max-model-len 1024 --gpu-memory-utilization 0.85
python flood.py --url http://localhost:8000/v1 --model trillionlabs/Tri-1.8B-Translation --prompt-style tri --mode ramp
```

기동 실패 시 밟았던 함정 3종(전부 개발기에서 실제로 겪음):
`torch cu130 vs 구드라이버` → vLLM 0.9.2 로 다운 / `transformers 'aimv2' 충돌`
→ 4.53.2 핀 / `triton gcc Python.h 없음` → uv 관리 Python 사용.

**트랙 A (seq2seq):**
- [ ] `madlad3b` 전체 3스테이지 — Apache 2.0 후보의 raw 품질
- [ ] `m2m100-1.2b` 전체 3스테이지 — MIT 베이스라인
- [ ] (여유 시) `nllb1.3b` quality — 크기↑가 슬랭을 얼마나 줄이는지 참고
- [ ] `bench_mt.py` 에도 단건 동시성 스테이지가 필요한지 판단 (CT2 는 인프로세스라
      HTTP 오버헤드가 없어 트랙 B 와 직접 비교 불가 — 서빙 방식을 맞춰야 함)

**공통:**
- [ ] 결과를 이 파일 "실측" 섹션에 추가 (모델·장치·**측정 형태(배치 vs 단건)** 명시)
- [ ] 판정 회의: raw 채택 가능? / 파인튜닝 트랙(corpus log 증류) 진입? / 범용 LLM 2안?

## 파일

- `bench_mt.py` — 트랙 A(seq2seq) 3스테이지 하네스: quality / mask / speed.
  모델 자동 다운로드, CUDA→CPU 폴백, Windows GPU DLL 경로 처리, UTF-8 출력.
- `flood.py` — **단건 동시성 하네스** (트랙 B 및 모든 OpenAI 호환 엔드포인트).
  ramp / sustain / open 3모드. 모델별 프롬프트 어댑터(`--prompt-style`),
  `--api chat|completions`.
- `quality_llm.py` — 트랙 B 품질/마스크 (GGUF 인프로세스). `bench_mt.py` 와
  **같은 케이스**를 써서 트랙 A 와 직접 비교된다.
- `serve_gguf.py` — GGUF 를 OpenAI 호환 서버로 기동 (flood.py 부하 대상)
- `cuda_path.py` — Windows 에서 pip NVIDIA 런타임 DLL 경로 등록 (공용 헬퍼)
- `requirements.txt` — 검증된 버전 (Windows py3.13 + CUDA 12 에서 확인)

### 함정 (실측으로 확인된 것 — 서버에서도 동일하게 밟는다)

1. **chat template 모델에 raw completions 금지.** Tri-1.8B 는 ChatML 템플릿을
   갖고 있어서, 모델 카드의 프롬프트 문자열을 `/completions` 로 보내면 EOS 가
   안 걸려 무한 반복한다. 측정값도 6배 왜곡됐다(3.3 → 20 msg/s).
   `flood.py --api chat`(기본값) 유지할 것.
2. **TranslateGemma 는 OpenAI 표준 형식이 아니다.** chat template 이 구조화
   content 를 강제한다:
   `{"type":"text","source_lang_code":"ko","target_lang_code":"en","text":"..."}`.
   평문 문자열을 보내면 ValueError. 범용 클라이언트 연동 시 어댑터 필요.
3. **Windows CUDA DLL** — `ctranslate2`/`llama_cpp` 는 plain LoadLibrary 라
   `cuda_path` 를 먼저 import 해야 한다. Linux 는 불필요.

> 개발기 로컬에는 `bench/`(디스코드 봇용 JS 하네스 + 비용/설계 문서)가 있지만
> **`.git/info/exclude` 로 추적 제외라 서버 clone 에는 없다.** 서버에서 필요한
> 것은 전부 이 `mtbench/` 안에 있다.
