// ====== DOM 元素 ======
const relayInput = document.getElementById('relayInput');
const connectRelayButton = document.getElementById('connectRelayButton');
const privateKeyInput = document.getElementById('privateKeyInput');
const generateKeyButton = document.getElementById('generateKeyButton');
const publicKeyDisplay = document.getElementById('publicKeyDisplay');
const remotePublicKeyInput = document.getElementById('remotePublicKeyInput');
const startCallButton = document.getElementById('startCallButton');
const answerCallButton = document.getElementById('answerCallButton');
const hangupCallButton = document.getElementById('hangupCallButton');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const logDiv = document.getElementById('log');

// ====== Nostr 變數 ======
let pool;
let privateKey;
let publicKey; // npub
let hexPublicKey; // hex
let sub; // Nostr 訂閱物件
const KIND_WEBRTC_SIGNAL = 20000; // 自定義的 Nostr 事件類型，用於 WebRTC 信號

// ====== WebRTC 變數 ======
let peerConnection;
let localStream;
const configuration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ====== 輔助函數 ======
function log(message) {
    const p = document.createElement('p');
    p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logDiv.prepend(p); // Prepend to show latest on top
    console.log(message);
}

// ====== Nostr 相關函數 ======

/**
 * 產生 Nostr 金鑰對
 */
function generateNostrKeys() {
    const keys = window.NostrTools.generateSecretKey();
    privateKey = keys;
    hexPublicKey = window.NostrTools.getPublicKey(privateKey);
    publicKey = window.NostrTools.nip19.npubEncode(hexPublicKey); // 轉換為 npub 格式
    privateKeyInput.value = privateKey;
    publicKeyDisplay.textContent = publicKey;
    log('產生新的 Nostr 金鑰對。');
}

/**
 * 連接到 Nostr Relay
 */
async function connectToRelay() {
    const relayUrl = relayInput.value;
    if (!relayUrl) {
        log('請輸入 Nostr Relay 地址。');
        return;
    }

    if (!privateKey) {
        log('請先產生或輸入您的私鑰。');
        return;
    }

    try {
        log(`嘗試連接到 Relay: ${relayUrl}...`);
        pool = new window.NostrTools.SimplePool();
        log('Nostr Pool 已初始化。');

        // 訂閱我們自己的公開金鑰，以接收所有發給我們的信號
        subscribeToSignals();

        connectRelayButton.disabled = true;
        relayInput.disabled = true;
        privateKeyInput.disabled = true;
        generateKeyButton.disabled = true;

    } catch (error) {
        log(`連接 Relay 失敗: ${error.message}`);
        pool = null; // 清除 pool
        connectRelayButton.disabled = false;
        relayInput.disabled = false;
        privateKeyInput.disabled = false;
        generateKeyButton.disabled = false;
    }
}

/**
 * 訂閱發送給自己的 WebRTC 信號
 */
function subscribeToSignals() {
    if (sub) {
        sub.unsub(); // 如果已經有訂閱，先取消
    }

    // 訂閱所有發送給自己的 Nostr 事件，特別是 KIND_WEBRTC_SIGNAL
    sub = pool.sub([relayInput.value], [
        {
            kinds: [KIND_WEBRTC_SIGNAL],
            '#p': [hexPublicKey], // 篩選目標是自己的公開金鑰的事件
            since: Math.floor(Date.now() / 1000) - 300 // 獲取最近 5 分鐘的事件
        }
    ]);

    sub.on('event', event => {
        // 驗證事件簽名
        if (window.NostrTools.verifySignature(event)) {
            log(`收到來自 ${window.NostrTools.nip19.npubEncode(event.pubkey)} 的 Nostr 信號。`);
            handleNostrSignal(event);
        } else {
            log('收到無效的 Nostr 事件簽名！');
        }
    });

    sub.on('eose', () => {
        log('Nostr 訂閱完成初始同步。');
    });

    log(`已訂閱來自 Relay 的 Nostr 信號，目標為 ${publicKey}。`);
}

/**
 * 發送 Nostr 信號事件
 * @param {string} recipientHexPublicKey - 接收者的十六進位公開金鑰
 * @param {object} payload - 要發送的信號數據 (SDP 或 ICE 候選者)
 * @param {string} type - 信號類型 ('offer', 'answer', 'ice')
 */
