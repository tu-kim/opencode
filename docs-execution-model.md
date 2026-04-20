# OpenCode 실행 모델 상세 설명

이 문서는 사용자의 query가 입력된 시점부터 LLM 모델 호출, 도구 실행, 최종 응답 반환까지의 전체 실행 흐름을 설명합니다. `docs-sequence-diagram.mmd`의 시퀀스 다이어그램에 대응합니다.

## 전체 흐름 요약

```
사용자 입력 → CLI 파싱 → 부트스트랩 → SDK → Hono 서버 → SessionPrompt
→ runLoop (반복) → Agent/Model 결정 → Tool 해석 → LLM 스트림 호출
→ 스트림 이벤트 처리 → 루프 판정 (계속/중단/압축) → 응답 반환
```

## Phase 1 — CLI 입력 & 부트스트랩

**관련 파일**: `src/index.ts`, `cli/cmd/run.ts`, `cli/bootstrap.ts`

### 1.1 CLI 진입

사용자가 `opencode run "Fix the bug"` 또는 `bun dev`를 실행하면 `src/index.ts`가 진입점이 됩니다.

- `bun dev` (인자 없이): 기본 커맨드 `$0`으로 **TUI 모드** 진입 (`cli/cmd/tui/thread.ts`)
- `bun dev run "message"`: **헤드리스 모드** 진입 (`cli/cmd/run.ts`)

yargs가 커맨드와 인자를 파싱하고, 미들웨어에서 로그 초기화, 데이터베이스 마이그레이션 등을 수행합니다.

### 1.2 부트스트랩

`cli/bootstrap.ts`의 `bootstrap()` 함수가 Effect.js 런타임을 초기화합니다.

```typescript
export async function bootstrap(directory, cb) {
  return Instance.provide({
    directory,
    init: () => AppRuntime.runPromise(InstanceBootstrap),
    fn: async () => { ... }
  })
}
```

이 과정에서 Config, Provider, Agent, Session, Permission 등 모든 서비스 Layer가 구성됩니다. Effect.js의 `Context`와 `Layer` 시스템을 통해 의존성 주입이 이루어집니다.

## Phase 2 — SDK → 내부 서버 라우팅

**관련 파일**: `@opencode-ai/sdk`, `server/server.ts`, `server/instance/session.ts`

### 2.1 SDK 생성

CLI 모드에서는 실제 네트워크 요청을 보내지 않습니다. 대신 Hono 서버의 `app.fetch()`를 직접 호출하는 in-process SDK를 생성합니다.

```typescript
const fetchFn = async (input, init?) => {
  const request = new Request(input, init)
  return Server.Default().app.fetch(request)
}
const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })
```

### 2.2 메시지 전송

SDK가 `POST /:sessionID/message` 엔드포인트로 요청을 보냅니다. 요청 본문에는 텍스트 파트, 첨부 파일, 에이전트 이름, 모델 정보가 포함됩니다.

Hono 서버는 Zod 스키마로 입력을 검증한 후 `SessionPrompt.prompt()`를 호출합니다.

## Phase 3 — 유저 메시지 저장

**관련 파일**: `session/prompt.ts`

`SessionPrompt.prompt()` 함수가 실행됩니다:

1. **세션 조회**: `sessions.get(sessionID)`로 세션 정보를 가져옵니다.
2. **유저 메시지 생성**: `createUserMessage(input)`에서 텍스트, 파일, 에이전트 파트를 처리합니다.
3. **DB 저장**: `sessions.updateMessage(userMsg)` + `sessions.updatePart(textPart)`로 SQLite에 저장합니다.
4. **루프 진입**: `loop({sessionID})`를 호출하여 runLoop에 진입합니다.

## Phase 4 — runLoop (핵심 반복 루프)

**관련 파일**: `session/prompt.ts` (lines 1303-1533)

`runLoop`은 `while (true)` 루프로, LLM 호출 → 도구 실행 → 재호출을 반복합니다.

### 4.1 대화 히스토리 조회

```typescript
let msgs = yield* MessageV2.filterCompactedEffect(sessionID)
```

`filterCompactedEffect`는 compaction(압축) 이후의 메시지만 필터링하여 반환합니다. 이전에 압축된 대화는 제외됩니다.

### 4.2 종료 조건 체크

루프에서 마지막 user 메시지(`lastUser`)와 마지막 assistant 메시지(`lastAssistant`)를 추출합니다.

종료 조건:
- `lastAssistant.finish`가 존재하고 `"tool-calls"`가 아님
- 보류 중인 tool call이 없음
- user 메시지가 assistant 메시지보다 이전

### 4.3 모델 & 에이전트 결정

```typescript
const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
const agent = yield* agents.get(lastUser.agent)
```

유저 메시지에 기록된 providerID/modelID로 모델을 조회하고, 에이전트 설정(build, plan, explore 등)을 가져옵니다.

### 4.4 Tool 해석

`resolveTools()` 함수가 에이전트 권한에 따라 사용 가능한 도구를 결정합니다:

- **ToolRegistry**: 내장 도구 (bash, read, edit, write, glob, grep 등)
- **MCP tools**: 외부 MCP 서버에서 가져온 도구
- **Plugin tools**: 플러그인이 제공하는 도구

각 도구는 AI SDK의 `tool()` 함수로 래핑되어 권한 체크, 실행 컨텍스트 바인딩이 적용됩니다.

### 4.5 System Prompt 조립

```typescript
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),              // 사용 가능한 skill 목록
  Effect.sync(() => sys.environment(model)),  // 환경 정보 (OS, 날짜 등)
  instruction.system(),           // 사용자 지시사항 (CLAUDE.md 등)
  MessageV2.toModelMessagesEffect(msgs, model),  // 대화 → ModelMessage 변환
])
```

