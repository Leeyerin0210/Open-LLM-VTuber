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

// --- Constants ---
const OAUTH_REDIRECT_URI = 'http://localhost:8080/';
const TOKEN_FILE_PATH = './chzzk-token.json';
const PROXY_URL = 'ws://localhost:12393/proxy-ws';
const PROJECT_ROOT = path.resolve(__dirname, '../../..'); // scripts/node_chzzk_bot/src -> scripts/node_chzzk_bot -> scripts -> root
const CONFIG_PATH = path.join(PROJECT_ROOT, 'conf.yaml');

// --- Global State ---
let chzzkChatInstance: any;

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

// --- Proxy Connection ---
function connectToProxy(): WebSocket {
    const ws = new WebSocket(PROXY_URL);

    ws.on('open', () => {
        console.log(`메인 서버 '우체통'(${PROXY_URL}) 연결 성공.`);
    });

    ws.on('error', (err) => {
        console.error(`메인 서버 연결 오류: ${err.message}`);
    });

    ws.on('close', () => {
        console.log('메인 서버 연결이 끊겼습니다. 3초 후 재연결 시도...');
        setTimeout(() => connectToProxy(), 3000);
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.type === 'backend-synth-complete') {
                // console.log('[Proxy] 합성 완료 신호 수신. 재생 완료 신호를 보냅니다.'); // 너무 시끄러워서 주석 처리
                ws.send(JSON.stringify({ type: 'frontend-playback-complete' }));
            } else if (message.type === 'audio') {
                if (message.display_text) {
                    const text = message.display_text.text || message.display_text;
                    console.log(`[AI 응답] ${text}`);
                }
            } else if (message.type === 'full-text' && message.text) {
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
    let proxyWs = connectToProxy();

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

            // 프록시로 전달
            if (proxyWs.readyState === WebSocket.OPEN) {
                if (message === "!reset" || message === "!초기화") {
                    const payload = { type: "interrupt-signal" };
                    proxyWs.send(JSON.stringify(payload));
                    console.log(">> [명령] 인터럽트(초기화) 신호를 전송했습니다.");
                    return;
                }

                const payload = { type: "text-input", text: message };
                proxyWs.send(JSON.stringify(payload));
            } else {
                console.warn("프록시 서버가 연결되어 있지 않아 메시지를 전달하지 못했습니다.");
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
