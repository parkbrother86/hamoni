# 리팩터링 계획: `index.js` 모듈 분리

## 목표

현재 [index.js](index.js) 단일 파일(270줄)에 모든 로직이 있다. 이후 추가될 기능들 (번역 캐시, edit/delete 동기화, 첨부파일 릴레이, reply 컨텍스트 등)을 고려할 때 단일 파일로는 600~1000줄 규모가 되어 유지보수가 어렵다. 기능 추가 전에 한 번 정리한다.

**원칙**: 이번 작업은 **동작 변화 0**. 순수 파일 분리만 한다. 기능 추가/변경/최적화는 별도 PR로.

## 파일 구조

플랫 구조 (root에 평탄하게). `src/` 디렉터리는 만들지 않는다 (프로젝트 규모상 불필요, `node index.js` 실행 방식 유지).

```
index.js          엔트리: dotenv, Client 생성, 이벤트 wiring, login, clientReady
config.js         상수 (CHANNELS, LANG_*, MAX_MESSAGE_LENGTH)
text.js           sanitizeDiscordText, normalizeTranslatedText
translator.js     deepseek 클라이언트 + translateText (+ 시스템 프롬프트)
webhook.js        webhookCache + getWebhook
relay.js          handleMessage(message) — messageCreate 본문 로직
```

## 모듈별 export 명세

### `config.js`

```js
exports = {
  CHANNELS,              // { kr, en, jp, cn } → channel ID
  LANG_BY_CHANNEL_ID,    // CHANNELS의 역매핑
  LANG_LABEL,            // 영문 언어명 (Korean, English, ...)
  LANG_NATIVE,           // 원어 표기 (한국어, English, ...)
  LANG_RULE,             // 시스템 프롬프트에 들어갈 출력 규칙
  SOURCE_LANG_FLAG,      // 웹훅 이름 prefix용 (KR, EN, JP, ZH)
  MAX_MESSAGE_LENGTH,    // 300
}
```

### `text.js`

```js
exports = {
  sanitizeDiscordText,   // @everyone, 멘션 등 무력화
  normalizeTranslatedText, // trim, 빈 줄 제거, 최대 3줄
}
```

### `webhook.js`

```js
exports = {
  getWebhook,  // (channel) → Webhook. 내부에서 webhookCache 사용.
}
```

### `translator.js`

```js
exports = {
  translateText,  // (text, sourceLang, targetLang) → 번역문
}
```

### `relay.js`

```js
exports = {
  handleMessage,  // (message) → void. messageCreate 핸들러 본문.
}
```

### `index.js` (after)

```js
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { CHANNELS } = require('./config');
const { handleMessage } = require('./relay');

const client = new Client({ intents: [...] });

client.once('clientReady', async () => { /* 채널 로깅 */ });
client.on('messageCreate', handleMessage);

client.login(process.env.DISCORD_TOKEN);
```

## 의존성 그래프

```
index.js   → config, relay
relay.js   → config, text, translator, webhook
translator → config, text
webhook.js → (없음)
text.js    → (없음)
config.js  → (없음)
```

단방향, 순환 없음.

## 짚어둘 설계 결정

### `getWebhook`의 client 의존성

**문제**: 현재 [index.js:104](index.js:104)의 `getWebhook`은 모듈 스코프의 `client`를 직접 참조한다.

```js
let webhook = hooks.find(
  (h) => h.owner?.id === client.user.id
);
```

`webhook.js`로 분리하면 `client`를 어떻게 줄 것인지 결정해야 한다.

**선택지**:
1. 함수 인자로 `client` 받기 → 호출부 매번 client 넘김
2. 모듈 초기화 시 `setClient(client)` 같은 식으로 주입
3. `channel.client.user.id`로 channel 객체에서 역참조

**결정**: **3번 (channel.client 사용)**. discord.js의 모든 구조체에 `.client` back-ref가 존재하므로 가능. `webhook.js`가 외부 상태 의존 없는 순수 유틸이 됨.

## 실행 순서

의존성 낮은 순서로. 각 단계마다 `node -c index.js`로 syntax 확인 가능.

