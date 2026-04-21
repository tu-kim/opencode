# OpenCode LLM 프로파일링 시스템

## 개요

`OPENCODE_PROFILING=true` 환경변수가 설정되면, 매 LLM API 호출마다 요약 로그와 raw 로그를 파일에 기록합니다.

```bash
OPENCODE_PROFILING=true bun dev
```

**로그 위치**: `~/.local/share/opencode/profiling/`

| 파일 | 형식 | 내용 |
|------|------|------|
| `profile-<timestamp>.jsonl` | JSONL (한 줄 한 레코드) | 토큰, 시간, 모델, 도구 등 요약 |
| `profile-raw-<timestamp>.jsonl` | Pretty JSON + `---` 구분 | 입출력 전문 (system prompt, messages, 생성된 텍스트) |

두 파일은 `requestID` 필드로 cross-reference 가능합니다.

## 구현 파일

| 파일 | 역할 |
|------|------|
| `session/profiler.ts` | JSONL 로거 모듈 (이 문서에서 설명) |
| `session/llm.ts` | `streamText()` 직전에 `startRequest()` 호출 |
| `session/processor.ts` | 스트림 이벤트에서 `appendText/appendReasoning/appendToolCall/completeToolCall/endRequest` 호출 |
| `flag/flag.ts` | `OPENCODE_PROFILING` 환경변수 플래그 정의 |

## 데이터 흐름

```
llm.ts                    processor.ts                       profiler.ts
────────                  ──────────────                     ───────────
streamText() 직전 ──────→ startRequest()                     pending Map에 저장
                          │
                          ├─ reasoning-delta ──→ appendReasoning()   reasoning += delta
                          ├─ text-delta ──────→ appendText()         text += delta
                          ├─ tool-call ───────→ appendToolCall()     toolCalls[] 추가, 시작시간 기록
                          ├─ tool-result ─────→ completeToolCall()   경과시간 계산, totalToolMs 누적
                          ├─ tool-error ──────→ completeToolCall()   동일
                          │
                          └─ finish-step ─────→ endRequest()         summary + raw 파일에 flush
```

## profiler.ts 상세

### 내부 상태

**`pending` Map** (line 29) — `sessionID → RequestData`로 진행 중인 요청을 추적합니다. 한 세션에서 동시에 하나의 LLM 스트림만 실행되므로 `sessionID`가 키입니다.

**`ensureStreams()`** (line 38-46) — lazy 초기화. 첫 `endRequest` 호출 시 두 파일을 생성합니다. 프로세스 수명 동안 같은 timestamp를 공유하므로 한 쌍의 파일만 생성됩니다.

### RequestData 구조

```typescript
interface RequestData {
  // 메타데이터 (startRequest에서 캡처)
  timestamp: string
  sessionID: string
  messageID: string
  agent: string              // "build", "plan", "explore" 등
  provider: string           // "openai-compatible", "anthropic" 등
  modelID: string            // opencode 내부 모델 ID
  apiModelID: string         // 실제 API에 전달되는 모델 ID
  endpoint: string           // LLM API baseURL
  messageRoles: string[]     // ["system", "user", "assistant", "tool", ...]
  availableTools: string[]   // 등록된 tool 이름 목록
  inputMessages: unknown[]   // LLM에 전달된 전체 messages 배열

  // 타이밍
  startTime: number          // Date.now() at startRequest
  toolStartTimes: Map<string, number>  // callID → 시작시간
  totalToolMs: number        // tool 실행 시간 합계

  // 출력 (스트림 이벤트에서 누적)
  text: string               // 모델 생성 텍스트 (text-delta로 누적)
  reasoning: string          // thinking 텍스트 (reasoning-delta로 누적)
  toolCalls: { tool: string; input: unknown; durationMs?: number }[]
}
```

### 함수 설명

#### `startRequest(input)`
- **호출 위치**: `llm.ts` — `streamText()` 호출 직전
- **동작**: 모델/에이전트/endpoint/messages 메타데이터를 캡처하고 타이머를 시작합니다.
- **캡처 데이터**: sessionID, agent, provider, modelID, apiModelID, endpoint, system prompt, userQuery, 전체 messages 배열, 사용 가능한 tool 목록

#### `appendText(sessionID, delta)`
- **호출 위치**: `processor.ts` — `case "text-delta"`
- **동작**: 모델이 생성한 텍스트 토큰을 `text` 필드에 누적합니다.

#### `appendReasoning(sessionID, delta)`
- **호출 위치**: `processor.ts` — `case "reasoning-delta"`
- **동작**: thinking/chain-of-thought 토큰을 `reasoning` 필드에 누적합니다.

