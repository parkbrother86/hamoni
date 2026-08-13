#!/usr/bin/env python3
"""GGUF 를 OpenAI 호환 서버로 띄운다 (flood.py 부하 대상).

    python serve_gguf.py --model tri --port 8000
    python serve_gguf.py --gguf ./x.gguf --port 8000

Windows 에서 pip NVIDIA 런타임 DLL 경로를 먼저 잡아준다 (cuda_path).

⚠️ 서빙 스택별 동시성 한계가 다르다 — 측정값을 해석할 때 반드시 고려할 것:
  llama-cpp-python server : 모델 락으로 요청을 **직렬 처리**하는 경향.
                            → 동시성을 올려도 처리량이 안 늘면 이게 원인.
  llama.cpp 네이티브 llama-server : `-np N` 슬롯으로 진짜 동시 처리.
  vLLM (Linux)            : continuous batching. 동시성 확장이 가장 좋다.
"""

import argparse
import sys

import cuda_path  # noqa: F401  (llama_cpp 보다 먼저)

CATALOG = {
    "tri": ("mradermacher/Tri-1.8B-Translation-GGUF", "Tri-1.8B-Translation.Q4_K_M.gguf"),
    "gemma": ("mradermacher/translategemma-4b-it-GGUF", "translategemma-4b-it.Q4_K_M.gguf"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="tri", choices=list(CATALOG))
    ap.add_argument("--gguf", help="로컬 GGUF 경로 (카탈로그 대신)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--n-gpu-layers", type=int, default=-1)
    ap.add_argument("--ctx", type=int, default=1024)
    args = ap.parse_args()

    path = args.gguf
    if not path:
        from huggingface_hub import hf_hub_download

        repo, fname = CATALOG[args.model]
        print(f"[모델] {repo} / {fname}")
        path = hf_hub_download(repo, fname)

    from llama_cpp.server.app import create_app
    from llama_cpp.server.settings import ServerSettings, ModelSettings
    import uvicorn

    model_settings = [
        ModelSettings(
            model=path,
            model_alias=args.model,
            n_gpu_layers=args.n_gpu_layers,
            n_ctx=args.ctx,
            verbose=False,
        )
    ]
    app = create_app(
        server_settings=ServerSettings(host=args.host, port=args.port),
        model_settings=model_settings,
    )
    print(f"[서버] http://{args.host}:{args.port}/v1  (alias={args.model})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
