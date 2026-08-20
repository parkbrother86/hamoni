#!/usr/bin/env python3
"""순수 MT 모델 실험 하네스 (CTranslate2) — 3060 Ti 8GB 대상.

목표/게이트/모델 후보는 mtbench/README.md 참조.

    python bench_mt.py --model nllb600m                # 전체 스테이지
    python bench_mt.py --model madlad3b --stage mask   # 특정 스테이지만
    python bench_mt.py --model-dir ./my-ct2-model --family nllb

스테이지:
    quality  대표 케이스 번역 → DeepSeek 참조와 나란히 출력 (육안 판정용)
    mask     placeholder 마스크 형태별 생존율 (지시 없이 복사되는가)
    speed    배치 크기별 처리량 + 단일 스트림 latency
"""

import argparse
import glob
import os
import statistics
import sys
import time

# Windows 파이프/리다이렉트에서 한글 mojibake 방지
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# pip 로 설치한 NVIDIA 런타임(nvidia-cublas-cu12, nvidia-cudnn-cu12)의 DLL 을
# Windows 에서 찾을 수 있게 등록. ctranslate2 는 plain LoadLibrary 로 DLL 을
# 열기 때문에 add_dll_directory 만으로는 부족하고 PATH 선두 추가가 필요하다.
# (Linux 휠은 rpath 로 자동 해결)
if os.name == "nt":
    dll_dirs = []
    for site in sys.path:
        dll_dirs += glob.glob(os.path.join(site, "nvidia", "*", "bin"))
    for d in dll_dirs:
        try:
            os.add_dll_directory(d)
        except OSError:
            pass
    if dll_dirs:
        os.environ["PATH"] = os.pathsep.join(dll_dirs) + os.pathsep + os.environ.get("PATH", "")

import ctranslate2
import transformers

# ---------------------------------------------------------------------------
# 모델 카탈로그
#
# license 주의: NLLB 는 CC-BY-NC 4.0 — 상용 배포 불가, 품질 상한 참고용으로만.
# 프로덕션 후보는 Apache/MIT 계열 (madlad3b, m2m100).
# ---------------------------------------------------------------------------

CATALOG = {
    "nllb600m": {
        "family": "nllb",
        "license": "CC-BY-NC 4.0 (실험 전용, 상용 불가)",
        "ct2_repos": ["entai2965/nllb-200-distilled-600M-ctranslate2"],
        "tokenizer": "facebook/nllb-200-distilled-600M",
    },
    "nllb1.3b": {
        "family": "nllb",
        "license": "CC-BY-NC 4.0 (실험 전용, 상용 불가)",
        "ct2_repos": ["entai2965/nllb-200-distilled-1.3B-ctranslate2"],
        "tokenizer": "facebook/nllb-200-distilled-1.3B",
    },
    "m2m100-1.2b": {
        "family": "m2m100",
        "license": "MIT",
        "ct2_repos": ["entai2965/m2m100_1.2B-ctranslate2"],
        "tokenizer": "facebook/m2m100_1.2B",
    },
    "madlad3b": {
        "family": "madlad",
        "license": "Apache 2.0",
        "ct2_repos": ["santhosh/madlad400-3b-ct2"],
        "tokenizer": "google/madlad400-3b-mt",
    },
}

LANG = {
    "nllb": {"kr": "kor_Hang", "en": "eng_Latn", "jp": "jpn_Jpan", "cn": "zho_Hans"},
    "m2m100": {"kr": "ko", "en": "en", "jp": "ja", "cn": "zh"},
    "madlad": {"kr": "ko", "en": "en", "jp": "ja", "cn": "zh"},  # <2xx> 태그용
}

# ---------------------------------------------------------------------------
# 케이스 (DeepSeek V10 참조 출력 = bench/LLM_BENCHMARK.md + 2026-08-13 스모크)
# ---------------------------------------------------------------------------