### 4.6 Assistant 메시지 & Processor 생성

```typescript
yield* sessions.updateMessage(msg)  // 빈 assistant 메시지 DB 생성
const handle = yield* processor.create({ assistantMessage: msg, sessionID, model })
```

## Phase 5 — LLM 스트림 호출

**관련 파일**: `session/llm.ts`, `provider/provider.ts`

### 5.1 LanguageModel 획득

```typescript
provider.getLanguage(model)
```

Provider 서비스가 `@ai-sdk/*` 패키지(예: `@ai-sdk/openai`, `@ai-sdk/anthropic`)를 사용하여 `LanguageModelV3` 인스턴스를 생성합니다.

vLLM 같은 OpenAI-compatible 서버의 경우 `@ai-sdk/openai-compatible`이 사용됩니다.

### 5.2 System Prompt 최종 조립

```typescript
const system: string[] = []
system.push([
  ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
  ...input.system,
  ...(input.user.system ? [input.user.system] : []),
].filter(x => x).join("\n"))
```

에이전트 프롬프트, 스킬, 환경 정보, 사용자 지시사항이 하나의 system prompt로 합쳐집니다.

### 5.3 Plugin Hooks

- `experimental.chat.system.transform`: system prompt 변환
- `chat.params`: temperature, topP 등 파라미터 후킹
- `chat.headers`: HTTP 헤더 추가

### 5.4 streamText 호출

```typescript
return streamText({
  model: wrapLanguageModel({ model: language, middleware: [...] }),
  messages,       // system + 대화 히스토리 전체
  tools,          // 사용 가능한 도구 목록
  temperature,
  maxOutputTokens,
  ...
})
```

Vercel AI SDK의 `streamText()`가 LLM API에 SSE(Server-Sent Events) 스트리밍 요청을 보냅니다. 응답은 `AsyncIterable<Event>`로 반환됩니다.

## Phase 6 — 스트림 이벤트 처리

**관련 파일**: `session/processor.ts`

`SessionProcessor`가 LLM 스트림의 각 이벤트를 소비합니다.

### 이벤트 종류와 처리

| 이벤트 | 처리 |
|--------|------|
| `start` | 세션 상태를 "busy"로 설정 |
| `text-start` | 새 TextPart 생성 |
| `text-delta` | TextPart에 텍스트 추가 (실시간 스트리밍) |
| `text-end` | TextPart 완료, 플러그인 후처리 |
| `reasoning-start` | ReasoningPart 생성 (thinking 모드) |
| `reasoning-delta` | ReasoningPart에 텍스트 추가 |
| `reasoning-end` | ReasoningPart 완료 |
| `tool-input-start` | ToolPart 생성 (pending 상태) |
| `tool-call` | 도구 실행 시작 (running 상태), AI SDK가 `tool.execute()` 호출 |
| `tool-result` | 도구 실행 완료, 결과 저장 |
| `tool-error` | 도구 실행 실패 |
| `finish-step` | 토큰 사용량 기록, 비용 계산, overflow 체크 |
| `finish` | 스트림 종료 |

### finish-step 상세

`finish-step`에서 `Session.getUsage()`가 토큰 사용량을 계산합니다:

```
API 원본 inputTokens → adjustedInput (캐시 제외) + cacheRead + cacheWrite
API 원본 outputTokens → output (reasoning 제외) + reasoning
```

여기서 `isOverflow()` 체크로 컨텍스트 초과 여부를 판단하고, 초과 시 `needsCompaction = true`를 설정합니다.

## Phase 7 — 루프 판정 & 응답

**관련 파일**: `session/prompt.ts`

Processor가 반환하는 `Result` 값에 따라 루프의 다음 동작이 결정됩니다.

| Result | 동작 |
|--------|------|
| `"continue"` | LLM이 tool-call로 응답함. 도구 실행 결과를 messages에 추가하고 Phase 4로 돌아감 (재호출) |
| `"stop"` | LLM이 최종 텍스트를 생성함. 루프 종료 |
| `"compact"` | 토큰 초과 감지. `compaction.create()`로 컨텍스트 압축 후 재시도 |

### 루프 종료 후

```typescript
yield* compaction.prune({ sessionID })  // 오래된 tool output 정리
return yield* lastAssistant(sessionID)  // 최종 assistant 메시지 반환
```

응답은 `SessionPrompt → Hono Server → SDK → CLI`를 거쳐 사용자에게 포맷팅되어 출력됩니다.

## 핵심 특성

### In-Process 아키텍처

CLI 모드에서 SDK는 실제 네트워크 요청 없이 Hono 서버의 `app.fetch()`를 직접 호출합니다. 이를 통해 HTTP 오버헤드 없이 동일한 API 인터페이스를 사용합니다.

### Effect.js 기반 서비스

모든 핵심 서비스(`Session`, `Agent`, `Provider`, `Config` 등)가 Effect의 `Context.Service`로 정의되고 `Layer`로 합성됩니다. 의존성 주입과 에러 핸들링이 타입 안전하게 이루어집니다.

### Tool Loop 패턴

LLM이 tool-call로 응답하면 도구를 실행하고 결과를 다시 LLM에 전달하는 반복 구조입니다. 매 반복마다 **전체 대화 히스토리**(system prompt + 이전 메시지 + tool 결과)가 LLM에 전달되므로 input 토큰이 step마다 증가합니다.

### 실시간 이벤트 스트리밍

TUI/Web UI는 `sdk.event.subscribe()`로 SSE 이벤트를 구독하여 텍스트, 도구 실행, 에러 등을 실시간으로 표시합니다. Processor가 각 이벤트를 DB에 저장하면 서버가 이를 클라이언트에 브로드캐스트합니다.
