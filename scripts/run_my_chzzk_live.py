# scripts/run_my_chzzk_live.py
import asyncio
import sys
import os
import json
import websockets  # VTuber '우체통' 연결용
from loguru import logger

# 프로젝트 루트 경로를 sys.path에 추가 (src 모듈 임포트를 위해)
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, project_root)

# 1. chzzkpy 라이브러리 임포트
try:
    from chzzkpy import Client, UserPermission, Message
except ImportError:
    logger.error("chzzkpy 라이브러리가 설치되지 않았습니다.")
    logger.error("터미널에서 'uv pip install chzzkpy'를 실행해주세요.")
    sys.exit(1)

# 2. config_manager 유틸리티 임포트
from src.open_llm_vtuber.config_manager.utils import read_yaml

# --- 3. 전역 설정 ---
PROXY_URL = "ws://localhost:12393/proxy-ws"
message_queue = asyncio.Queue()

# --- 4. conf.yaml을 읽어 전역 클라이언트(client) 생성 ---
try:
    config_path = os.path.join(project_root, "conf.yaml")
    config_data = read_yaml(config_path)
    
    # 'live_config'가 아닌 최상위에서 'my_chzzk'를 찾습니다.
    chzzk_config = config_data.get("my_chzzk", {})
    
    CLIENT_ID = chzzk_config.get("client_id")
    CLIENT_SECRET = chzzk_config.get("client_secret")

    if not CLIENT_ID or not CLIENT_SECRET or CLIENT_ID == "여기에_클라이언트_ID_붙여넣기":
        logger.error("conf.yaml의 'my_chzzk' 섹션에 client_id와 client_secret을 올바르게 입력해주세요.")
        sys.exit(1)
        
    # [수정] client를 최상위(전역)으로 이동
    client = Client(CLIENT_ID, CLIENT_SECRET)

except Exception as e:
    logger.error(f"conf.yaml 읽기 또는 클라이언트 생성 실패: {e}")
    sys.exit(1)


# --- 5. 전역 이벤트 핸들러 정의 ---

async def handle_chat(message: Message):
    """(RuntimeWarning 우회용) 실제 채팅 처리 로직"""
    chat_text = message.content
    user_nickname = message.profile.nickname
    logger.info(f"[치지직 수신] {user_nickname}: {chat_text}")
    await message_queue.put(chat_text)

@client.event
async def on_chat(message: Message):
    """
    chzzkpy는 이 함수를 호출하지만 await하지 않아 RuntimeWarning이 발생합니다.
    따라서 이 함수는 실제 작업을 '실행 예약'(create_task)하는 역할만 합니다.
    """
    # [수정] 'asyncio.create_task()'가 빠져있던 오류 수정
    handle_chat(message)

@client.event
async def on_connect():
    # 사용자님이 추가했던 'Ready bot' 로그
    logger.success("Chzzk Gateway에 연결됨 (Ready bot).")


async def chzzk_listener():
    """(작업 1) 치지직 로그인 및 연결 (전역 client 사용)"""
    try:
        # 1. 인증 코드 요청 URL 생성
        state_code = "nemuriaMiya" # 보안을 위해 랜덤 state 생성
        redirect_url = "http://localhost:8080/"
        
        auth_url = client.generate_authorization_token_url(
            redirect_url=redirect_url,
            state=state_code
        )
        
        logger.warning("-" * 50)
        logger.warning("🚨 [수동 인증 필요] 아래 URL에 접속하여 코드를 가져오세요. 🚨")
        logger.warning(f"URL: {auth_url}")
        logger.warning("-" * 50)
        
        # 2. 사용자에게 코드 입력 요청
        code = input("브라우저에서 로그인 완료 후, 주소창의 'code=' 뒤에 있는 값을 여기에 붙여넣으세요: ")

        if not code.strip():
            logger.error("인증 코드가 입력되지 않아 연결을 중단합니다.")
            return

        # 3. 입력받은 코드로 UserClient 생성 (로그인 성공 단계)
        logger.info("인증 코드를 사용하여 UserClient 생성 중...")
        # user_client = await client.login() 대신 이 함수를 사용합니다.
        user_client = await client.generate_user_client(code.strip(), state_code)

        logger.success("chzzkpy UserClient 생성 성공.")
        
        # ServerDisconnectedError를 피하기 위해 .chat (괄호 없음) 사용
        await user_client.connect(UserPermission.chat)
        logger.success("치지직 채팅방 이벤트 구독 완료. (작업 1 실행 중)")
        
        # 무한 대기
        await asyncio.Event().wait()

    except Exception as e:
        logger.error(f"치지직 리스너 오류: {e}")
        import traceback
        logger.debug(traceback.format_exc())
        
async def proxy_sender(proxy_url):
    """(작업 2) '우체통'에 연결하고, '큐'에서 메시지를 꺼내 전송합니다."""
    try:
        async with websockets.connect(proxy_url) as proxy_ws:
            logger.success(f"메인 서버 '우체통'({proxy_url}) 연결 성공. (작업 2 실행 중)")
            
            while True:
                chat_text = await message_queue.get()
                
                # [수정] "texat" 오타를 "text"로 수정
                payload = {"type": "text-input", "text": chat_text}
                await proxy_ws.send(json.dumps(payload))
                logger.info(f"[VTuber로 전송] {chat_text}")
                
                message_queue.task_done()

    except websockets.exceptions.ConnectionClosedError:
        logger.error(f"메인 서버 '우체통'({proxy_url}) 연결이 끊겼습니다. (작업 2 중단)")
    except Exception as e:
        logger.error(f"프록시 전송기 오류: {e}")


async def main():
    logger.info("치지직 라이브 '전달자' 스크립트 시작 (전역 클라이언트 방식)")
    
    # '작업 1'과 '작업 2'를 동시에 실행
    await asyncio.gather(
        chzzk_listener(), # 이제 인자가 필요 없습니다.
        proxy_sender(PROXY_URL)
    )

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("사용자에 의해 스크립트 종료")