# ⚠️ 참조값 출처 주의 (2026-08-20 정정): 일반 문장은 DeepSeek V10 출력이지만,
# 슬랭은 **사용자 확정 정답**이다. DeepSeek 이 슬랭에서 틀리기 때문에
# (`ㄱㄱ`→"GG" 오역) 참조를 그대로 ground truth 로 쓰면 채점이 반전된다.
QUALITY_CASES = [
    # (src, tgt, 원문, 참조 정답, 관찰 포인트)
    ("kr", "en", "보스 잡았어?", "Boss down?", "fragment 유지?"),
    ("kr", "en", "괜찮음?", "Okay?", "fragment 유지? (you 발명 여부)"),
    ("kr", "en", "리젠 언제임?", "When's the respawn?", "게임 용어 '리젠'"),
    ("kr", "en", "막공 몇 시 출발?", "(pickup raid ...)", "슬랭 '막공' — luna 는 오역"),
    ("kr", "en", "탱커 한 명 더 구해요", "Looking for one more tank.", "게임 용어"),
    ("kr", "en", "한국인 아니신가", "You're not Korean?", "존댓말 → you (MT 는 실패 예상)"),
    ("kr", "en", "어제 던전 즐기셨나요", "Did you enjoy the dungeon yesterday?", "존댓말 → you"),
    ("kr", "en", "낚여버렸네요 ㅋㅋ", "I got tricked lol", "자기표현 → I + 'ㅋㅋ'"),
    ("kr", "en", "저 오늘 드디어 그 반지 먹었어요", "I finally got that ring today!", "'먹었어요' = 획득"),
    ("kr", "en", "에란시아 서버 사람?", "(Eransia ...)", "고유명사 음역"),
    # 초성 슬랭 — 사용자 확정 정답 (2026-08-20). 모델이 추론할 대상이 아니라
    # glossary 에 박을 항목이다 — 전 모델 실패가 이미 확인됨.
    ("kr", "en", "ㄱㄱ", "go go / let's go", "초성 슬랭 — GG 가 아니다"),
    ("kr", "en", "ㅈㅈ", "GG", "초성 슬랭 — 항복/좋은 게임"),
    ("kr", "en", "ㅊㅊ", "congrats", "초성 슬랭 — 축하"),
    ("kr", "en", "ㅊㅋㅊㅋ", "congrats", "초성 슬랭 — 축하 (반복형)"),
    ("jp", "en", "待ってます", "I'm waiting", "자기표현 → I"),
    ("jp", "en", "プレイされてましたか?", "Were you playing?", "존댓말"),
    ("jp", "kr", "明日も来ますか？", "내일도 올 거예요?", "jp→kr 직접"),
    ("cn", "en", "今晚打副本吗？", "Are we running the dungeon tonight?", "부본=던전"),
    ("en", "kr", "anyone up for a raid tonight?", "오늘 밤 레이드 갈 사람 있나요?", "en→kr"),
    ("kr", "jp", "보스 누가 탱?", "ボス、誰がタンクする？", "kr→jp 직접"),
    ("kr", "cn", "보스 누가 탱?", "BOSS谁T？", "kr→cn 직접"),
]

MASK_SHAPES = ["⟪T0⟫", "{a}", "T0", "[1]", "101", "<x>"]
MASK_CARRIERS = [  # {M} 자리에 마스크 삽입, kr→en
    "{M} 지금 어디야?",
    "이따가 {M} 하고 사냥 가자",
    "아이템은 {M} 한테 줘",
    "{M} 없이는 못 깸",
    "내일 {M} 시간 돼?",
    "그건 {M} 가 제일 잘 알아",
]

