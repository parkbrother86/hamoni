#!/usr/bin/env python3
"""단건 요청 flood 하네스 — "1건씩 계속 밀어넣을 때 얼마나 버티나".

클라이언트 배치를 쓰지 않는다. 짧은 번역 요청을 **개별 HTTP 호출**로 동시에
쏟아부어, 서버(vLLM / llama.cpp)의 실제 서빙 한계를 잰다. 실 운영 형태가
이것이다 — 메시지는 제각기 도착하고, fan-out 3 도 동시 3발이지 배치 1개가 아니다.

    # 동시성 램프 (기본) — 최대 처리량과 포화점을 찾는다
    python flood.py --url http://localhost:8000/v1 --model tri --prompt-style tri

    # 특정 동시성으로 지속 (안정성 확인)
    python flood.py --mode sustain --concurrency 32 --duration 60 ...

    # open-loop DDoS — 처리 능력과 무관하게 초당 N발 계속 밀어넣기
    python flood.py --mode open --rps 100 --duration 30 ...

두 모드의 의미가 다르다:
  closed-loop(ramp/sustain) = 동시 접속자 C명이 쉬지 않고 요청 → **처리량 상한**
  open-loop(open)           = 도착률 고정, 서버가 못 따라가면 큐 폭발 → **한계 도착률**
"""

import argparse
import asyncio
import json
import statistics
import sys
import time

try:
    import httpx
except ImportError:
    sys.exit("pip install httpx  (또는 pip install -r requirements.txt)")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# 짧은 게임챗 — 실제 워크로드 형태 (20자 내외)
LINES = [
    "보스 리젠 10분 남았어", "탱커 구해요", "물약 남은 사람?", "사냥터 어디가 좋아?",
    "길드전 몇 시야?", "그 아이템 얼마에 팔아?", "파티 자리 있어?", "레벨 몇 찍었어?",
    "퀘스트 같이 할 사람", "지금 접속한 사람 몇 명?", "무기 강화 실패했어", "이번 패치 어때?",
    "던전 입장 조건이 뭐야?", "힐러 없으면 못 가", "경험치 이벤트 언제까지야?", "그 보스 패턴 알려줘",
    "장비 세팅 좀 봐줘", "막공 모집합니다", "거래 사기 조심해", "신규 맵 가봤어?",
    "스킬 트리 뭐가 좋아?", "결투장 같이 가자", "골드 시세 올랐네", "서버 점검 언제 끝나?",
]

LANG_NAME = {"kr": "Korean", "en": "English", "jp": "Japanese", "cn": "Chinese"}
TRI_TAG = {"kr": "ko", "en": "en", "jp": "ja", "cn": "zh"}


def build_payload(args, text, idx, tgt=None):
    """모델별 프롬프트 어댑터. 번역 전용 모델은 각자 고유 형식을 쓴다.

    ⚠️ chat template 이 있는 모델(Tri-1.8B 등)에 raw /completions 를 쓰면 EOS 가
    안 걸려 max_tokens 를 끝까지 소모하며 반복 출력한다 — latency 가 몇 배로
    부풀어 측정이 무의미해진다. 기본값을 chat 으로 두고 `--api` 로만 바꾼다.
    (2026-08-14 실측: raw 3.3 msg/s vs chat 20+ msg/s)
    """
    src = args.src
    tgt = tgt or args.tgt
    common = {"model": args.model, "max_tokens": args.max_tokens, "temperature": 0}

    if args.prompt_style == "tri":
        # trillionlabs/Tri-1.8B-Translation 모델 카드 형식
        prompt = (
            f"Translate the following {LANG_NAME[src]} text into {LANG_NAME[tgt]}:\n"
            f"{text} <{TRI_TAG[tgt]}>"
        )
    elif args.prompt_style == "gemma":
        # TranslateGemma: 타겟 언어 태그 접두
        prompt = f"<2{TRI_TAG[tgt]}> {text}"
    else:  # generic chat
        prompt = None

    if prompt is None:
        return "/chat/completions", {
            **common,
            "messages": [
                {"role": "system", "content": f"Translate the user message into {LANG_NAME[tgt]}. Output only the translation."},
                {"role": "user", "content": text},
            ],
        }

    if args.api == "completions":
        return "/completions", {**common, "prompt": prompt}
    return "/chat/completions", {**common, "messages": [{"role": "user", "content": prompt}]}


