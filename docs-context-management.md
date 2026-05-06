# OpenCode 컨텍스트 관리 상세 설명

이 문서는 OpenCode가 LLM의 제한된 컨텍스트 윈도우 안에서 긴 대화를 관리하는 방법을 설명합니다. 핵심 메커니즘은 **Compaction**(대화 압축)과 **Pruning**(도구 출력 정리) 두 가지입니다.

## 컨텍스트 문제

LLM은 호출할 때마다 **전체 대화 히스토리**를 `messages` 배열로 전달받습니다:

```
Step 1: [system, user]                                    → input 토큰: 3,000
Step 2: [system, user, assistant, tool-result]             → input 토큰: 8,000
Step 3: [system, user, assistant, tool-result, assistant, tool-result] → input 토큰: 15,000
...
Step N: [system, ... 50개 메시지 ...]                      → input 토큰: 120,000+
```

도구를 여러 번 호출할수록 대화가 길어지고, 결국 모델의 컨텍스트 한도에 도달합니다. 이를 처리하는 3단계 전략이 있습니다.

## 1단계: Pruning (도구 출력 정리)

**관련 파일**: `session/compaction.ts` (lines 89-135)

가장 가벼운 최적화로, 오래된 도구 실행 결과의 **출력 텍스트를 비웁니다**. 도구가 실행되었다는 사실은 유지하되, 구체적인 출력 내용은 삭제합니다.

### 동작 방식

```
[Before Pruning]
tool: read("/src/auth.ts") → output: "import { ... } // 500줄의 파일 내용"
tool: grep("password")     → output: "src/auth.ts:42: validatePassword(...) // 200줄"
tool: read("/src/db.ts")   → output: "import { ... } // 300줄"  ← 최근
tool: edit("/src/auth.ts") → output: "diff: +newLine..."        ← 최근

[After Pruning]
tool: read("/src/auth.ts") → output: (compacted)  ← 오래된 것만 정리
tool: grep("password")     → output: (compacted)  ← 오래된 것만 정리
tool: read("/src/db.ts")   → output: "import { ... } // 300줄"  ← 유지
tool: edit("/src/auth.ts") → output: "diff: +newLine..."        ← 유지
```

### 주요 상수

| 상수 | 값 | 의미 |
|------|----|----|
| `PRUNE_PROTECT` | 40,000 토큰 | 최근 도구 출력 중 이만큼은 보호 (정리하지 않음) |
| `PRUNE_MINIMUM` | 20,000 토큰 | 최소 이만큼 확보할 수 있을 때만 정리 실행 |
| `PRUNE_PROTECTED_TOOLS` | `["skill"]` | 절대 정리하지 않는 도구 |

### 정리 대상 선정

1. 메시지를 **역순**으로 순회합니다.
2. 최소 2턴(user → assistant 왕복 2회) 이후의 도구만 대상으로 합니다.
3. 최근 `PRUNE_PROTECT`(40,000) 토큰 분량은 건너뜁니다.
4. 그 이후의 completed 도구 출력을 `compacted` 타임스탬프로 마킹합니다.
5. 확보 가능한 토큰이 `PRUNE_MINIMUM`(20,000) 미만이면 실행하지 않습니다.

### 실행 시점

runLoop 종료 시 비동기로 실행됩니다 (`prompt.ts`):

```typescript
yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
```

## 2단계: Overflow 감지

**관련 파일**: `session/overflow.ts`

매 LLM 응답(`finish-step`)마다 현재 토큰 사용량이 모델의 한도를 초과하는지 검사합니다.

### 계산 공식

```
사용된 토큰 = total 또는 (input + output + cache.read + cache.write)
예약 토큰  = min(COMPACTION_BUFFER, maxOutputTokens)     // 기본 20,000
사용 가능   = inputLimit - 예약 토큰
           또는 contextLimit - maxOutputTokens

overflow = (사용된 토큰 >= 사용 가능)
```

### 예시 (128K 컨텍스트 모델)

```
contextLimit = 128,000
maxOutputTokens = 16,384
COMPACTION_BUFFER = 20,000
예약 = min(20,000, 16,384) = 16,384
사용 가능 = 128,000 - 16,384 = 111,616

현재 사용: 115,000 → overflow = true (115,000 >= 111,616)
```

### Overflow 감지 위치 (2곳)

**1. Processor의 `finish-step` 핸들러** (`processor.ts`):

매 LLM 응답 완료 시 체크합니다. overflow 감지 시 `needsCompaction = true`를 설정하고, Processor는 `"compact"` 결과를 반환합니다.

```typescript
if (!ctx.assistantMessage.summary && isOverflow({ cfg, tokens, model })) {
  ctx.needsCompaction = true
}
```

**2. runLoop의 대화 히스토리 체크** (`prompt.ts`):

이전 assistant 메시지의 토큰 수를 기반으로 사전 감지합니다.

```typescript
if (lastFinished && !lastFinished.summary &&
    compaction.isOverflow({ tokens: lastFinished.tokens, model })) {
  yield* compaction.create({ sessionID, agent, model, auto: true })
}
```

### 비활성화

```jsonc
// .opencode/opencode.jsonc
{
  "compaction": {
    "auto": false  // overflow 감지 비활성화
  }
}
```