# 숫자 마스크 심화: 난수형 마스크(멘션/이모지 치환용)가 실전 조건에서 사는가.
# (src, tgt, 문장, [살아야 하는 마스크들], 관찰 포인트)
DIGIT_CASES = [
    # 자릿수 스윕 (같은 캐리어 2종)
    ("kr", "en", "이따가 9 하고 사냥 가자", ["9"], "1자리 — 실숫자와 구분 불가 위험"),
    ("kr", "en", "이따가 42 하고 사냥 가자", ["42"], "2자리"),
    ("kr", "en", "이따가 1047 하고 사냥 가자", ["1047"], "4자리"),
    ("kr", "en", "이따가 83051 하고 사냥 가자", ["83051"], "5자리"),
    ("kr", "en", "이따가 472938 하고 사냥 가자", ["472938"], "6자리 난수"),
    ("kr", "en", "이따가 9204817 하고 사냥 가자", ["9204817"], "7자리"),
    ("kr", "en", "472938 지금 어디야?", ["472938"], "문두"),
    ("kr", "en", "그 아이템은 472938 한테 줘", ["472938"], "문중"),
    ("kr", "en", "가장 센 사람은 472938", ["472938"], "문미"),
    # 실전 조건
    ("kr", "en", "472938님 어디 계세요?", ["472938"], "조사/호칭 직결합 (멘션+님)"),
    ("kr", "en", "472938 5분 뒤에 리젠이야", ["472938"], "실제 숫자와 공존"),
    ("kr", "en", "레벨 80 넘으면 472938 한테 말 걸어", ["472938"], "실숫자+마스크 혼재"),
    ("kr", "en", "472938 하고 190283 둘 다 소환해 줘", ["472938", "190283"], "다중 마스크 2개"),
    ("kr", "en", "472938, 190283, 557201 셋 다 와", ["472938", "190283", "557201"], "다중 3개 나열"),
    # 타 방향
    ("jp", "en", "あとで 472938 と狩りに行こう", ["472938"], "jp→en"),
    ("cn", "en", "472938 现在在哪？", ["472938"], "cn→en"),
    ("en", "kr", "give the sword to 472938 later", ["472938"], "en→kr"),
    ("kr", "jp", "이따가 472938 하고 사냥 가자", ["472938"], "kr→jp"),
]

SPEED_LINES = [  # 처리량 측정용 짧은 게임챗 (kr→en)
    "보스 리젠 10분 남았어", "탱커 구해요", "물약 남은 사람?", "사냥터 어디가 좋아?",
    "길드전 몇 시야?", "그 아이템 얼마에 팔아?", "파티 자리 있어?", "레벨 몇 찍었어?",
    "퀘스트 같이 할 사람", "지금 접속한 사람 몇 명?", "무기 강화 실패했어 ㅠㅠ", "이번 패치 어때?",
    "던전 입장 조건이 뭐야?", "힐러 없으면 못 가", "경험치 이벤트 언제까지야?", "그 보스 패턴 알려줘",
    "장비 세팅 좀 봐줘", "막공 모집합니다", "거래 사기 조심해", "신규 맵 가봤어?",
    "스킬 트리 뭐가 좋아?", "결투장 같이 가자", "골드 시세 올랐네", "서버 점검 언제 끝나?",
]

# ---------------------------------------------------------------------------