METRIC_KEYS = {
    "run": "vllm:num_requests_running",
    "wait": "vllm:num_requests_waiting",
    "kv": "vllm:gpu_cache_usage_perc",
    "preempt": "vllm:num_preemptions_total",
}


async def scrape_metrics(client, metrics_url):
    """vLLM Prometheus 지표 1회 수집. 서버가 아니면 None."""
    try:
        r = await client.get(metrics_url, timeout=3.0)
        if r.status_code != 200:
            return None
        vals = {}
        for line in r.text.splitlines():
            if line.startswith("#"):
                continue
            for short, key in METRIC_KEYS.items():
                if line.startswith(key + "{"):
                    try:
                        vals[short] = float(line.rsplit(" ", 1)[1])
                    except (ValueError, IndexError):
                        pass
        return vals or None
    except Exception:
        return None


class MetricSampler:
    """부하 중 서버 내부 상태를 1초 간격으로 표본 수집.

    클라이언트 관측(in-flight)과 서버 관측(running/waiting)을 분리해서 봐야
    한다 — 둘이 벌어지면 병목이 네트워크/클라이언트 쪽이라는 신호다.
    """

    def __init__(self, client, metrics_url, gpu_cmd=None):
        self.client, self.url, self.gpu_cmd = client, metrics_url, gpu_cmd
        self.samples, self._task, self._stop = [], None, False
        self.preempt_start = None

    async def _loop(self):
        while not self._stop:
            m = await scrape_metrics(self.client, self.url)
            if m:
                if self.preempt_start is None:
                    self.preempt_start = m.get("preempt", 0.0)
                if self.gpu_cmd:
                    m["gpu"] = await sample_gpu(self.gpu_cmd)
                self.samples.append(m)
            await asyncio.sleep(1.0)

    def start(self):
        self._stop = False
        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        self._stop = True
        if self._task:
            await asyncio.gather(self._task, return_exceptions=True)

    def summary(self):
        if not self.samples:
            return None
        # gpu 표본은 실패 시 None 이 들어올 수 있다
        f = lambda k: [s[k] for s in self.samples if s.get(k) is not None]
        out = {}
        for k in ("run", "wait", "kv", "gpu"):
            v = f(k)
            if v:
                out[k + "_avg"], out[k + "_max"] = sum(v) / len(v), max(v)
        pre = f("preempt")
        if pre and self.preempt_start is not None:
            out["preempt"] = pre[-1] - self.preempt_start
        return out


async def sample_gpu(cmd):
    """nvidia-smi 로 GPU 사용률(%) 1회 표본."""
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        so, _ = await proc.communicate()
        return float(so.decode().strip().split("\n")[0].replace("%", "").strip())
    except Exception:
        return None


def fmt_metrics(m):
    if not m:
        return ""
    parts = []
    if "run_avg" in m:
        parts.append(f"running {m['run_avg']:.0f}/{m['run_max']:.0f}")
    if "wait_avg" in m:
        parts.append(f"queue {m['wait_avg']:.0f}/{m['wait_max']:.0f}")
    if "kv_avg" in m:
        parts.append(f"KV {m['kv_avg']*100:.1f}%/{m['kv_max']*100:.1f}%")
    if "gpu_avg" in m:
        parts.append(f"GPU {m['gpu_avg']:.0f}%")
    if m.get("preempt") is not None:
        parts.append(f"preempt {m['preempt']:.0f}")
    return "    서버: " + " | ".join(parts) + "  (평균/최대)"


async def one_request(client, args, idx, out, tgt=None):
    text = LINES[idx % len(LINES)]
    path, payload = build_payload(args, text, idx, tgt)
    t0 = time.perf_counter()
    try:
        r = await client.post(args.url.rstrip("/") + path, json=payload)
        ms = (time.perf_counter() - t0) * 1000
        if r.status_code != 200:
            out.append({"ok": False, "ms": ms, "err": f"HTTP {r.status_code}"})
            return
        body = r.json()
        ch = body["choices"][0]
        content = ch.get("text") or ch.get("message", {}).get("content", "")
        out.append({"ok": True, "ms": ms, "out": (content or "").strip()})
    except Exception as e:
        out.append({"ok": False, "ms": (time.perf_counter() - t0) * 1000, "err": type(e).__name__})


