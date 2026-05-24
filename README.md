# Hamoni

Real-time Discord chat translation relay between Korean / English / Japanese / Chinese channels. LLM-powered, latency-optimized, MMORPG-tuned.

실시간 디스코드 다국어 채팅 릴레이 봇 — 한/영/일/중 채널을 자동 번역으로 연결합니다.

---

## 주요 기능

- 4개 언어 채널 (KR/EN/JP/CN) 간 메시지 자동 번역 및 릴레이
- 병렬 호출 + LRU 캐시로 latency 최적화
- 메시지 수정/삭제 동기화, 답글 컨텍스트 보존, 첨부파일 전달
- 멘션 / 커스텀 이모지 / Discord 마크다운 보존
- 사용자별 rate limit
- `/stats` 슬래시 커맨드 (p50/p95/p99 latency, 캐시 hit rate, 언어쌍별 breakdown)
- 영속 metrics 로그 (JSONL 일별 rotation)

---

# 1. Discord 봇 세팅

## 1.1 봇 생성

1. [Discord Developer Portal](https://discord.com/developers/applications) 접속
2. **New Application** → 이름 입력 (예: `Hamoni`) → Create
3. 좌측 메뉴 **Bot** → **Reset Token** 클릭 → **토큰을 복사해서 안전한 곳에 저장** (한 번만 보임)
4. 같은 **Bot** 페이지 하단에서 **Privileged Gateway Intents** 섹션:
   - ✅ **MESSAGE CONTENT INTENT** 켜기 (필수)
   - 나머지는 꺼둬도 됨

## 1.2 서버에 초대

1. 좌측 **OAuth2** → **URL Generator**
2. **SCOPES**: ✅ `bot` ✅ `applications.commands`
3. **BOT PERMISSIONS**:
   - ✅ View Channels
   - ✅ Send Messages
   - ✅ Embed Links
   - ✅ Read Message History
   - ✅ Manage Webhooks
   - ✅ Use Application Commands
4. 생성된 URL을 브라우저에 붙여넣기 → 봇을 추가할 서버 선택 → 권한 확인 후 **인증**

## 1.3 채널 만들기 & ID 복사

1. Discord에서 4개 채널 생성 (예: `#chat-kr`, `#chat-en`, `#chat-jp`, `#chat-cn`)
2. 사용자 **설정 → 고급 → 개발자 모드** 켜기
3. 각 채널 **우클릭 → ID 복사** → 4개 ID 메모 (다음 단계에서 사용)

---

# 2. Linux 서버 설치

Ubuntu 22.04 / 24.04 기준. 다른 배포판은 패키지 매니저만 바꾸면 동일.

## 2.1 OS 업데이트 & Node.js 설치

```bash
# OS 업데이트
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS 설치 (NodeSource 공식 스크립트)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 확인
node --version   # v20.x.x
npm --version
```

## 2.2 pm2 설치

```bash
sudo npm install -g pm2
pm2 --version
```

## 2.3 Hamoni 클론 & 설치

```bash
git clone https://github.com/parkbrother86/hamoni.git
cd hamoni
npm install
```

## 2.4 환경변수 설정

`.env` 파일 생성:

```bash
nano .env
```

내용:

```env
DISCORD_TOKEN=1.1단계에서_복사한_봇_토큰
DEEPSEEK_API_KEY=deepseek_플랫폼에서_발급받은_API_키
```

DeepSeek API 키는 https://platform.deepseek.com 에서 발급.

## 2.5 채널 ID 설정

`config.js` 편집:

```bash
nano config.js
```

상단 `CHANNELS`를 1.3단계에서 복사한 ID로 교체:

```js
const CHANNELS = {
  kr: '여기에_KR_채널_ID',
  en: '여기에_EN_채널_ID',
  jp: '여기에_JP_채널_ID',
  cn: '여기에_CN_채널_ID',
};
```

## 2.6 실행 (pm2)

```bash
# 시작
pm2 start index.js --name hamoni

# 로그 확인 (정상 기동 확인)
pm2 logs hamoni

# 로그에서 봐야 할 것:
# Logged in as <봇이름>#XXXX
# kr: #chat-kr <채널ID>
# en: #chat-en <채널ID>
# jp: #chat-jp <채널ID>
# cn: #chat-cn <채널ID>
# Slash commands registered on guild ...: /stats
```

## 2.7 부팅 시 자동 시작

```bash
pm2 save
pm2 startup
# 출력되는 마지막 sudo 명령어를 복사해서 실행
```

## 코드 업데이트 시

```bash
cd hamoni
git pull
npm install   # 의존성 변경 있을 수 있음
pm2 restart hamoni
pm2 logs hamoni --lines 50
```

---

# 3. 봇 사용 방법

## 3.1 자동 동작 (설정 불필요)

봇이 켜져있으면 4개 채널 중 어디에 메시지를 올려도 **나머지 3개 채널로 자동 번역되어 전달**됩니다. webhook이 원본 사용자의 이름/아바타를 흉내내서 마치 그 사람이 직접 쓴 것처럼 표시됩니다.

```
원본 (#chat-kr):  alice: 이번 주말 레이드 가능?
              ↓ 자동 번역
#chat-en:  [KR] alice: Can you join the raid this weekend? [⤴]
#chat-jp:  [KR] alice: 今週末のレイド参加可能? [⤴]
#chat-cn:  [KR] alice: 这周末能参加团本吗? [⤴]
```

메시지 끝의 `[⤴]`는 원본 메시지로 점프하는 클릭 가능한 링크입니다.

## 3.2 자동으로 처리되는 것들

| 동작 | 설명 |
|---|---|
| **번역 캐시** | 같은 메시지가 반복되면 (`ㅋㅋ`, `GG`, `AFK` 등) API 호출 없이 즉시 응답 |
| **API 스킵** | 이모지만 / URL만 / 숫자만 있는 메시지는 번역 없이 원문 그대로 전달 |
| **같은 언어 감지** | KR 채널에 영어로 쓰면 EN 채널엔 그대로 보냄 (API 절약) |
| **멘션 보존** | `<@사용자ID>` 가 `@닉네임`으로 표시 (ping은 안 감), 클릭하면 실제 사용자 프로필 |
| **커스텀 이모지** | `<:이모지:ID>` 가 다른 채널에서도 그대로 렌더 (같은 서버 한정) |
| **마크다운** | `**굵게**`, `||스포일러||`, ```` ```코드``` ```` 등 그대로 보존 |
| **첨부파일** | 이미지/파일/비디오 자동 전달 (텍스트 없이 첨부만 있어도 OK) |
| **긴 메시지** | 300자 초과 시 원문 + "메시지가 너무 길어 번역되지 않았습니다" 안내문으로 전달 |
| **수정 동기화** | 원본 수정 시 모든 채널의 번역본도 재번역되어 수정됨 |
| **삭제 동기화** | 원본 삭제 시 모든 채널의 번역본도 같이 삭제됨 |
| **답글** | Discord 답글 사용 시 다른 채널에서도 `> 인용` prefix로 컨텍스트 전달 |
| **rate limit** | 한 사용자가 5건 이상 동시 처리 중이면 추가 메시지는 드롭 (도배 방지) |

## 3.3 슬래시 커맨드

### `/stats`

봇의 동작 통계를 본인만 볼 수 있게 (ephemeral) 표시:

```
번역 봇 통계

현재 세션
  가동 2d 14h 32m · rate limit drops 0
  edits 5 · deletes 2

최근 1시간
  콜수 234 · hit rate 38.1% · errors 1
  p50 680ms · p95 1.42s · p99 2.10s · avg 752ms

최근 24시간
  콜수 5891 · hit rate 41.3% · errors 8
  p50 720ms · p95 1.51s · p99 2.34s · avg 810ms

언어쌍별 p95 (24h, 느린 순)
  kr→jp p95 1.62s (n=1430)
  kr→en p95 1.45s (n=1622)
  kr→cn p95 1.22s (n=1411)
  ...
```

- `p50/p95/p99`: 응답 latency 분포. p95가 1.5초면 "95%의 응답이 1.5초 안에 도착"
- `hit rate`: 캐시 적중률. 높을수록 빠름
- `errors`: API 호출 실패 수
- 슬래시 커맨드가 안 보이면: 봇 재시작 후 1분 대기, 또는 봇 권한에 `Use Application Commands` 확인

## 3.4 데이터 저장 위치

봇이 실행되면 `data/` 디렉토리에 일별 metrics 로그가 쌓입니다.

```
data/
├── metrics-2026-05-23.jsonl
├── metrics-2026-05-24.jsonl
└── ...
```

각 줄은 한 번의 API 호출 또는 캐시 hit 이벤트:

```jsonl
{"t":1779565200000,"src":"kr","tgt":"en","ms":823,"hit":0}
{"t":1779565200500,"src":"kr","tgt":"jp","hit":1}
{"t":1779565201200,"src":"kr","tgt":"cn","ms":1102,"hit":0,"err":1}
```

`/stats`는 최근 24시간만 보여주지만, raw 데이터는 디스크에 영구 저장되므로 나중에 분석 가능:

```bash
# 평균 latency 계산
cat data/*.jsonl | jq -s '[.[] | select(.hit==0 and .ms) | .ms] | add/length'

# 특정 언어쌍만 추출
cat data/*.jsonl | jq -c 'select(.src=="kr" and .tgt=="jp")'

# 에러만 보기
cat data/*.jsonl | jq -c 'select(.err==1)'
```

## 3.5 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| 봇이 메시지를 못 받음 | Developer Portal에서 **MESSAGE CONTENT INTENT** 켜졌는지 확인 |
| 슬래시 커맨드가 안 보임 | 봇 권한에 `Use Application Commands`, 봇 재시작 후 1~2분 대기 |
| 번역이 안 됨 (다른 채널에 메시지 안 옴) | `pm2 logs hamoni`로 에러 확인. `DEEPSEEK_API_KEY` 또는 webhook 권한 (`Manage Webhooks`) 확인 |
| 이모지/멘션이 깨짐 | 같은 서버 내에서만 커스텀 이모지가 렌더됨. 다른 서버 이모지는 텍스트로 표시 |
| 메시지 수정 시 다른 채널 동기화 안 됨 | 봇 시작 이전에 보낸 메시지는 in-memory store에 없어서 동기화 안 됨. 정상 동작 |
| pm2 재시작 후 metrics 날아감 | 영속 데이터는 `data/*.jsonl`에 있음. `/stats`의 "현재 세션" 항목만 초기화됨 |

## 3.6 비-MMORPG 용도로 쓰려면

[`translator.js`](translator.js)의 시스템 프롬프트가 MMORPG 채팅용으로 튜닝되어 있어요 (GG / AFK / DPS 같은 게이밍 슬랭 보존, 캐주얼 톤). 다른 도메인에 쓰려면:

- `translateText` 함수의 `system` 메시지를 도메인에 맞게 수정
- [`config.js`](config.js)의 `MAX_MESSAGE_LENGTH` 조정 (긴 메시지가 많다면)
- 다른 언어를 추가하려면 `CHANNELS`, `LANG_LABEL`, `LANG_NATIVE`, `LANG_RULE`, `SOURCE_LANG_FLAG` 전부 새 언어 키 추가

---

## Architecture

```
index.js          Entry point (Discord client, event wiring)
config.js         Channel IDs, language constants
text.js           Sanitize, normalize, mention/emoji preprocessing
translator.js     DeepSeek API + LRU cache
webhook.js        Webhook lookup/create with caching
store.js          In-memory relay ID mapping (for edit/delete sync)
relay.js          Message handler orchestration
stats.js          In-memory session counters
metrics.js        Persistent JSONL metrics log
commands.js       /stats slash command
```

## License

MIT — see [LICENSE](LICENSE).