- [x] **1. `config.js` 생성** — 상수 옮김, 의존성 0
- [x] **2. `text.js` 생성** — sanitize/normalize 옮김, 의존성 0
- [x] **3. `webhook.js` 생성** — `channel.client.user.id`로 client 참조 변경
- [x] **4. `translator.js` 생성** — deepseek client + translateText, config/text import
- [x] **5. `relay.js` 생성** — `handleMessage(message)` 함수로 messageCreate 본문 추출
- [x] **6. `index.js` 정리** — require 정리, 이벤트 wiring + login만 남김

## 검증

리팩터링이라 동작이 바뀌면 안 된다.

- **정적 체크**: 각 모듈 `node -e "require('./<mod>.js')"`로 import 가능 확인
- **실행 체크**: `node index.js` 실행 → clientReady에서 4개 채널 로깅 확인 (DISCORD_TOKEN 필요, 사용자 수동)
- **E2E 체크**: 한 채널에 테스트 메시지 보내고 다른 3개 채널에 번역본 도착 확인 (사용자 수동)

## 비범위 (이번 작업에 포함되지 않는 것)

다음 항목들은 이번 PR에 포함하지 않는다. 별도 작업으로 분리.

- 기능 추가 (캐시, edit/delete 동기화, 첨부파일 릴레이, reply 컨텍스트 등)
- 동작 변경 (시스템 프롬프트, max_tokens, temperature, 채널 ID, 모델명 등 전부 그대로 유지)
- `package.json` 생성 (현재 없는 채로 동작 중이라 건드리지 않음)
- webhook 캐시 race condition 수정 (별도 작업)
- 사용자별 rate limit (별도 작업)

## 후속 작업 (완료)

리팩터링 후 한 배치로 모두 구현됨:

- [x] **번역 캐시** — translator.js, LRU max 500, TTL 1h. 동일 메시지(`ㅋㅋ`, `GG` 등) 즉시 응답
- [x] **번역 스킵 조건** — text.js `isTranslatable`. emoji-only / URL-only / number-only는 API 호출 없이 원문 릴레이
- [x] **같은 언어 감지 스킵** — text.js `detectScript`. 한글/카나/한자/Latin 비율로 dominant 스크립트 판정 (>60%, 카나는 20%로 강한 신호). source 언어와 target 일치 시 API 스킵
- [x] **Discord markdown 보존** — translator.js 시스템 프롬프트에 규칙 추가 (`**bold**`, 코드 블록, `> quote`, `||spoiler||` 등)
- [x] **Webhook 캐시 race 수정** — webhook.js, promise 자체를 캐시하여 동시 호출 합류
- [x] **긴 메시지 처리** — 300자 초과 시 silently skip 대신 원문 + `-# 번역 못함` 풋노트를 각 언어로 릴레이
- [x] **첨부파일/이미지 릴레이** — relay.js, `webhook.send({ files })`로 attachment URL 재업로드. 텍스트 없이 첨부만 있어도 릴레이
- [x] **점프 링크** — 번역문 끝에 `-# [↩](discord URL)` subtext. 첨부만 있는 경우는 생략
- [x] **Reply 컨텍스트** — store.js에 snippet 저장 → reply 시 `> snippet` 인용 prefix
- [x] **사용자별 rate limit** — 한 사용자 in-flight 메시지 5건 초과 시 드롭. 로그 남김
- [x] **메시지 edit/delete 동기화** — store.js + handleMessageUpdate/Delete. 수정 시 재번역하여 webhook editMessage, 삭제 시 webhook deleteMessage

### 추가된 파일

- `store.js` — 원본 messageId → 릴레이된 webhook messageId 매핑 (in-memory, max 1000, TTL 24h)

### 주요 설계 결정

- `message.client.channels.fetch` 패턴으로 글로벌 client 의존성 제거 (relay.js)
- `Partials.Message`, `Partials.Channel` 추가 → 봇 시작 전 메시지의 edit/delete도 처리 가능
- 캐시 키: `${sourceLang}|${targetLang}|${text}` — 언어 쌍별 캐시
- rate limit은 사용자별 in-flight count (글로벌 X) — 도배 방지 + 정상 유저 보호 균형
