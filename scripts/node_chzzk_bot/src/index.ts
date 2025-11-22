import 'dotenv/config';
import { WebSocket } from 'ws';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import buzzk from 'buzzk';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// --- Types ---
interface ChzzkToken {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    timestamp: number;
}

interface Config {
    my_chzzk?: {
        client_id?: string;
        client_secret?: string;
    };
}

interface QueuedMessage {
    nickname: string;
    message: string;
}

// --- Constants ---
const OAUTH_REDIRECT_URI = 'http://localhost:8080/';
const TOKEN_FILE_PATH = './chzzk-token.json';
const PROXY_URL = 'ws://localhost:12393/proxy-ws';
const PROJECT_ROOT = path.resolve(__dirname, '../../..'); // scripts/node_chzzk_bot/src -> scripts/node_chzzk_bot -> scripts -> root
const CONFIG_PATH = path.join(PROJECT_ROOT, 'conf.yaml');
const MAX_QUEUE_SIZE = 20;
const PROCESSING_TIMEOUT_MS = 30000; // 30 seconds timeout

// --- Global State ---
let chzzkChatInstance: any;
let proxyWs: WebSocket | null = null; // Global proxy websocket
let messageQueue: QueuedMessage[] = [];
let isProcessing: boolean = false;
let processingTimeout: NodeJS.Timeout | null = null;
let audioPlaybackEndTime: number = 0; // 예상되는 오디오 재생 종료 시간 (Timestamp)

// --- Helper: Read Config ---
async function readConfig(): Promise<{ clientId: string; clientSecret: string }> {
    try {
        const fileContents = await fs.readFile(CONFIG_PATH, 'utf8');
        const config = yaml.load(fileContents) as Config;
        const chzzkConfig = config.my_chzzk;

        if (!chzzkConfig?.client_id || !chzzkConfig?.client_secret || chzzkConfig.client_id === "여기에_클라이언트_ID_붙여넣기") {
            throw new Error("conf.yaml의 'my_chzzk' 섹션에 client_id와 client_secret을 올바르게 입력해주세요.");
        }

        return {
            clientId: chzzkConfig.client_id,
            clientSecret: chzzkConfig.client_secret
        };
    } catch (error) {
        console.error(`설정 파일(${CONFIG_PATH})을 읽는 중 오류 발생:`, error);
        process.exit(1);
    }
}

// --- Token Management ---
async function getAccessTokenViaOAuth2(clientId: string): Promise<ChzzkToken> {
    const state = "zxclDasdfA25";
    const authUrl = `https://chzzk.naver.com/account-interlock?clientId=${clientId}&redirectUri=${encodeURIComponent(OAUTH_REDIRECT_URI)}&state=${state}`;

    console.warn('--- [수동 인증 필요] ---');
    console.log('1. 아래 URL에 접속하여 로그인 및 권한을 허용해 주세요:');
    console.log(authUrl);
    console.warn('-------------------------');

    const rl = readline.createInterface({ input, output });
    const code = await rl.question('2. 브라우저에서 로그인 완료 후, 주소창의 \'code=\' 뒤의 값을 여기에 붙여넣으세요: ');
    rl.close();

    if (!code.trim()) throw new Error('인증 코드가 입력되지 않았습니다.');

    console.log("토큰 요청 중...");
    const tokenData = await buzzk.oauth.get(code.trim());
    console.log("토큰 발급 성공");

    const token: ChzzkToken = {
        accessToken: tokenData.access,
        refreshToken: tokenData.refresh,
        expiresIn: tokenData.expireIn,
        timestamp: Date.now()
    };

    await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(token, null, 2));
    console.log('새 Access Token을 발급받아 파일에 저장했습니다.');
    return token;
}

async function refreshAccessToken(refreshToken: string): Promise<ChzzkToken> {
    console.log('Access Token 갱신 시도...');
    const tokenData = await buzzk.oauth.refresh(refreshToken);

    const token: ChzzkToken = {
        accessToken: tokenData.access,
        refreshToken: tokenData.refresh,
        expiresIn: tokenData.expireIn,
        timestamp: Date.now()
    };

    await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(token, null, 2));
    console.log('Access Token을 갱신하여 파일에 저장했습니다.');
    return token;
}