def report(results, wall_s, label):
    ok = [r for r in results if r["ok"]]
    errs = [r for r in results if not r["ok"]]
    if not ok:
        kinds = {}
        for e in errs:
            kinds[e["err"]] = kinds.get(e["err"], 0) + 1
        print(f"{label}  전부 실패: {kinds}")
        return None
    lat = sorted(r["ms"] for r in ok)
    p = lambda q: lat[min(len(lat) - 1, int(len(lat) * q))]
    tps = len(ok) / wall_s
    err_rate = len(errs) / len(results) if results else 0
    print(
        f"{label}  처리량 {tps:7.1f}/s | p50 {statistics.median(lat):6.0f}ms "
        f"| p95 {p(0.95):6.0f}ms | p99 {p(0.99):6.0f}ms | err {err_rate * 100:4.1f}% ({len(ok)}건)"
    )
    return {"tps": tps, "p50": statistics.median(lat), "p95": p(0.95), "err": err_rate}


async def closed_loop(client, args, concurrency, duration, start_idx):
    """동시 C건을 항상 유지 — 하나 끝나면 즉시 다음 발사. 처리량 상한 측정.

    --fanout 지정 시 '1건'의 단위가 **입력 채팅**이 된다: 채팅 하나가 N개
    타겟으로 동시 번역되고, **N개가 전부 끝나야** 그 채팅이 완료된다(실제
    릴레이 형태). 이 경우 concurrency = 동시 채팅 수이고 실제 API 요청은
    그 N배가 된다.
    """
    results, counter, deadline = [], start_idx, time.perf_counter() + duration
    targets = args.fanout.split(",") if args.fanout else None
    chats_done = 0

    async def worker():
        nonlocal counter, chats_done
        while time.perf_counter() < deadline:
            i, counter = counter, counter + 1
            if targets:
                # 한 채팅 = N개 타겟 동시 발사, 전부 끝나야 완료
                await asyncio.gather(*[
                    one_request(client, args, i, results, tgt=t) for t in targets
                ])
                chats_done += 1
            else:
                await one_request(client, args, i, results)

    t0 = time.perf_counter()
    await asyncio.gather(*[worker() for _ in range(concurrency)])
    wall = time.perf_counter() - t0
    return results, wall, chats_done