async function sendNostrSignal(recipientHexPublicKey, payload, type) {
    if (!pool || !privateKey) {
        log('Nostr 未連接或私鑰缺失，無法發送信號。');
        return;
    }

    // 將 payload 和 type 包裝到 content 中
    const content = JSON.stringify({
        type: type,
        payload: payload
    });

    const event = {
        kind: KIND_WEBRTC_SIGNAL,
        pubkey: hexPublicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['p', recipientHexPublicKey] // 標記接收者的公開金鑰，方便篩選
        ],
        content: content,
    };

    // 簽署事件
    const signedEvent = window.NostrTools.signEvent(event, privateKey);

    log(`發送 Nostr 信號 (類型: ${type}) 給 ${window.NostrTools.nip19.npubEncode(recipientHexPublicKey)}...`);
    const pub = pool.pub([relayInput.value], signedEvent);

    pub.on('ok', () => {
        log(`Nostr 信號 (類型: ${type}) 已成功發送！`);
    });

    pub.on('failed', () => {
        log(`Nostr 信號 (類型: ${type}) 發送失敗！`);
    });
}

/**
 * 處理收到的 Nostr 信號事件
 * @param {object} event - Nostr 事件物件
 */
async function handleNostrSignal(event) {
    const senderHexPublicKey = event.pubkey;
    let signalData;
    try {
        signalData = JSON.parse(event.content);
    } catch (e) {
        log('解析 Nostr 信號內容失敗！');
        return;
    }

    const { type, payload } = signalData;

    if (!peerConnection) {
        await startWebRTC(false); // 如果還沒有 PeerConnection，就初始化它
    }

    switch (type) {
        case 'offer':
            log('收到 WebRTC offer。');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(payload));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            sendNostrSignal(senderHexPublicKey, peerConnection.localDescription, 'answer');
            break;
        case 'answer':
            log('收到 WebRTC answer。');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(payload));
            break;
        case 'ice':
            log('收到 WebRTC ICE 候選者。');
            await peerConnection.addIceCandidate(new RTCIceCandidate(payload));
            break;
        default:
            log(`未知 Nostr 信號類型: ${type}`);
            break;
    }
}

// ====== WebRTC 相關函數 ======

/**
 * 初始化本地媒體流並顯示在 localVideo
 */
async function getLocalMediaStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        log('已獲取本地媒體流。');
    } catch (e) {
        log(`獲取本地媒體流失敗: ${e.name}`);
        alert('無法訪問攝像頭或麥克風。請允許權限。');
    }
}

/**
 * 初始化 PeerConnection
 * @param {boolean} isCaller - 是否是發起通話方
 */
async function startWebRTC(isCaller) {
    if (peerConnection) {
        log('PeerConnection 已存在。');
        return;
    }

    await getLocalMediaStream();
    if (!localStream) {
        log('無法啟動 WebRTC: 無法獲取本地媒體流。');
        return;
    }

    peerConnection = new RTCPeerConnection(configuration);
    log('PeerConnection 已建立。');

    // 當找到 ICE 候選者時發送給遠端
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            log('找到 ICE 候選者，發送給遠端。');
            sendNostrSignal(remotePublicKeyInput.value, event.candidate, 'ice');
        }
    };

    // 當遠端流添加到 PeerConnection 時
    peerConnection.ontrack = (event) => {
        log('收到遠端媒體流。');
        remoteVideo.srcObject = event.streams[0];
    };

    // 添加本地媒體軌道到 PeerConnection
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    if (isCaller) {
        log('作為發起者創建 offer...');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        sendNostrSignal(remotePublicKeyInput.value, peerConnection.localDescription, 'offer');
    }

    startCallButton.disabled = true;
    answerCallButton.disabled = true;
    hangupCallButton.disabled = false;
}

/**
 * 掛斷通話
 */
function hangupCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
        log('通話已掛斷。');
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;

    startCallButton.disabled = false;
    answerCallButton.disabled = false;
    hangupCallButton.disabled = true;
}

// ====== 事件監聽器 ======
generateKeyButton.addEventListener('click', generateNostrKeys);
connectRelayButton.addEventListener('click', connectToRelay);
startCallButton.addEventListener('click', () => {
    if (!remotePublicKeyInput.value) {
        log('請輸入欲連線的公開金鑰！');
        return;
    }
    if (!pool || !privateKey) {
        log('請先連接 Nostr Relay 並確保有私鑰。');
        return;
    }
    startWebRTC(true);
});
answerCallButton.addEventListener('click', () => {
    if (!remotePublicKeyInput.value) {
        log('請輸入欲連線的公開金鑰！');
        return;
    }
    if (!pool || !privateKey) {
        log('請先連接 Nostr Relay 並確保有私鑰。');
        return;
    }
    startWebRTC(false); // 作為被呼叫方啟動
});
hangupCallButton.addEventListener('click', hangupCall);


// 頁面載入時自動產生金鑰
window.addEventListener('load', () => {
    generateNostrKeys();
    hangupCallButton.disabled = true; // 初始狀態不能掛斷
});