#### `appendToolCall(sessionID, callID, tool, input)`
- **호출 위치**: `processor.ts` — `case "tool-call"`
- **동작**: tool 이름과 입력 인자를 `toolCalls[]`에 추가하고, `toolStartTimes`에 시작시간을 기록합니다.

#### `completeToolCall(sessionID, callID)`
- **호출 위치**: `processor.ts` — `case "tool-result"` / `case "tool-error"`
- **동작**: 시작시간과의 차이로 경과시간을 계산하고, `totalToolMs`에 누적합니다. 해당 toolCall 항목에 `durationMs`를 기록합니다.

#### `endRequest(input)`
- **호출 위치**: `processor.ts` — `case "finish-step"`
- **동작**: `pending` Map에서 요청 데이터를 꺼내고, summary와 raw 두 파일에 기록합니다.
- **입력**: sessionID, messageID, tokens (input/output), finishReason
- **시간 계산**: `total = now - startTime`, `llm = total - totalToolMs`, `tools = totalToolMs`

## 출력 형식

### Summary 파일 (`profile-<ts>.jsonl`)

한 줄에 하나의 LLM 호출. `jq`로 분석하기 좋은 compact JSONL 형식입니다.

```json
{
  "timestamp": "2026-04-14T12:00:00.123Z",
  "requestID": "2026-04-14T12:00:00.123Z-01JABC",
  "sessionID": "01JXYZ...",
  "agent": "build",
  "provider": "openai-compatible",
  "modelID": "qwen-72b",
  "apiModelID": "qwen-72b-chat",
  "endpoint": "http://localhost:8000/v1",
  "messageRoles": ["system", "user", "assistant", "tool", "user"],
  "availableTools": ["bash", "read", "edit", "write", "glob", "grep"],
  "calledTools": ["read", "edit"],
  "tokens": {
    "input": 3200,
    "output": 450
  },
  "finishReason": "tool-calls",
  "durationMs": {
    "total": 12500,
    "llm": 4200,
    "tools": 8300
  }
}
```

### Raw 파일 (`profile-raw-<ts>.jsonl`)

같은 호출의 입출력 전문. Pretty-printed JSON에 `---`로 구분됩니다.

```json
{
  "requestID": "2026-04-14T12:00:00.123Z-01JABC",
  "input": [
    { "role": "system", "content": "You are an AI assistant..." },
    { "role": "user", "content": "auth 버그 수정해줘" },
    { "role": "assistant", "content": "파일을 확인하겠습니다." },
    { "role": "tool", "content": "import { ... }" }
  ],
  "output": {
    "text": "토큰 검증 로직을 수정하겠습니다.",
    "reasoning": "auth 모듈의 validateToken 함수를 보면 만료 체크가 빠져있다...",
    "toolCalls": [
      {
        "tool": "read",
        "input": { "filePath": "/src/auth/token.ts" },
        "durationMs": 45
      },
      {
        "tool": "edit",
        "input": { "filePath": "/src/auth/token.ts", "oldString": "...", "newString": "..." },
        "durationMs": 32
      }
    ]
  }
}
---
```

## 측정 위치 다이어그램

```
streamText() 호출 직전          ← startRequest (startTime 기록)
  │
  ├─ LLM이 토큰 생성 중...
  │   reasoning-delta ──────── ← appendReasoning
  │   text-delta ───────────── ← appendText
  │   tool-input-delta
  │
  ├─ tool-call 이벤트           ← appendToolCall (toolStartTimes에 시작 기록)
  │    │
  │    └─ tool.execute() 실행중
  │    │
  │    └─ tool-result 이벤트    ← completeToolCall (elapsed 누적)
  │
  ├─ LLM이 다시 토큰 생성...   (다음 step인 경우 별도 requestID)
  │
  └─ finish-step 이벤트        ← endRequest (total = now - startTime, llm = total - tools)
```

## 분석 예시

```bash
# 전체 요약 보기
cat ~/.local/share/opencode/profiling/profile-*.jsonl | jq .

# 토큰 사용량 순 정렬
cat profile-*.jsonl | jq -s 'sort_by(-.tokens.input)[] | {agent, tokens, durationMs}'

# LLM 시간이 가장 긴 호출
cat profile-*.jsonl | jq -s 'sort_by(-.durationMs.llm)[0]'

# tool별 총 실행 시간
cat profile-*.jsonl | jq '[.calledTools[]] | group_by(.) | map({tool: .[0], count: length})'

# 특정 요청의 raw 입출력 확인 (requestID로 검색)
grep -A 1000 "REQUEST_ID" profile-raw-*.jsonl | head -n $(grep -m1 -n "^---" <<< "$(grep -A 1000 "REQUEST_ID" profile-raw-*.jsonl)" | cut -d: -f1)
```