async function getValidToken(clientId: string): Promise<ChzzkToken> {
    try {
        const file = await fs.readFile(TOKEN_FILE_PATH, 'utf-8');
        let token: ChzzkToken = JSON.parse(file);
        // 갱신: 만료 10분 전
        const expiresInMs = (token.expiresIn * 1000) - (10 * 60 * 1000);
        if (Date.now() - token.timestamp > expiresInMs) {
            return await refreshAccessToken(token.refreshToken);
        }
        console.log('저장된 Access Token을 사용합니다.');
        return token;
    } catch (error) {
        console.log('저장된 토큰이 없거나 유효하지 않습니다. 새로 발급합니다.');
        return await getAccessTokenViaOAuth2(clientId);
    }
}

// --- Queue Processing Logic ---
function startProcessingTimeout() {
    if (processingTimeout) clearTimeout(processingTimeout);
    processingTimeout = setTimeout(() => {
        console.warn(`[Timeout] ${PROCESSING_TIMEOUT_MS}ms 동안 응답이 없어 상태를 초기화합니다.`);
        isProcessing = false;
        processingTimeout = null;
        audioPlaybackEndTime = 0;
        processBatchQueue(); // 큐에 남은게 있으면 처리 시도
    }, PROCESSING_TIMEOUT_MS);
}

function stopProcessingTimeout() {
    if (processingTimeout) {
        clearTimeout(processingTimeout);
        processingTimeout = null;
    }
}

function processBatchQueue() {
    if (messageQueue.length === 0) return;
    if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
        console.warn("프록시 연결이 끊겨 있어 큐를 처리할 수 없습니다.");
        return;
    }

    console.log(`[Queue] 대기 중인 메시지 ${messageQueue.length}개를 배치로 처리합니다.`);

    // 배치 메시지 생성
    let combinedText = "";
    if (messageQueue.length > 1) {
        combinedText = "[System Message: The following messages were received while you were speaking. Please respond to the main topic or interesting ones.]\n";
    }

    combinedText += messageQueue.map(q => `[${q.nickname}]: ${q.message}`).join("\n");

    // 큐 비우기
    messageQueue = [];

    // 전송
    const payload = { type: "text-input", text: combinedText };
    proxyWs.send(JSON.stringify(payload));

    // 상태 업데이트
    isProcessing = true;
    audioPlaybackEndTime = 0; // 재생 시간 초기화
    startProcessingTimeout();
    console.log(">> [Batch] 묶음 메시지를 전송했습니다.");
}

// --- Proxy Connection ---
function connectToProxy(): WebSocket {
    const ws = new WebSocket(PROXY_URL);
    proxyWs = ws; // Assign to global

    ws.on('open', () => {
        console.log(`메인 서버 '우체통'(${PROXY_URL}) 연결 성공.`);
    });

    ws.on('error', (err) => {
        console.error(`메인 서버 연결 오류: ${err.message}`);
        stopProcessingTimeout();
        isProcessing = false;
    });

    ws.on('close', () => {
        console.log('메인 서버 연결이 끊겼습니다. 3초 후 재연결 시도...');
        stopProcessingTimeout();
        isProcessing = false;
        setTimeout(() => connectToProxy(), 3000);
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            // 제어 신호 처리 (대화 종료 등)
            if (message.type === 'control' && message.text === 'conversation-chain-end') {
                console.log('[Proxy] 대화 턴 종료 신호 수신. 다음 메시지 처리를 준비합니다.');
                stopProcessingTimeout();
                isProcessing = false;
                processBatchQueue();
            } else if (message.type === 'error') {
                console.warn('[Proxy] 에러 발생. 상태를 초기화합니다.');
                stopProcessingTimeout();
                isProcessing = false;
                processBatchQueue();
            }
            // 오디오 데이터 수신 시 재생 시간 계산
            else if (message.type === 'audio') {
                if (message.display_text) {
                    const text = message.display_text.text || message.display_text;
                    console.log(`[AI 응답] ${text}`);
                }

                if (message.volumes && Array.isArray(message.volumes)) {
                    const sliceLength = message.slice_length || 20; // 기본값 20ms
                    const durationMs = message.volumes.length * sliceLength;

                    const now = Date.now();
                    if (audioPlaybackEndTime < now) {
                        audioPlaybackEndTime = now + durationMs;
                    } else {
                        audioPlaybackEndTime += durationMs;
                    }
                    // console.log(`[Audio] 추가 재생 시간: ${durationMs}ms, 예상 종료: ${new Date(audioPlaybackEndTime).toLocaleTimeString()}`);
                }
            }
            // 합성 완료 신호 수신 시 가상 재생 대기
            else if (message.type === 'backend-synth-complete') {
                console.log('[Proxy] 합성 완료. 가상 재생 대기 시작...');

                const now = Date.now();
                let remainingTime = audioPlaybackEndTime - now;

                // 최소 대기 시간 (네트워크 지연 등 고려하여 1초 정도 여유)
                if (remainingTime < 0) remainingTime = 0;
                remainingTime += 1000;

                console.log(`[Proxy] 예상 남은 재생 시간: ${(remainingTime / 1000).toFixed(1)}초. 대기 후 완료 신호를 보냅니다.`);

                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        console.log('[Proxy] 가상 재생 완료. 완료 신호를 보냅니다.');
                        ws.send(JSON.stringify({ type: 'frontend-playback-complete' }));
                    }
                }, remainingTime);
            }
            else if (message.type === 'full-text' && message.text) {
                // console.log(`[AI 텍스트] ${message.text}`);
            }
        } catch (error) {
            console.error('메시지 파싱 오류:', error);
        }
    });

    return ws;
}