def load_model(args):
    if args.model_dir:
        model_dir, family = args.model_dir, args.family
        license_note = "(--model-dir 직접 지정)"
        tokenizer_repo = args.tokenizer or CATALOG.get(args.model, {}).get("tokenizer")
        if not family or not tokenizer_repo:
            sys.exit("--model-dir 사용 시 --family 와 --tokenizer 도 지정하세요")
    else:
        entry = CATALOG.get(args.model)
        if not entry:
            sys.exit(f"unknown --model {args.model}. 선택지: {', '.join(CATALOG)}")
        family, license_note, tokenizer_repo = entry["family"], entry["license"], entry["tokenizer"]
        from huggingface_hub import snapshot_download

        model_dir = None
        for repo in entry["ct2_repos"]:
            try:
                print(f"[모델] {repo} 다운로드/캐시 확인...")
                model_dir = snapshot_download(repo)
                break
            except Exception as e:
                print(f"[모델] {repo} 실패: {type(e).__name__}")
        if not model_dir:
            sys.exit(
                "사전 변환본 다운로드 실패. 직접 변환하세요:\n"
                "  pip install torch --index-url https://download.pytorch.org/whl/cpu\n"
                f"  ct2-transformers-converter --model {tokenizer_repo} "
                "--output_dir ./model-ct2 --quantization int8\n"
                f"  python bench_mt.py --model-dir ./model-ct2 --family {family} --tokenizer {tokenizer_repo}"
            )

    tok = transformers.AutoTokenizer.from_pretrained(tokenizer_repo)

    device = args.device
    translator = None
    if device in ("auto", "cuda"):
        try:
            translator = ctranslate2.Translator(model_dir, device="cuda", compute_type="int8_float16")
            # init 은 성공해도 cuBLAS/cuDNN DLL 이 없으면 첫 연산에서 죽는다 —
            # 여기서 워밍업 1회로 확정하고 실패 시 CPU 폴백.
            translate_batch(translator, tok, family, [("kr", "en", "테스트")])
            device = "cuda"
        except Exception as e:
            print(f"[장치] CUDA 사용 불가({type(e).__name__}: {e})")
            print("[장치] → CPU 폴백. GPU 를 쓰려면: pip install nvidia-cublas-cu12 nvidia-cudnn-cu12")
            translator = None
            if args.device == "cuda":
                raise
    if translator is None:
        translator = ctranslate2.Translator(model_dir, device="cpu", compute_type="int8")
        device = "cpu"

    print(f"[모델] family={family} device={device} license={license_note}")
    return translator, tok, family, device


def translate_batch(translator, tok, family, pairs, beam_size=1):
    """pairs: [(src, tgt, text)] → [출력 텍스트]"""
    sources, prefixes = [], []
    for src, tgt, text in pairs:
        if family == "nllb":
            tok.src_lang = LANG["nllb"][src]
            ids = tok.encode(text)
            sources.append(tok.convert_ids_to_tokens(ids))
            prefixes.append([LANG["nllb"][tgt]])
        elif family == "m2m100":
            tok.src_lang = LANG["m2m100"][src]
            ids = tok.encode(text)
            sources.append(tok.convert_ids_to_tokens(ids))
            prefixes.append([f"__{LANG['m2m100'][tgt]}__"])
        elif family == "madlad":
            # MADLAD: 타겟 언어 태그를 소스 앞에 붙인다. <2xx> 형식.
            tagged = f"<2{LANG['madlad'][tgt]}> {text}"
            ids = tok.encode(tagged)
            sources.append(tok.convert_ids_to_tokens(ids))
            prefixes.append(None)
        else:
            sys.exit(f"unknown family {family}")

    kw = dict(beam_size=beam_size, max_decoding_length=128)
    if any(p for p in prefixes):
        results = translator.translate_batch(sources, target_prefix=prefixes, **kw)
    else:
        results = translator.translate_batch(sources, **kw)

    outs = []
    for i, r in enumerate(results):
        tokens = r.hypotheses[0]
        if prefixes[i]:  # 타겟 언어 토큰 제거
            tokens = [t for t in tokens if t not in prefixes[i]]
        text = tok.decode(tok.convert_tokens_to_ids(tokens), skip_special_tokens=True)
        outs.append(text.strip())
    return outs


def stage_quality(translator, tok, family):
    print("\n=== [quality] 대표 케이스 vs DeepSeek 참조 (육안 판정) ===")
    pairs = [(s, t, x) for s, t, x, _, _ in QUALITY_CASES]
    outs = translate_batch(translator, tok, family, pairs, beam_size=4)
    w = max(len(x) for _, _, x, _, _ in QUALITY_CASES)
    for (src, tgt, text, ref, note), out in zip(QUALITY_CASES, outs):
        print(f"[{src}→{tgt}] {text}")
        print(f"    MT : {out}")
        print(f"    ref: {ref}   ({note})")


