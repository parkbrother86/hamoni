#!/usr/bin/env python3
"""트랙 B 품질 하네스 — llama-server `/completion` 경유 (인프로세스 대안).

`quality_llm.py` 는 llama-cpp-python 으로 GGUF 를 인프로세스 적재한다. 그 경로가
막히는 환경이 있어서(§함정 4: PyPI wheel 이 CPU 런타임 디스패치 없이 빌드돼
컨텍스트 생성에서 illegal instruction) 공식 llama.cpp 바이너리의 llama-server 를
띄우고 HTTP 로 같은 케이스를 돌린다. 케이스는 `bench_mt.py` 공유 — 트랙 A/B 및
모델 간 직접 비교가 유지된다.

왜 `/v1/chat/completions` 가 아니라 `/completion` 인가: TranslateGemma 의 chat
template 은 구조화 content(source_lang_code/target_lang_code)를 강제해서 범용
클라이언트가 못 붙고, llama-server 는 기동 시 그 템플릿 파싱에 실패한다
(`--no-jinja` 필요). 그래서 프롬프트를 직접 렌더해 raw completion 으로 보낸다.

    # 서버 (공식 llama.cpp 바이너리)
    llama-server -m <gguf> -ngl 99 -c 2048 --no-jinja --host 127.0.0.1 --port 8080
    # 측정
    python quality_http.py --style gemma
"""

import argparse
import json
import sys
import time
import urllib.request

from bench_mt import QUALITY_CASES

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TAG = {"kr": "ko", "en": "en", "jp": "ja", "cn": "zh"}
NAME = {"ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese"}
# 모델별 정지 토큰 — 없으면 다음 턴까지 계속 생성한다.
STOPS = {
    "gemma": ["<end_of_turn>", "<start_of_turn>"],
    "tri": ["<|im_end|>", "<|im_start|>"],
}


def render(style, src, tgt, text):
    """GGUF 의 chat_template 을 손으로 재현 (add_generation_prompt=True)."""
    sc, tc = TAG[src], TAG[tgt]
    sl, tl = NAME[sc], NAME[tc]
    if style == "gemma":
        return (
            f"<start_of_turn>user\n"
            f"You are a professional {sl} ({sc}) to {tl} ({tc}) translator. "
            f"Your goal is to accurately convey the meaning and nuances of the "
            f"original {sl} text while adhering to {tl} grammar, vocabulary, and "
            f"cultural sensitivities.\n"
            f"Produce only the {tl} translation, without any additional explanations "
            f"or commentary. Please translate the following {sl} text into {tl}:\n\n\n"
            f"{text.strip()}<end_of_turn>\n"
            f"<start_of_turn>model\n"
        )
    if style == "tri":
        return (
            f"<|im_start|>user\n"
            f"Translate the following {sl} text into {tl}:\n{text} <{tc}><|im_end|>\n"
            f"<|im_start|>assistant\n"
        )
    raise SystemExit(f"unknown style {style}")


def call(url, style, prompt, timeout):
    body = json.dumps({
        "prompt": prompt,
        "n_predict": 128,
        "temperature": 0,
        "stop": STOPS[style],
        "cache_prompt": True,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/completion", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["content"].strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--style", default="gemma", choices=list(STOPS))
    ap.add_argument("--timeout", type=float, default=300)
    args = ap.parse_args()

    print(f"=== quality · style={args.style} · {len(QUALITY_CASES)}케이스 ===\n")
    lat = []
    t0 = time.perf_counter()
    for src, tgt, text, ref, note in QUALITY_CASES:
        t = time.perf_counter()
        try:
            out = call(args.url, args.style, render(args.style, src, tgt, text), args.timeout)
        except Exception as e:
            out = f"<ERROR {type(e).__name__}: {e}>"
        dt = (time.perf_counter() - t) * 1000
        lat.append(dt)
        print(f"[{src}→{tgt}] {text}")
        print(f"    MT : {out}")
        print(f"    ref: {ref}   ({note})  [{dt:.0f}ms]")
    lat.sort()
    print(f"\n총 {time.perf_counter() - t0:.1f}s · p50 {lat[len(lat) // 2]:.0f}ms · "
          f"p95 {lat[int(len(lat) * 0.95)]:.0f}ms")


if __name__ == "__main__":
    main()