async def open_loop(client, args, rps, duration):
    """도착률 고정, 백프레셔 없음 — 서버가 못 따라가도 계속 발사(DDoS)."""
    results, tasks = [], []
    interval = 1.0 / rps
    t0 = time.perf_counter()
    inflight_peak = 0
    i = 0
    while (time.perf_counter() - t0) < duration:
        target = t0 + i * interval
        now = time.perf_counter()
        if target > now:
            await asyncio.sleep(target - now)
        tasks.append(asyncio.create_task(one_request(client, args, i, results)))
        i += 1
        alive = sum(1 for t in tasks if not t.done())
        inflight_peak = max(inflight_peak, alive)
        if len(tasks) > 20000:
            tasks = [t for t in tasks if not t.done()]

    issued = i
    drain0 = time.perf_counter()
    await asyncio.gather(*tasks, return_exceptions=True)
    drain = time.perf_counter() - drain0
    return results, time.perf_counter() - t0, issued, inflight_peak, drain


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000/v1", help="OpenAI 호환 엔드포인트")
    ap.add_argument("--model", required=True)
    ap.add_argument("--prompt-style", default="tri", choices=["tri", "gemma", "chat"])
    ap.add_argument("--api", default="chat", choices=["chat", "completions"],
                    help="chat 권장 — chat template 모델에 raw completions 를 쓰면 반복 출력으로 latency 왜곡")
    ap.add_argument("--mode", default="ramp", choices=["ramp", "sustain", "open", "sweep"])
    ap.add_argument("--rates", default="100,110,120,130,140,150",
                    help="sweep 모드: 측정할 도착률 목록 (쉼표 구분)")
    ap.add_argument("--metrics-url", help="vLLM /metrics (기본: --url 에서 자동 유도)")
    ap.add_argument("--no-metrics", action="store_true", help="서버 지표 수집 끄기")
    ap.add_argument("--gpu-cmd",
                    default='wsl -d Ubuntu -e nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader',
                    help="GPU 사용률 표본 명령 (빈 문자열이면 비활성)")
    ap.add_argument("--concurrency", type=int, default=32, help="sustain 모드 동시성")
    ap.add_argument("--rps", type=int, default=100, help="open 모드 초당 발사수")
    ap.add_argument("--duration", type=int, default=15, help="단계별 지속 시간(초)")
    ap.add_argument("--max-concurrency", type=int, default=256, help="ramp 상한")
    ap.add_argument("--src", default="kr", choices=list(LANG_NAME))
    ap.add_argument("--tgt", default="en", choices=list(LANG_NAME))
    ap.add_argument("--fanout", help="예: en,jp,cn — 채팅 1건을 이 타겟들로 동시 번역하고 "
                                     "전부 끝나야 완료로 센다. concurrency 단위가 '동시 채팅'이 된다")
    ap.add_argument("--max-tokens", type=int, default=64)
    ap.add_argument("--break-p95", type=float, default=1500, help="SLA — 이 p95(ms) 넘으면 중단")
    ap.add_argument("--break-err", type=float, default=0.05)
    args = ap.parse_args()

    metrics_url = args.metrics_url
    if not metrics_url and not args.no_metrics:
        base = args.url.rstrip("/")
        metrics_url = base[: -len("/v1")] + "/metrics" if base.endswith("/v1") else base + "/metrics"

    conn_cap = max(args.max_concurrency, args.rps * 4, 512)
    limits = httpx.Limits(max_connections=conn_cap, max_keepalive_connections=conn_cap)
    async with httpx.AsyncClient(timeout=120.0, limits=limits) as client:
        # 워밍업 (모델 로드/컴파일 제외)
        warm = []
        await asyncio.gather(*[one_request(client, args, i, warm) for i in range(4)])
        ok_warm = [w for w in warm if w["ok"]]
        if not ok_warm:
            print("워밍업 실패 — 서버/모델/프롬프트 형식 확인:", warm[:2])
            return
        print(f"[워밍업] OK · 예시 출력: {ok_warm[0]['out'][:60]!r}")
        print(f"[설정] {args.src}→{args.tgt} · style={args.prompt_style} · {args.mode} 모드\n")

        if args.mode == "ramp":
            print("동시성 램프 (closed-loop: 동시 C건 항상 유지)")
            print("SLA 이탈(p95 > %.0fms) 또는 에러율 %.0f%% 초과 시 중단\n" % (args.break_p95, args.break_err * 100))
            best, idx, c = None, 0, 1
            while c <= args.max_concurrency:
                res, wall, chats = await closed_loop(client, args, c, args.duration, idx)
                idx += len(res)
                label = f"  동시채팅 {c:>4}" if args.fanout else f"  동시 {c:>4}"
                s = report(res, wall, label)
                if s is None:
                    break
                if args.fanout:
                    n = len(args.fanout.split(","))
                    s["chat_tps"] = chats / wall
                    print(f"    → 입력 채팅 {s['chat_tps']:.1f}/s (fan-out {n} = API {s['tps']:.1f}/s)")
                if s["p95"] > args.break_p95 or s["err"] > args.break_err:
                    print(f"\n→ 한계 도달 (동시 {c}). SLA 내 최대: {best}")
                    break
                best = {"concurrency": c, **{k: round(v, 1) for k, v in s.items()}}
                c *= 2
            else:
                print(f"\n→ 상한({args.max_concurrency})까지 SLA 유지. 최대: {best}")
            if best:
                print(
                    f"\n★ SLA 내 최대 단건 처리량: {best['tps']:.1f} msg/s "
                    f"(동시 {best['concurrency']}, p95 {best['p95']:.0f}ms)"
                )

        elif args.mode == "sustain":
            print(f"지속 부하 (동시 {args.concurrency}, {args.duration}초)")
            res, wall, chats = await closed_loop(client, args, args.concurrency, args.duration, 0)
            s0 = report(res, wall, f"  동시 {args.concurrency:>4}")
            if args.fanout and s0:
                print(f"    → 입력 채팅 {chats / wall:.1f}/s (fan-out {len(args.fanout.split(','))})")
            half = len(res) // 2
            if half > 10:
                # 전반/후반 비교 — 시간에 따른 열화 감지
                report(res[:half], wall / 2, "  전반부  ")
                report(res[half:], wall / 2, "  후반부  ")
                print("  (후반부 p95 가 크게 높으면 큐 적체 = 그 부하는 지속 불가)")

        elif args.mode == "open":
            print(f"open-loop DDoS ({args.rps}/s 를 {args.duration}초간, 백프레셔 없음)")
            sampler = None
            if metrics_url:
                sampler = MetricSampler(client, metrics_url, args.gpu_cmd or None)
                sampler.start()
            res, wall, issued, peak, drain = await open_loop(client, args, args.rps, args.duration)
            if sampler:
                await sampler.stop()
            s = report(res, wall, f"  발사 {args.rps:>4}/s")
            print(f"  발사 {issued}건 · 최대 동시 in-flight {peak} · 드레인 {drain:.1f}s")
            if sampler:
                print(fmt_metrics(sampler.summary()))
            if s:
                if s["tps"] < args.rps * 0.9:
                    print(f"  ⚠️ 도착률({args.rps}/s) > 처리율({s['tps']:.1f}/s) — 큐 적체. 이 부하는 지속 불가")
                else:
                    print(f"  ✅ 도착률 소화 중 (처리율 {s['tps']:.1f}/s)")

        else:  # sweep — knee point 탐색
            rates = [int(r) for r in args.rates.split(",") if r.strip()]
            print(f"open-loop sweep — 도착률 {rates} 각 {args.duration}초")
            print("knee point(처리율이 도착률을 못 따라가기 시작하는 지점) 바로 아래가 운영점\n")
            rows = []
            for rate in rates:
                sampler = None
                if metrics_url:
                    sampler = MetricSampler(client, metrics_url, args.gpu_cmd or None)
                    sampler.start()
                res, wall, issued, peak, drain = await open_loop(client, args, rate, args.duration)
                if sampler:
                    await sampler.stop()
                s = report(res, wall, f"  도착 {rate:>4}/s")
                if s is None:
                    break
                m = sampler.summary() if sampler else None
                print(f"    클라: in-flight 최대 {peak} · 드레인 {drain:.1f}s")
                if m:
                    print(fmt_metrics(m))
                rows.append({"rate": rate, "peak": peak, "drain": drain, **s, **(m or {})})
                # 큐가 남은 상태로 다음 단계 들어가면 오염된다 — 잠깐 식힌다
                await asyncio.sleep(5)

            print("\n" + "=" * 78)
            print("도착률".rjust(7) + "처리율".rjust(9) + "달성률".rjust(8) + "p50".rjust(8)
                  + "p95".rjust(9) + "큐(최대)".rjust(10) + "KV%".rjust(7) + "preempt".rjust(9))
            knee = None
            for r in rows:
                ratio = r["tps"] / r["rate"]
                if ratio < 0.95 and knee is None:
                    knee = r["rate"]
                print(
                    f"{r['rate']:>7}{r['tps']:>9.1f}{ratio*100:>7.0f}%{r['p50']:>8.0f}{r['p95']:>9.0f}"
                    + f"{r.get('wait_max', 0):>10.0f}{r.get('kv_max', 0)*100:>7.1f}{r.get('preempt', 0):>9.0f}"
                )
            print("=" * 78)
            if knee:
                below = [r["rate"] for r in rows if r["rate"] < knee]
                print(f"\n★ knee point = {knee}/s (달성률 95% 미만 시작)")
                print(f"  → 운영점 권고: {below[-1] if below else '측정 범위 밖'}/s 이하 (admission control 로 제한)")
            else:
                print(f"\n★ 측정 범위({rates[0]}~{rates[-1]}/s) 전체에서 달성률 95%+ — knee 는 그 위에 있다")


if __name__ == "__main__":
    asyncio.run(main())