def stage_mask(translator, tok, family):
    print("\n=== [mask] placeholder 마스크 생존율 (지시 없음 — 순수 복사 습관) ===")
    print(f"형태 {len(MASK_SHAPES)}종 × 문장 {len(MASK_CARRIERS)}개, kr→en, beam 1/4 모두 측정\n")
    header = "마스크".ljust(8) + "beam1 생존".rjust(12) + "beam4 생존".rjust(12) + "  실패 예시"
    print(header)
    for shape in MASK_SHAPES:
        row = []
        fail_example = ""
        for beam in (1, 4):
            pairs = [("kr", "en", c.replace("{M}", shape)) for c in MASK_CARRIERS]
            outs = translate_batch(translator, tok, family, pairs, beam_size=beam)
            ok = sum(1 for o in outs if o.count(shape) == 1)
            row.append(f"{ok}/{len(outs)}")
            if not fail_example:
                for c, o in zip(MASK_CARRIERS, outs):
                    if o.count(shape) != 1:
                        fail_example = f"'{c.replace('{M}', shape)}' → '{o}'"
                        break
        print(shape.ljust(8) + row[0].rjust(12) + row[1].rjust(12) + "  " + fail_example[:60])

    print("\n--- 숫자 마스크 심화 (beam 4) ---")
    pairs = [(s, t, x) for s, t, x, _, _ in DIGIT_CASES]
    outs = translate_batch(translator, tok, family, pairs, beam_size=4)
    ok_total = 0
    for (src, tgt, text, masks, note), out in zip(DIGIT_CASES, outs):
        ok = all(out.count(m) == 1 for m in masks)
        ok_total += ok
        mark = "✅" if ok else "❌"
        print(f"{mark} [{src}→{tgt}] {text}")
        print(f"     → {out}   ({note})")
    print(f"\n숫자 심화 생존: {ok_total}/{len(DIGIT_CASES)}")


def stage_speed(translator, tok, family, device):
    print(f"\n=== [speed] 처리량/latency (device={device}) ===")
    n_total = 256
    lines = (SPEED_LINES * (n_total // len(SPEED_LINES) + 1))[:n_total]
    pairs = [("kr", "en", x) for x in lines]

    # 워밍업
    translate_batch(translator, tok, family, pairs[:8])

    print("배치".rjust(6) + "총 시간".rjust(10) + "msg/s".rjust(9))
    for bs in (1, 8, 32, 128):
        t0 = time.perf_counter()
        for i in range(0, n_total, bs):
            translate_batch(translator, tok, family, pairs[i : i + bs])
        dt = time.perf_counter() - t0
        print(f"{bs:>6}{dt:>9.1f}s{n_total / dt:>9.1f}")
        if device == "cpu" and dt > 120:
            print("  (CPU 가 너무 느려 이후 배치 생략 — speed 는 GPU 에서 재실행)")
            break

    lat = []
    for _, _, text in pairs[:30]:
        t0 = time.perf_counter()
        translate_batch(translator, tok, family, [("kr", "en", text)])
        lat.append((time.perf_counter() - t0) * 1000)
    lat.sort()
    print(
        f"단일 스트림 latency: p50 {statistics.median(lat):.0f}ms / "
        f"p95 {lat[int(len(lat) * 0.95) - 1]:.0f}ms / min {lat[0]:.0f}ms"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="nllb600m", help=f"{'/'.join(CATALOG)} (기본 nllb600m)")
    ap.add_argument("--model-dir", help="직접 변환한 CT2 모델 경로")
    ap.add_argument("--family", choices=["nllb", "m2m100", "madlad"], help="--model-dir 용")
    ap.add_argument("--tokenizer", help="--model-dir 용 HF 토크나이저 리포")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--stage", default="all", choices=["all", "quality", "mask", "speed"])
    args = ap.parse_args()

    translator, tok, family, device = load_model(args)
    if args.stage in ("all", "quality"):
        stage_quality(translator, tok, family)
    if args.stage in ("all", "mask"):
        stage_mask(translator, tok, family)
    if args.stage in ("all", "speed"):
        stage_speed(translator, tok, family, device)


if __name__ == "__main__":
    main()