## 3단계: Compaction (대화 압축)

**관련 파일**: `session/compaction.ts` (lines 137-364)

Overflow가 감지되면 전체 대화 히스토리를 **LLM에게 요약 요청**하여 압축합니다.

### 전체 흐름

```
1. runLoop에서 overflow 감지
   ↓
2. compaction.create() → CompactionPart를 유저 메시지에 삽입
   ↓
3. 다음 루프 반복에서 CompactionPart 발견
   ↓
4. compaction.process() 실행
   ↓
5. "compaction" 에이전트가 대화를 요약
   ↓
6. 요약 결과가 summary 메시지로 저장 (summary: true)
   ↓
7. filterCompactedEffect()가 요약 이전 메시지를 필터링
   ↓
8. 다음 LLM 호출은 [요약 + 최근 메시지]만 전달
```

### CompactionPart

```typescript
{
  type: "compaction",
  auto: true,        // 자동 압축 여부
  overflow: false     // overflow로 인한 압축 여부
}
```

이 파트가 유저 메시지에 삽입되면 runLoop이 이를 감지하고 compaction을 실행합니다.

### 요약 프롬프트

compaction 에이전트에게 전달되는 기본 프롬프트 (`compaction.ts` lines 185-213):

```
Provide a detailed prompt for continuing our conversation above.
...
When constructing the summary, try to stick to this template:
---
## Goal
[사용자가 달성하려는 목표]

## Instructions
[사용자가 제공한 중요 지시사항]

## Discoveries
[대화 중 알게 된 주요 사항]

## Accomplished
[완료된 작업, 진행 중인 작업, 남은 작업]

## Relevant files / directories
[관련 파일/디렉토리 목록]
---
```

### 요약 결과 저장

요약은 `summary: true`가 설정된 assistant 메시지로 저장됩니다:

```typescript
const msg: MessageV2.Assistant = {
  ...
  mode: "compaction",
  agent: "compaction",
  summary: true,        // ← 이 플래그가 핵심
  ...
}
```

### filterCompactedEffect의 역할

runLoop 시작 시 호출되는 `filterCompactedEffect`는 메시지를 역순으로 순회하면서:

1. 각 메시지를 결과 배열에 추가합니다.
2. `summary: true`인 assistant 메시지를 찾으면 해당 parent user 메시지를 "완료"로 마킹합니다.
3. 이미 완료된 user 메시지에 CompactionPart가 있으면 **순회를 중단**합니다.

결과적으로 **요약 이후의 메시지만** LLM에 전달됩니다:

```
[Before Compaction]
messages = [system, user1, assistant1, tool1, user2, assistant2, tool2, ...]  // 120K 토큰

[After Compaction]
messages = [system, summary("Goal: ... Accomplished: ..."), user-continue, ...]  // 8K 토큰
```

### Overflow 시 Replay 메커니즘

`overflow: true`로 compaction이 실행될 때, 단순 요약만으로는 사용자의 마지막 요청 의도가 손실될 수 있습니다. 이를 방지하기 위해 **replay** 메커니즘이 있습니다:

1. 현재 유저 메시지(`parentID`) 이전의 가장 최근 "순수" 유저 메시지를 찾습니다 (CompactionPart가 없는 것).
2. 그 메시지 이전까지의 히스토리만 요약합니다.
3. 요약 완료 후 찾아둔 유저 메시지를 **다시 전송**(replay)합니다.

이렇게 하면 사용자의 마지막 요청이 요약된 컨텍스트 위에서 다시 실행됩니다.

### Auto-Continue

non-overflow 자동 압축의 경우, 압축 후 다음 메시지를 자동 생성합니다:

```
"Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
```

## 전체 메커니즘 요약

```
도구 실행 반복 → 토큰 증가
  ↓
[1단계] Pruning: 오래된 도구 출력 삭제 (경량, 비동기)
  ↓
계속 증가
  ↓
[2단계] Overflow 감지: isOverflow() → true
  ↓
[3단계] Compaction: LLM이 대화 요약 → 요약 이후 메시지만 유지
  ↓
토큰 대폭 감소 → 계속 작업
  ↓
다시 증가하면 → [3단계] 반복
  ↓
요약조차 컨텍스트를 초과하면 → "stop" 반환, 세션 종료
```

## 관련 설정

```jsonc
// .opencode/opencode.jsonc
{
  "compaction": {
    "auto": true,       // 자동 compaction on/off (기본: true)
    "prune": true,      // 자동 pruning on/off (기본: true)
    "reserved": 20000   // overflow 감지용 예약 토큰 수
  }
}
```

## 관련 파일 목록

| 파일 | 역할 |
|------|------|
| `session/compaction.ts` | Compaction & Pruning 로직 |
| `session/overflow.ts` | Overflow 감지 함수 |
| `session/message-v2.ts` | `filterCompactedEffect()`, `CompactionPart` 정의 |
| `session/prompt.ts` | runLoop에서 compaction 트리거 |
| `session/processor.ts` | `finish-step`에서 overflow 감지 |
| `agent/prompt/compaction.txt` | Compaction 에이전트 프롬프트 |