// --- Main Logic ---
async function main() {
    console.log('--- Node.js Chzzk Bot 서비스 시작 ---');

    // 1. 설정 로드
    const { clientId, clientSecret } = await readConfig();

    // 2. buzzk 초기화
    buzzk.auth(clientId, clientSecret);

    // 3. 토큰 확보
    let token: ChzzkToken;
    try {
        token = await getValidToken(clientId);
    } catch (e) {
        console.error("토큰 발급 실패:", e);
        return;
    }

    // 4. 프록시 연결
    connectToProxy(); // proxyWs is assigned inside

    // 5. 치지직 채팅 연결
    async function connectChzzk() {
        if (chzzkChatInstance) {
            await chzzkChatInstance.disconnect().catch(() => { });
        }

        const chat = new buzzk.chat(token.accessToken);
        chzzkChatInstance = chat;

        await chat.connect();
        console.log('치지직 채팅방에 성공적으로 참여했습니다.');

        chat.onMessage(async (data: any) => {
            const message = data.message;
            const nickname = data.author.nickname || "Unknown";

            console.log(`[치지직] ${nickname}: ${message}`);

            // 프록시 연결 확인
            if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
                console.warn("프록시 서버가 연결되어 있지 않아 메시지를 무시합니다.");
                return;
            }

            // 초기화 명령
            if (message === "!reset" || message === "!초기화") {
                const payload = { type: "interrupt-signal" };
                proxyWs.send(JSON.stringify(payload));
                console.log(">> [명령] 인터럽트(초기화) 신호를 전송했습니다.");

                // 큐 및 상태 초기화
                messageQueue = [];
                stopProcessingTimeout();
                isProcessing = false;
                audioPlaybackEndTime = 0;
                console.log(">> [Queue] 큐와 처리 상태를 초기화했습니다.");
                return;
            }

            // 일반 메시지 처리
            if (isProcessing) {
                // 처리 중이면 큐에 추가
                if (messageQueue.length < MAX_QUEUE_SIZE) {
                    messageQueue.push({ nickname, message });
                    console.log(`>> [Queue] 메시지 대기열 추가 (${messageQueue.length}/${MAX_QUEUE_SIZE})`);
                } else {
                    console.warn(">> [Queue] 대기열이 가득 차서 메시지를 버립니다.");
                }
            } else {
                // 대기 중이 아니면 즉시 처리
                isProcessing = true;
                startProcessingTimeout();

                const payload = { type: "text-input", text: `[${nickname}]: ${message}` };
                proxyWs.send(JSON.stringify(payload));
            }
        });

        chat.onDisconnect(async () => {
            console.log("치지직 연결 끊김. 재연결 시도...");
            // 토큰 갱신이 필요할 수도 있으므로 체크
            try {
                token = await getValidToken(clientId);
                setTimeout(connectChzzk, 3000);
            } catch (e) {
                console.error("재연결 중 토큰 오류:", e);
            }
        });
    }

    await connectChzzk();
}

main().catch(console.error);
