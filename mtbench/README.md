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

## 서버에서 할 일 (TODO)

**트랙 B (우선 — 단건 동시성이 핵심 질문):**
- [ ] `Tri-1.8B-Translation` 서버 기동(vLLM 또는 llama.cpp) → `flood.py --mode ramp`
      로 **SLA 내 최대 단건 처리량** 확보. 우리 4개 언어 정확 일치 + Apache 2.0 이라 1순위
- [ ] 이어서 `--mode sustain` 으로 그 부하의 지속 가능성, `--mode open` 으로 한계 도착률
- [ ] 같은 모델 품질 — 프롬프트 어댑터 붙여 `quality.js`, 또는 수동 케이스로
      §초기실측의 18케이스(슬랭/존댓말/마스크) 재현 비교
- [ ] `translategemma-4b-it` 동일 절차. **Gemma Terms 상용 조건 법무 확인 선행**
- [ ] 두 모델 단건 RPS/p95/품질 비교표 → 이 파일에 추가

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
  ramp / sustain / open 3모드. 모델별 프롬프트 어댑터(`--prompt-style`).
- `requirements.txt` — 검증된 버전 (Windows py3.13 + CUDA 12 에서 확인)

> 개발기 로컬에는 `bench/`(디스코드 봇용 JS 하네스 + 비용/설계 문서)가 있지만
> **`.git/info/exclude` 로 추적 제외라 서버 clone 에는 없다.** 서버에서 필요한
> 것은 전부 이 `mtbench/` 안에 있다.
