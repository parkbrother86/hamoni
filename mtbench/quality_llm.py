#!/usr/bin/env python3
"""트랙 B(번역 특화 decoder LLM) 품질 하네스 — GGUF 를 llama.cpp 로 인프로세스 실행.

트랙 A(`bench_mt.py`)와 같은 케이스를 돌려 직접 비교 가능하게 한다.
서빙 처리량은 `flood.py` 담당 (이 스크립트는 품질만).

    python quality_llm.py --model tri
    python quality_llm.py --model gemma --stage mask
    python quality_llm.py --gguf ./my-model.gguf --prompt-style tri
"""

import argparse
import sys
import time

import cuda_path  # noqa: F401  (llama_cpp import 보다 먼저)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from bench_mt import DIGIT_CASES, MASK_CARRIERS, MASK_SHAPES, QUALITY_CASES

CATALOG = {
    "tri": {
        "repo": "mradermacher/Tri-1.8B-Translation-GGUF",
        "file": "Tri-1.8B-Translation.Q4_K_M.gguf",
        "style": "tri",
        "license": "Apache 2.0",
    },
    "gemma": {
        "repo": "mradermacher/translategemma-4b-it-GGUF",
        "file": "translategemma-4b-it.Q4_K_M.gguf",
        "style": "gemma",
        "license": "Gemma Terms (상용 조건 법무 확인 필요)",
    },
    # 12B 는 배포 후보가 아니라 품질 상한 레퍼런스다 — "슬랭 실패가 규모 문제인가
    # 지식 문제인가" 를 가른다. Q4_K_M(~6.8GiB) 은 4B 테스트와 같은 양자화라
    # 직접 비교가 되고, 렌탈 상한인 16GB VRAM 에도 여유로 들어간다.
    "gemma12b": {
        "repo": "mradermacher/translategemma-12b-it-GGUF",
        "file": "translategemma-12b-it.Q4_K_M.gguf",
        "style": "gemma",
        "license": "Gemma Terms (상용 조건 법무 확인 필요)",
    },
}

LANG_NAME = {"kr": "Korean", "en": "English", "jp": "Japanese", "cn": "Chinese"}
TAG = {"kr": "ko", "en": "en", "jp": "ja", "cn": "zh"}


def build_messages(style, src, tgt, text):
    """모델별 chat 메시지. 두 모델의 입력 규약이 완전히 다르다."""
    if style == "tri":
        # 모델 카드 형식: "Translate the following {SRC} text into {TGT}:\n{TEXT} <{tag}>"
        return [{
            "role": "user",
            "content": f"Translate the following {LANG_NAME[src]} text into {LANG_NAME[tgt]}:\n{text} <{TAG[tgt]}>",
        }]
    if style == "gemma":
        # TranslateGemma 는 chat template 이 구조화 content 를 요구한다 —
        # 평문 문자열을 보내면 ValueError. OpenAI 표준 형태가 아니므로
        # 범용 클라이언트로 붙일 때 어댑터가 필요하다.
        return [{
            "role": "user",
            "content": [{
                "type": "text",
                "source_lang_code": TAG[src],
                "target_lang_code": TAG[tgt],
                "text": text,
            }],
        }]
    raise SystemExit(f"unknown style {style}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="tri", choices=list(CATALOG))
    ap.add_argument("--gguf", help="로컬 GGUF 경로 (카탈로그 대신)")
    ap.add_argument("--prompt-style", choices=["tri", "gemma"])
    ap.add_argument("--stage", default="all", choices=["all", "quality", "mask"])
    ap.add_argument("--n-gpu-layers", type=int, default=-1, help="-1 = 전부 GPU")
    ap.add_argument("--ctx", type=int, default=1024)
    args = ap.parse_args()

    entry = CATALOG[args.model]
    style = args.prompt_style or entry["style"]

    from llama_cpp import Llama

    if args.gguf:
        llm = Llama(model_path=args.gguf, n_gpu_layers=args.n_gpu_layers, n_ctx=args.ctx, verbose=False)
        print(f"[모델] {args.gguf} · style={style}")
    else:
        llm = Llama.from_pretrained(
            repo_id=entry["repo"], filename=entry["file"],
            n_gpu_layers=args.n_gpu_layers, n_ctx=args.ctx, verbose=False,
        )
        print(f"[모델] {entry['repo']} / {entry['file']}")
        print(f"[라이선스] {entry['license']} · style={style}")

    # GGUF 에 chat template 이 있으면 chat 경로를 쓴다. 모델 카드의 raw 프롬프트
    # 형식을 그대로 completion 으로 보내면 EOS 가 안 걸려 무한 반복에 빠진다
    # (Tri-1.8B 는 ChatML 템플릿 보유 — 2026-08-14 실측).
    has_template = bool(llm.metadata.get("tokenizer.chat_template"))
    print(f"[형식] {'chat (chat_template 감지)' if has_template else 'completion'}")

    def translate(src, tgt, text):
        msgs = build_messages(style, src, tgt, text)
        if has_template:
            out = llm.create_chat_completion(msgs, max_tokens=128, temperature=0)
            return (out["choices"][0]["message"]["content"] or "").strip()
        # template 없는 모델만 raw completion (반복 방지 파라미터 필요)
        out = llm(msgs[0]["content"], max_tokens=128, temperature=0, repeat_penalty=1.15)
        return out["choices"][0]["text"].strip().split("\n")[0]

    if args.stage in ("all", "quality"):
        print("\n=== [quality] 대표 케이스 vs DeepSeek 참조 ===")
        t0 = time.perf_counter()
        for src, tgt, text, ref, note in QUALITY_CASES:
            print(f"[{src}→{tgt}] {text}")
            print(f"    MT : {translate(src, tgt, text)}")
            print(f"    ref: {ref}   ({note})")
        print(f"({time.perf_counter() - t0:.1f}s)")

    if args.stage in ("all", "mask"):
        print("\n=== [mask] placeholder 생존율 (지시 없음) ===")
        print("마스크".ljust(8) + "생존".rjust(8) + "  실패 예시")
        for shape in MASK_SHAPES:
            ok, fail = 0, ""
            for c in MASK_CARRIERS:
                text = c.replace("{M}", shape)
                out = translate("kr", "en", text)
                if out.count(shape) == 1:
                    ok += 1
                elif not fail:
                    fail = f"'{text}' → '{out}'"
            print(shape.ljust(8) + f"{ok}/{len(MASK_CARRIERS)}".rjust(8) + "  " + fail[:60])

        print("\n--- 숫자 마스크 심화 ---")
        ok_total = 0
        for src, tgt, text, masks, note in DIGIT_CASES:
            out = translate(src, tgt, text)
            ok = all(out.count(m) == 1 for m in masks)
            ok_total += ok
            print(f"{'✅' if ok else '❌'} [{src}→{tgt}] {text}")
            print(f"     → {out}   ({note})")
        print(f"\n숫자 심화 생존: {ok_total}/{len(DIGIT_CASES)}")


if __name__ == "__main__":
    main()
