# Open-LLM-VTuber 프롬프트 가이드

`conf.yaml`의 `system_config.tool_prompts`에 정의된 주요 프롬프트 파일들의 역할과 설명입니다.

## 1. 표정 및 행동 제어
### `live2d_expression_prompt` (`live2d_expression_prompt.txt`)
- **역할**: AI가 감정을 표현하거나 특정 행동을 취할 때 사용하는 키워드를 정의합니다.
- **작동 방식**: `[<insert_emomap_keys>]` 위치에 `model_dict.json`에서 불러온 표정 키워드(예: `[joy]`, `[neutral]`)와 효과음 키워드(예: `[sfx-clap]`)가 자동으로 삽입됩니다.
- **사용 예시**: "정말 반가워요! [joy]"

## 2. 사고 과정 (Chain of Thought)
### `think_tag_prompt` (`think_tag_prompt.txt`)
- **역할**: AI가 답변을 내뱉기 전에 `<think>` 태그 안에서 먼저 생각하도록 유도합니다.
- **효과**:
    - 더 논리적이고 깊이 있는 답변을 생성할 수 있습니다.
    - `<think>` 태그 안의 내용은 음성으로 출력되지 않고 로그에만 남거나 화면에 별도로 표시될 수 있습니다.
- **사용 예시**: `<think>사용자가 화가 난 것 같으니 조심스럽게 대답하자.</think> 죄송해요, 제가 실수를 했네요.`

## 3. 페르소나 및 대화 스타일
### `live_prompt` (`live_prompt.txt`)
- **역할**: 라이브 방송 스트리머로서의 페르소나를 부여합니다.
- **내용**: 시청자(채팅)와 실시간으로 소통하는 듯한 활기차고 자연스러운 말투를 유도합니다.

### `proactive_speak_prompt` (`proactive_speak_prompt.txt`)
- **역할**: 사용자가 말을 걸지 않았을 때(침묵 감지 등), AI가 먼저 말을 거는 상황(Proactive Speaking)에서 사용됩니다.
- **내용**: 문맥에 맞는 흥미로운 주제를 던지거나 혼잣말을 하도록 유도합니다.

### `group_conversation_prompt` (`group_conversation_prompt.txt`)
- **역할**: 다자간 대화(그룹 채팅) 상황에서의 행동 지침입니다.
- **내용**:
    - 다른 AI나 사용자를 적절히 언급하며 대화합니다.
    - 혼자 너무 길게 말하지 않고 발언 기회를 나눕니다.

## 4. 도구 및 기능 확장
### `mcp_prompt` (`mcp_prompt.txt`)
- **역할**: MCP (Model Context Protocol) 도구를 사용하기 위한 프롬프트입니다.
- **내용**: 사용 가능한 도구 목록과 도구를 호출할 때 지켜야 할 JSON 형식을 정의합니다.

### `tool_guidance_prompt` (`tool_guidance_prompt.txt`)
- **역할**: 도구 사용 시 AI의 태도를 제어합니다.
- **내용**: 도구 사용 허락을 구하지 말고 주도적으로 사용하며, 불필요한 설명을 줄이도록 지시합니다.

## 5. 음성 합성 최적화
### `speakable_prompt` (`speakable_prompt.txt`)
- **역할**: 텍스트를 TTS(음성 합성)로 읽기 좋은 형태로 변환하도록 지시합니다.
- **내용**:
    - 특수문자, 이모티콘 남발 금지.
    - 숫자, 단위, 기호 등을 읽는 소리 그대로 풀어서 쓰도록 유도합니다 (예: `$10` -> "ten dollars").
